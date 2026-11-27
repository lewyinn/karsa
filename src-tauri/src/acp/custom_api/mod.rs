//! Bring-Your-Own-API (3rd-party HTTP endpoint) backend for Karsa.
//!
//! Users define any API connection explicitly by providing:
//! - a custom display name,
//! - an endpoint URL,
//! - an API key (stored in the OS keychain, never persisted in plaintext JSON or logged),
//! - an explicit wire protocol (`openai`, `anthropic`, or `gemini`),
//! - one or more model IDs,
//! - optional context window size and custom HTTP headers.
//!
//! No provider auto-detection is performed: requests always go to the exact
//! endpoint URL with the exact protocol selected by the user.

pub(crate) mod driver;
pub mod protocols;
pub(crate) mod tools;

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::acp::config::AgentConfig;
use crate::acp::credentials;

/// Virtual ACP command identifier handled in-process by `custom_api::driver`.
pub const KARSA_API_COMMAND: &str = "karsa-api";

pub const ENV_ENDPOINT: &str = "KARSA_API_ENDPOINT";
pub const ENV_FORMAT: &str = "KARSA_API_FORMAT";
pub const ENV_MODELS: &str = "KARSA_API_MODELS";
pub const ENV_CONTEXT_WINDOW: &str = "KARSA_API_CONTEXT_WINDOW";
pub const ENV_HEADERS_JSON: &str = "KARSA_API_HEADERS_JSON";
pub const ENV_SYSTEM_PROMPT: &str = "KARSA_API_SYSTEM_PROMPT";

/// Default context window size when the user does not specify one.
pub const DEFAULT_CONTEXT_WINDOW: u64 = 128_000;

/// Explicit wire protocol selected by the user (never auto-detected).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ApiFormat {
    /// OpenAI-compatible Chat Completions (`/chat/completions`).
    /// Works with OpenAI, OpenRouter, DeepSeek, Groq, Ollama, LiteLLM, etc.
    Openai,
    /// Anthropic Messages API (`/v1/messages`).
    Anthropic,
    /// Google Gemini Developer API (`/models/{model}:streamGenerateContent`).
    Gemini,
}

impl ApiFormat {
    #[must_use]
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "anthropic" => Self::Anthropic,
            "gemini" => Self::Gemini,
            _ => Self::Openai,
        }
    }

    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
        }
    }
}

/// Parsed connection settings resolved from a `karsa-api` `AgentConfig`.
#[derive(Debug, Clone)]
pub struct CustomApiSpec {
    pub config_id: String,
    pub name: String,
    pub endpoint: String,
    pub format: ApiFormat,
    pub models: Vec<String>,
    pub context_window: u64,
    pub custom_headers: HashMap<String, String>,
    pub system_prompt: Option<String>,
    pub allow_terminal: bool,
}

impl CustomApiSpec {
    pub fn from_agent_config(config: &AgentConfig) -> Result<Self, String> {
        let config_id = config
            .config_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Custom API agent is missing configId".to_string())?
            .to_string();

        let endpoint = config
            .env
            .get(ENV_ENDPOINT)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "Endpoint URL is required for custom API connection".to_string())?;
        validate_endpoint_url(&endpoint)?;

        let format = config
            .env
            .get(ENV_FORMAT)
            .map(|s| ApiFormat::parse(s))
            .unwrap_or(ApiFormat::Openai);

        let models: Vec<String> = config
            .env
            .get(ENV_MODELS)
            .map(|raw| {
                raw.split([',', '\n'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(ToString::to_string)
                    .collect()
            })
            .unwrap_or_default();

        if models.is_empty() {
            return Err("At least one model ID is required for custom API connection".to_string());
        }

        let context_window = config
            .env
            .get(ENV_CONTEXT_WINDOW)
            .and_then(|s| s.trim().parse::<u64>().ok())
            .filter(|&v| v >= 1024)
            .unwrap_or(DEFAULT_CONTEXT_WINDOW);

        let custom_headers: HashMap<String, String> = config
            .env
            .get(ENV_HEADERS_JSON)
            .and_then(|raw| serde_json::from_str::<HashMap<String, String>>(raw).ok())
            .unwrap_or_default();

        let system_prompt = config
            .env
            .get(ENV_SYSTEM_PROMPT)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());

        Ok(Self {
            config_id,
            name: config.name.clone(),
            endpoint,
            format,
            models,
            context_window,
            custom_headers,
            system_prompt,
            allow_terminal: config.allow_terminal,
        })
    }
}

pub fn validate_endpoint_url(endpoint: &str) -> Result<(), String> {
    let parsed = url::Url::parse(endpoint.trim())
        .map_err(|_| "Endpoint URL must be a valid http:// or https:// URL".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        other => Err(format!(
            "Unsupported endpoint URL scheme '{other}': use http:// or https://"
        )),
    }
}

fn keyring_account(config_id: &str) -> Result<String, String> {
    let trimmed = config_id.trim();
    if trimmed.is_empty() || trimmed.len() > 128 {
        return Err("Invalid custom API connection ID".to_string());
    }
    Ok(format!("karsa-api:{trimmed}"))
}

/// Save an API key into the OS keychain under `karsa-api:<config_id>`.
/// Never logs key material.
pub fn save_api_key(config_id: &str, api_key: &str) -> Result<(), String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return delete_api_key(config_id);
    }
    let account = keyring_account(config_id)?;
    credentials::write_secret(
        &account,
        trimmed,
        "Could not save API key in OS keychain",
        "Could not verify API key in OS keychain",
    )?;
    log::info!("[custom-api] saved API key for connection {config_id}");
    Ok(())
}

/// Read the API key for `config_id` from the OS keychain.
/// Returns `Ok(None)` when no key is configured (valid for local endpoints like Ollama).
pub fn read_api_key(config_id: &str) -> Result<Option<String>, String> {
    let account = keyring_account(config_id)?;
    credentials::read_secret(&account, "OS keychain contains an empty API key")
}

/// Return whether an API key is stored for `config_id` without exposing the key.
pub fn has_api_key(config_id: &str) -> Result<bool, String> {
    Ok(read_api_key(config_id)?.is_some())
}

/// Remove the API key for `config_id` from the OS keychain (idempotent).
pub fn delete_api_key(config_id: &str) -> Result<(), String> {
    let account = keyring_account(config_id)?;
    credentials::delete_secret(&account, "Could not remove API key from OS keychain")?;
    log::info!("[custom-api] removed API key for connection {config_id}");
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestCustomApiRequest {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub config_id: Option<String>,
    pub endpoint: String,
    pub format: ApiFormat,
    pub model: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    #[serde(default)]
    pub custom_headers: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, schemars::JsonSchema)]
#[serde(rename_all = "camelCase")]
pub struct TestCustomApiResponse {
    pub ok: bool,
    pub message: String,
    pub latency_ms: u64,
}

/// Perform a tiny non-destructive connectivity check against the user's endpoint.
pub async fn test_connection(req: TestCustomApiRequest) -> Result<TestCustomApiResponse, String> {
    validate_endpoint_url(&req.endpoint)?;
    let model = req.model.trim();
    if model.is_empty() {
        return Err("Enter at least one model ID before testing".to_string());
    }

    let resolved_key = match req.api_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(inline) => Some(inline.to_string()),
        None => match req.config_id.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(id) => read_api_key(id).unwrap_or(None),
            None => None,
        },
    };

    let start = std::time::Instant::now();
    let result = protocols::probe_endpoint(
        &req.endpoint,
        req.format,
        model,
        resolved_key.as_deref(),
        &req.custom_headers,
    )
    .await;
    let latency_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(reply_preview) => {
            log::info!(
                "[custom-api] connection test ok format={} model={} latency_ms={}",
                req.format.as_str(),
                model,
                latency_ms
            );
            Ok(TestCustomApiResponse {
                ok: true,
                message: if reply_preview.is_empty() {
                    format!("Connected ({latency_ms} ms)")
                } else {
                    format!("Connected ({latency_ms} ms): {reply_preview}")
                },
                latency_ms,
            })
        }
        Err(err) => {
            log::warn!(
                "[custom-api] connection test failed format={} model={}: {}",
                req.format.as_str(),
                model,
                err
            );
            Ok(TestCustomApiResponse {
                ok: false,
                message: err,
                latency_ms,
            })
        }
    }
}
