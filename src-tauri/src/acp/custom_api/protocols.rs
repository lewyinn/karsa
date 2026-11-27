//! Streaming HTTP clients for user-configured custom API endpoints.
//!
//! Supports three explicit wire protocols without any provider auto-detection:
//! - [`ApiFormat::Openai`]    — OpenAI-compatible Chat Completions (SSE)
//! - [`ApiFormat::Anthropic`] — Anthropic Messages API (SSE)
//! - [`ApiFormat::Gemini`]    — Google Gemini Developer API (SSE)

use std::collections::{BTreeMap, HashMap};
use std::time::Duration;

use futures::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

use super::tools::ToolDefinition;
use super::ApiFormat;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(300);
const PROBE_TIMEOUT: Duration = Duration::from_secs(20);

/// Neutral multi-turn conversation message kept in memory per session.
#[derive(Debug, Clone)]
pub enum ChatMessage {
    User(String),
    Assistant {
        text: String,
        tool_calls: Vec<PendingToolCall>,
    },
    ToolResult {
        call_id: String,
        tool_name: String,
        output: String,
    },
}

#[derive(Debug, Clone)]
pub struct PendingToolCall {
    pub id: String,
    pub name: String,
    pub arguments: Value,
}

#[derive(Debug, Clone, Default)]
pub struct TurnUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
}

#[derive(Debug, Clone)]
pub enum StreamDelta {
    Text(String),
    Thought(String),
}

#[derive(Debug, Clone)]
pub struct StreamTurnResult {
    pub text: String,
    pub tool_calls: Vec<PendingToolCall>,
    pub usage: TurnUsage,
    pub cancelled: bool,
}

fn build_client(timeout: Duration) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .connect_timeout(CONNECT_TIMEOUT)
        .timeout(timeout)
        .build()
        .map_err(|e| format!("Failed to initialize HTTP client: {e}"))
}

fn apply_custom_headers(
    headers: &mut HeaderMap,
    custom: &HashMap<String, String>,
) -> Result<(), String> {
    for (k, v) in custom {
        let key = k.trim();
        if key.is_empty() {
            continue;
        }
        let name = HeaderName::from_bytes(key.as_bytes())
            .map_err(|_| format!("Invalid custom header name '{key}'"))?;
        let val = HeaderValue::from_str(v.trim())
            .map_err(|_| format!("Invalid custom header value for '{key}'"))?;
        headers.insert(name, val);
    }
    Ok(())
}

pub fn resolve_openai_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.ends_with("/chat/completions") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/chat/completions")
    }
}

pub fn resolve_anthropic_url(endpoint: &str) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.ends_with("/messages") {
        trimmed.to_string()
    } else if trimmed.ends_with("/v1") {
        format!("{trimmed}/messages")
    } else {
        format!("{trimmed}/v1/messages")
    }
}

pub fn resolve_gemini_url(endpoint: &str, model: &str, streaming: bool) -> String {
    let trimmed = endpoint.trim().trim_end_matches('/');
    if trimmed.contains(":streamGenerateContent") || trimmed.contains(":generateContent") {
        if streaming && !trimmed.contains("alt=sse") {
            let sep = if trimmed.contains('?') { '&' } else { '?' };
            return format!("{trimmed}{sep}alt=sse");
        }
        return trimmed.to_string();
    }
    let clean_model = model.trim().trim_start_matches("models/");
    if streaming {
        format!("{trimmed}/models/{clean_model}:streamGenerateContent?alt=sse")
    } else {
        format!("{trimmed}/models/{clean_model}:generateContent")
    }
}

fn summarize_http_error(status: reqwest::StatusCode, body: &str) -> String {
    if let Ok(parsed) = serde_json::from_str::<Value>(body) {
        if let Some(msg) = parsed
            .pointer("/error/message")
            .or_else(|| parsed.get("message"))
            .or_else(|| parsed.get("detail"))
            .and_then(Value::as_str)
        {
            let clean: String = msg.trim().chars().take(320).collect();
            return format!("HTTP {} — {}", status.as_u16(), clean);
        }
    }
    let clean: String = body.trim().chars().take(240).collect();
    if clean.is_empty() {
        format!("HTTP {} {}", status.as_u16(), status.canonical_reason().unwrap_or("Error"))
    } else {
        format!("HTTP {} — {}", status.as_u16(), clean)
    }
}

/// Quick connectivity probe used by the "Test Connection" button.
pub async fn probe_endpoint(
    endpoint: &str,
    format: ApiFormat,
    model: &str,
    api_key: Option<&str>,
    custom_headers: &HashMap<String, String>,
) -> Result<String, String> {
    let client = build_client(PROBE_TIMEOUT)?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));

    let (url, body) = match format {
        ApiFormat::Openai => {
            if let Some(key) = api_key {
                let val = HeaderValue::from_str(&format!("Bearer {key}"))
                    .map_err(|_| "API key contains invalid HTTP header characters".to_string())?;
                headers.insert(reqwest::header::AUTHORIZATION, val);
            }
            (
                resolve_openai_url(endpoint),
                json!({
                    "model": model,
                    "messages": [{ "role": "user", "content": "Reply with OK" }],
                    "max_tokens": 8,
                    "stream": false
                }),
            )
        }
        ApiFormat::Anthropic => {
            if let Some(key) = api_key {
                let val = HeaderValue::from_str(key)
                    .map_err(|_| "API key contains invalid HTTP header characters".to_string())?;
                headers.insert(HeaderName::from_static("x-api-key"), val);
            }
            headers.insert(
                HeaderName::from_static("anthropic-version"),
                HeaderValue::from_static("2023-06-01"),
            );
            (
                resolve_anthropic_url(endpoint),
                json!({
                    "model": model,
                    "max_tokens": 16,
                    "messages": [{ "role": "user", "content": "Reply with OK" }]
                }),
            )
        }
        ApiFormat::Gemini => {
            if let Some(key) = api_key {
                let val = HeaderValue::from_str(key)
                    .map_err(|_| "API key contains invalid HTTP header characters".to_string())?;
                headers.insert(HeaderName::from_static("x-goog-api-key"), val);
            }
            (
                resolve_gemini_url(endpoint, model, false),
                json!({
                    "contents": [{ "role": "user", "parts": [{ "text": "Reply with OK" }] }],
                    "generationConfig": { "maxOutputTokens": 16 }
                }),
            )
        }
    };

    apply_custom_headers(&mut headers, custom_headers)?;

    let resp = client
        .post(&url)
        .headers(headers)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Connection failed: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(summarize_http_error(status, &text));
    }

    let preview = serde_json::from_str::<Value>(&text)
        .ok()
        .and_then(|v| match format {
            ApiFormat::Openai => v
                .pointer("/choices/0/message/content")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            ApiFormat::Anthropic => v
                .pointer("/content/0/text")
                .and_then(Value::as_str)
                .map(ToString::to_string),
            ApiFormat::Gemini => v
                .pointer("/candidates/0/content/parts/0/text")
                .and_then(Value::as_str)
                .map(ToString::to_string),
        })
        .unwrap_or_default()
        .trim()
        .chars()
        .take(60)
        .collect();

    Ok(preview)
}

/// Stream one LLM completion turn for the selected protocol.
#[allow(clippy::too_many_arguments)]
pub async fn stream_turn<F>(
    endpoint: &str,
    format: ApiFormat,
    model: &str,
    api_key: Option<&str>,
    custom_headers: &HashMap<String, String>,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    cancel: CancellationToken,
    mut on_delta: F,
) -> Result<StreamTurnResult, String>
where
    F: FnMut(StreamDelta),
{
    match format {
        ApiFormat::Openai => {
            stream_openai(
                endpoint,
                model,
                api_key,
                custom_headers,
                system_prompt,
                messages,
                tools,
                cancel,
                &mut on_delta,
            )
            .await
        }
        ApiFormat::Anthropic => {
            stream_anthropic(
                endpoint,
                model,
                api_key,
                custom_headers,
                system_prompt,
                messages,
                tools,
                cancel,
                &mut on_delta,
            )
            .await
        }
        ApiFormat::Gemini => {
            stream_gemini(
                endpoint,
                model,
                api_key,
                custom_headers,
                system_prompt,
                messages,
                tools,
                cancel,
                &mut on_delta,
            )
            .await
        }
    }
}

/// Consume an SSE response byte stream and invoke `on_data` for each `data:` payload.
async fn read_sse_stream<F>(
    resp: reqwest::Response,
    cancel: CancellationToken,
    mut on_data: F,
) -> Result<bool, String>
where
    F: FnMut(&str),
{
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut data_lines: Vec<String> = Vec::new();

    loop {
        let next_chunk = tokio::select! {
            biased;
            () = cancel.cancelled() => return Ok(true),
            chunk = stream.next() => chunk,
        };

        let Some(chunk) = next_chunk else {
            break;
        };
        let bytes = chunk.map_err(|e| format!("Stream read error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&bytes));

        while let Some(newline_idx) = buf.find('\n') {
            let line = buf[..newline_idx].trim_end_matches('\r').to_string();
            buf.drain(..=newline_idx);

            if line.is_empty() {
                if !data_lines.is_empty() {
                    let payload = data_lines.join("\n");
                    data_lines.clear();
                    if payload.trim() == "[DONE]" {
                        return Ok(false);
                    }
                    on_data(&payload);
                }
            } else if let Some(rest) = line.strip_prefix("data:") {
                data_lines.push(rest.trim_start().to_string());
            }
        }
    }

    if !data_lines.is_empty() {
        let payload = data_lines.join("\n");
        if payload.trim() != "[DONE]" {
            on_data(&payload);
        }
    }

    Ok(false)
}

#[allow(clippy::too_many_arguments)]
async fn stream_openai<F>(
    endpoint: &str,
    model: &str,
    api_key: Option<&str>,
    custom_headers: &HashMap<String, String>,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    cancel: CancellationToken,
    on_delta: &mut F,
) -> Result<StreamTurnResult, String>
where
    F: FnMut(StreamDelta),
{
    let client = build_client(REQUEST_TIMEOUT)?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(key) = api_key {
        let val = HeaderValue::from_str(&format!("Bearer {key}"))
            .map_err(|_| "API key contains invalid HTTP header characters".to_string())?;
        headers.insert(reqwest::header::AUTHORIZATION, val);
    }
    apply_custom_headers(&mut headers, custom_headers)?;

    let mut wire_messages = Vec::with_capacity(messages.len() + 1);
    if !system_prompt.is_empty() {
        wire_messages.push(json!({ "role": "system", "content": system_prompt }));
    }
    for msg in messages {
        match msg {
            ChatMessage::User(text) => {
                wire_messages.push(json!({ "role": "user", "content": text }));
            }
            ChatMessage::Assistant { text, tool_calls } => {
                if tool_calls.is_empty() {
                    wire_messages.push(json!({ "role": "assistant", "content": text }));
                } else {
                    let tc_json: Vec<Value> = tool_calls
                        .iter()
                        .map(|tc| {
                            json!({
                                "id": tc.id,
                                "type": "function",
                                "function": {
                                    "name": tc.name,
                                    "arguments": serde_json::to_string(&tc.arguments).unwrap_or_else(|_| "{}".to_string())
                                }
                            })
                        })
                        .collect();
                    wire_messages.push(json!({
                        "role": "assistant",
                        "content": if text.is_empty() { Value::Null } else { json!(text) },
                        "tool_calls": tc_json
                    }));
                }
            }
            ChatMessage::ToolResult {
                call_id, output, ..
            } => {
                wire_messages.push(json!({
                    "role": "tool",
                    "tool_call_id": call_id,
                    "content": output
                }));
            }
        }
    }

    let mut body = json!({
        "model": model,
        "messages": wire_messages,
        "stream": true,
        "stream_options": { "include_usage": true }
    });

    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "type": "function",
                    "function": {
                        "name": t.name,
                        "description": t.description,
                        "parameters": t.parameters
                    }
                })
            })
            .collect();
        body["tools"] = Value::Array(tool_defs);
    }

    let url = resolve_openai_url(endpoint);
    let resp = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            return Ok(StreamTurnResult {
                text: String::new(),
                tool_calls: vec![],
                usage: TurnUsage::default(),
                cancelled: true,
            });
        }
        r = client.post(&url).headers(headers).json(&body).send() => {
            r.map_err(|e| format!("Request failed: {e}"))?
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(summarize_http_error(status, &err_body));
    }

    let mut full_text = String::new();
    let mut usage = TurnUsage::default();
    let mut tool_acc: BTreeMap<usize, (String, String, String)> = BTreeMap::new();

    let cancelled = read_sse_stream(resp, cancel, |payload| {
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        if let Some(u) = v.get("usage") {
            if let Some(p) = u.get("prompt_tokens").and_then(Value::as_u64) {
                usage.input_tokens = p;
            }
            if let Some(c) = u.get("completion_tokens").and_then(Value::as_u64) {
                usage.output_tokens = c;
            }
        }
        if let Some(delta) = v.pointer("/choices/0/delta") {
            if let Some(reasoning) = delta
                .get("reasoning_content")
                .or_else(|| delta.get("reasoning"))
                .and_then(Value::as_str)
            {
                if !reasoning.is_empty() {
                    on_delta(StreamDelta::Thought(reasoning.to_string()));
                }
            }
            if let Some(content) = delta.get("content").and_then(Value::as_str) {
                if !content.is_empty() {
                    full_text.push_str(content);
                    on_delta(StreamDelta::Text(content.to_string()));
                }
            }
            if let Some(calls) = delta.get("tool_calls").and_then(Value::as_array) {
                for call in calls {
                    let idx = call.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                    let entry = tool_acc.entry(idx).or_insert_with(|| {
                        (format!("call_{idx}"), String::new(), String::new())
                    });
                    if let Some(id) = call.get("id").and_then(Value::as_str) {
                        if !id.is_empty() {
                            entry.0 = id.to_string();
                        }
                    }
                    if let Some(name) = call.pointer("/function/name").and_then(Value::as_str) {
                        entry.1.push_str(name);
                    }
                    if let Some(args) = call.pointer("/function/arguments").and_then(Value::as_str)
                    {
                        entry.2.push_str(args);
                    }
                }
            }
        }
    })
    .await?;

    let tool_calls = tool_acc
        .into_values()
        .filter(|(_, name, _)| !name.is_empty())
        .map(|(id, name, args_str)| PendingToolCall {
            id,
            name,
            arguments: serde_json::from_str(&args_str).unwrap_or_else(|_| json!({})),
        })
        .collect();

    Ok(StreamTurnResult {
        text: full_text,
        tool_calls,
        usage,
        cancelled,
    })
}

#[allow(clippy::too_many_arguments)]
async fn stream_anthropic<F>(
    endpoint: &str,
    model: &str,
    api_key: Option<&str>,
    custom_headers: &HashMap<String, String>,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    cancel: CancellationToken,
    on_delta: &mut F,
) -> Result<StreamTurnResult, String>
where
    F: FnMut(StreamDelta),
{
    let client = build_client(REQUEST_TIMEOUT)?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(key) = api_key {
        let val = HeaderValue::from_str(key)
            .map_err(|_| "API key contains invalid HTTP header characters".to_string())?;
        headers.insert(HeaderName::from_static("x-api-key"), val);
    }
    headers.insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static("2023-06-01"),
    );
    apply_custom_headers(&mut headers, custom_headers)?;

    let mut wire_messages: Vec<Value> = Vec::new();
    let mut pending_tool_results: Vec<Value> = Vec::new();

    let flush_tool_results =
        |wire_messages: &mut Vec<Value>, pending_tool_results: &mut Vec<Value>| {
            if !pending_tool_results.is_empty() {
                let items = std::mem::take(pending_tool_results);
                wire_messages.push(json!({ "role": "user", "content": items }));
            }
        };

    for msg in messages {
        match msg {
            ChatMessage::User(text) => {
                flush_tool_results(&mut wire_messages, &mut pending_tool_results);
                wire_messages.push(json!({ "role": "user", "content": text }));
            }
            ChatMessage::Assistant { text, tool_calls } => {
                flush_tool_results(&mut wire_messages, &mut pending_tool_results);
                let mut blocks: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    blocks.push(json!({ "type": "text", "text": text }));
                }
                for tc in tool_calls {
                    blocks.push(json!({
                        "type": "tool_use",
                        "id": tc.id,
                        "name": tc.name,
                        "input": tc.arguments
                    }));
                }
                if blocks.is_empty() {
                    blocks.push(json!({ "type": "text", "text": "" }));
                }
                wire_messages.push(json!({ "role": "assistant", "content": blocks }));
            }
            ChatMessage::ToolResult {
                call_id, output, ..
            } => {
                pending_tool_results.push(json!({
                    "type": "tool_result",
                    "tool_use_id": call_id,
                    "content": output
                }));
            }
        }
    }
    flush_tool_results(&mut wire_messages, &mut pending_tool_results);

    let mut body = json!({
        "model": model,
        "max_tokens": 8192,
        "stream": true,
        "messages": wire_messages
    });
    if !system_prompt.is_empty() {
        body["system"] = json!(system_prompt);
    }
    if !tools.is_empty() {
        let tool_defs: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "input_schema": t.parameters
                })
            })
            .collect();
        body["tools"] = Value::Array(tool_defs);
    }

    let url = resolve_anthropic_url(endpoint);
    let resp = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            return Ok(StreamTurnResult {
                text: String::new(),
                tool_calls: vec![],
                usage: TurnUsage::default(),
                cancelled: true,
            });
        }
        r = client.post(&url).headers(headers).json(&body).send() => {
            r.map_err(|e| format!("Request failed: {e}"))?
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(summarize_http_error(status, &err_body));
    }

    let mut full_text = String::new();
    let mut usage = TurnUsage::default();
    let mut tool_acc: BTreeMap<usize, (String, String, String)> = BTreeMap::new();

    let cancelled = read_sse_stream(resp, cancel, |payload| {
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        let event_type = v.get("type").and_then(Value::as_str).unwrap_or("");
        match event_type {
            "message_start" => {
                if let Some(u) = v.pointer("/message/usage") {
                    let input = u.get("input_tokens").and_then(Value::as_u64).unwrap_or(0);
                    let cache_read = u
                        .get("cache_read_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    let cache_create = u
                        .get("cache_creation_input_tokens")
                        .and_then(Value::as_u64)
                        .unwrap_or(0);
                    usage.input_tokens = input + cache_read + cache_create;
                }
            }
            "message_delta" => {
                if let Some(out) = v.pointer("/usage/output_tokens").and_then(Value::as_u64) {
                    usage.output_tokens = out;
                }
            }
            "content_block_start" => {
                let idx = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                if v.pointer("/content_block/type").and_then(Value::as_str) == Some("tool_use") {
                    let id = v
                        .pointer("/content_block/id")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let name = v
                        .pointer("/content_block/name")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    tool_acc.insert(idx, (id, name, String::new()));
                }
            }
            "content_block_delta" => {
                let idx = v.get("index").and_then(Value::as_u64).unwrap_or(0) as usize;
                let delta_type = v.pointer("/delta/type").and_then(Value::as_str).unwrap_or("");
                match delta_type {
                    "text_delta" => {
                        if let Some(text) = v.pointer("/delta/text").and_then(Value::as_str) {
                            if !text.is_empty() {
                                full_text.push_str(text);
                                on_delta(StreamDelta::Text(text.to_string()));
                            }
                        }
                    }
                    "thinking_delta" => {
                        if let Some(thought) = v.pointer("/delta/thinking").and_then(Value::as_str)
                        {
                            if !thought.is_empty() {
                                on_delta(StreamDelta::Thought(thought.to_string()));
                            }
                        }
                    }
                    "input_json_delta" => {
                        if let Some(part) = v.pointer("/delta/partial_json").and_then(Value::as_str)
                        {
                            if let Some(entry) = tool_acc.get_mut(&idx) {
                                entry.2.push_str(part);
                            }
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    })
    .await?;

    let tool_calls = tool_acc
        .into_values()
        .filter(|(_, name, _)| !name.is_empty())
        .map(|(id, name, args_str)| PendingToolCall {
            id,
            name,
            arguments: serde_json::from_str(&args_str).unwrap_or_else(|_| json!({})),
        })
        .collect();

    Ok(StreamTurnResult {
        text: full_text,
        tool_calls,
        usage,
        cancelled,
    })
}

#[allow(clippy::too_many_arguments)]
async fn stream_gemini<F>(
    endpoint: &str,
    model: &str,
    api_key: Option<&str>,
    custom_headers: &HashMap<String, String>,
    system_prompt: &str,
    messages: &[ChatMessage],
    tools: &[ToolDefinition],
    cancel: CancellationToken,
    on_delta: &mut F,
) -> Result<StreamTurnResult, String>
where
    F: FnMut(StreamDelta),
{
    let client = build_client(REQUEST_TIMEOUT)?;
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    if let Some(key) = api_key {
        let val = HeaderValue::from_str(key)
            .map_err(|_| "API key contains invalid HTTP header characters".to_string())?;
        headers.insert(HeaderName::from_static("x-goog-api-key"), val);
    }
    apply_custom_headers(&mut headers, custom_headers)?;

    let mut contents: Vec<Value> = Vec::new();
    for msg in messages {
        match msg {
            ChatMessage::User(text) => {
                contents.push(json!({ "role": "user", "parts": [{ "text": text }] }));
            }
            ChatMessage::Assistant { text, tool_calls } => {
                let mut parts: Vec<Value> = Vec::new();
                if !text.is_empty() {
                    parts.push(json!({ "text": text }));
                }
                for tc in tool_calls {
                    parts.push(json!({
                        "functionCall": {
                            "name": tc.name,
                            "args": tc.arguments
                        }
                    }));
                }
                if !parts.is_empty() {
                    contents.push(json!({ "role": "model", "parts": parts }));
                }
            }
            ChatMessage::ToolResult {
                tool_name, output, ..
            } => {
                contents.push(json!({
                    "role": "user",
                    "parts": [{
                        "functionResponse": {
                            "name": tool_name,
                            "response": { "output": output }
                        }
                    }]
                }));
            }
        }
    }

    let mut body = json!({ "contents": contents });
    if !system_prompt.is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system_prompt }] });
    }
    if !tools.is_empty() {
        let decls: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters
                })
            })
            .collect();
        body["tools"] = json!([{ "functionDeclarations": decls }]);
    }

    let url = resolve_gemini_url(endpoint, model, true);
    let resp = tokio::select! {
        biased;
        () = cancel.cancelled() => {
            return Ok(StreamTurnResult {
                text: String::new(),
                tool_calls: vec![],
                usage: TurnUsage::default(),
                cancelled: true,
            });
        }
        r = client.post(&url).headers(headers).json(&body).send() => {
            r.map_err(|e| format!("Request failed: {e}"))?
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(summarize_http_error(status, &err_body));
    }

    let mut full_text = String::new();
    let mut usage = TurnUsage::default();
    let mut tool_calls: Vec<PendingToolCall> = Vec::new();

    let cancelled = read_sse_stream(resp, cancel, |payload| {
        let Ok(v) = serde_json::from_str::<Value>(payload) else {
            return;
        };
        if let Some(u) = v.get("usageMetadata") {
            if let Some(p) = u.get("promptTokenCount").and_then(Value::as_u64) {
                usage.input_tokens = p;
            }
            if let Some(c) = u.get("candidatesTokenCount").and_then(Value::as_u64) {
                usage.output_tokens = c;
            }
        }
        if let Some(parts) = v.pointer("/candidates/0/content/parts").and_then(Value::as_array) {
            for part in parts {
                if let Some(text) = part.get("text").and_then(Value::as_str) {
                    if !text.is_empty() {
                        if part.get("thought").and_then(Value::as_bool) == Some(true) {
                            on_delta(StreamDelta::Thought(text.to_string()));
                        } else {
                            full_text.push_str(text);
                            on_delta(StreamDelta::Text(text.to_string()));
                        }
                    }
                }
                if let Some(fc) = part.get("functionCall") {
                    if let Some(name) = fc.get("name").and_then(Value::as_str) {
                        let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                        tool_calls.push(PendingToolCall {
                            id: format!("gemini-call-{}", tool_calls.len() + 1),
                            name: name.to_string(),
                            arguments: args,
                        });
                    }
                }
            }
        }
    })
    .await?;

    Ok(StreamTurnResult {
        text: full_text,
        tool_calls,
        usage,
        cancelled,
    })
}
