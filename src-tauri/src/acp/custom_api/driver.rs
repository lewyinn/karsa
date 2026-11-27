//! In-process ACP driver for `karsa-api` custom HTTP API connections.
//!
//! Runs inside `manager::driver::run_agent` on the same `AcpCommand` channel
//! and `EventSink` fan-out as external ACP subprocesses, giving every custom
//! HTTP endpoint native Karsa streaming, model switching, context usage,
//! `/clear` + `/compact`, session persistence, and desktop/web parity.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use agent_client_protocol::schema::v1::{
    AgentCapabilities, AvailableCommand, AvailableCommandsUpdate, ContentBlock,
    ListSessionsResponse, SessionCapabilities, SessionCloseCapabilities, SessionNotification,
    SessionResumeCapabilities, SessionUpdate, StopReason, TextContent, ToolCall, ToolCallContent,
    ToolCallLocation, ToolCallStatus, ToolCallUpdate, ToolCallUpdateFields,
};
use parking_lot::Mutex;
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::acp::client;
use crate::acp::config::{AgentConfig, AgentId, SessionId};
use crate::acp::events::{
    self, ChunkRole, MessageChunkEvent, SessionModel, SessionModelState, UsageUpdateEvent,
    EVENT_MESSAGE_CHUNK, EVENT_USAGE_UPDATE,
};
use crate::acp::manager::reopen::SessionReopenOutcome;
use crate::acp::manager::turn::emit_turn_outcome;
use crate::acp::manager::{AcpCommand, InitOutcome, NewSessionOutcome};
use crate::acp::session::DriverState;
use crate::acp::session_persistence::{
    snapshot_from_model_state, SessionPersistence, SessionRegistration,
};
use crate::web::EventSink;

use super::protocols::{self, ChatMessage, StreamDelta};
use super::tools;
use super::{read_api_key, CustomApiSpec};

const MAX_TOOL_ROUNDS: usize = 8;

struct ApiSessionState {
    cwd: PathBuf,
    additional_directories: Vec<PathBuf>,
    model: String,
    messages: Vec<ChatMessage>,
    last_used_tokens: u64,
}

fn build_model_state(spec: &CustomApiSpec, current: &str) -> SessionModelState {
    let available: Vec<SessionModel> = spec
        .models
        .iter()
        .map(|m| SessionModel {
            model_id: m.clone(),
            name: m.clone(),
            description: None,
        })
        .collect();
    SessionModelState {
        current_model_id: current.to_string(),
        available_models: available,
    }
}

fn build_capabilities() -> AgentCapabilities {
    let session_caps = SessionCapabilities::new()
        .resume(SessionResumeCapabilities::new())
        .close(SessionCloseCapabilities::new());
    AgentCapabilities::new()
        .load_session(true)
        .session_capabilities(session_caps)
}

fn emit_available_commands(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
) {
    let commands = vec![
        AvailableCommand::new("clear", "Reset conversation context and start fresh"),
        AvailableCommand::new("compact", "Summarize conversation to reduce context usage"),
    ];
    let notif = SessionNotification::new(
        agent_client_protocol::schema::v1::SessionId::new(session_id.0.as_str()),
        SessionUpdate::AvailableCommandsUpdate(AvailableCommandsUpdate::new(commands)),
    );
    client::emit_session_update(sinks, agent_id, notif);
}

fn emit_chunk(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
    role: ChunkRole,
    text: String,
) {
    let event = MessageChunkEvent {
        agent_id: agent_id.clone(),
        session_id: session_id.clone(),
        role,
        content: ContentBlock::Text(TextContent::new(text)),
        message_id: None,
        parent_tool_call_id: None,
    };
    events::fan_out(
        sinks,
        Some(session_id.0.as_str()),
        EVENT_MESSAGE_CHUNK,
        &event,
    );
}

fn emit_usage(
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
    used: u64,
    size: u64,
) {
    let event = UsageUpdateEvent {
        agent_id: agent_id.clone(),
        session_id: session_id.clone(),
        used,
        size,
        cost: None,
        rate_limit: None,
        limit_reached: None,
    };
    events::fan_out(
        sinks,
        Some(session_id.0.as_str()),
        EVENT_USAGE_UPDATE,
        &event,
    );
}

fn extract_prompt_text(blocks: &[ContentBlock]) -> String {
    let mut parts = Vec::new();
    for block in blocks {
        match block {
            ContentBlock::Text(t) => {
                if !t.text.is_empty() {
                    parts.push(t.text.clone());
                }
            }
            ContentBlock::ResourceLink(link) => {
                parts.push(format!("[Resource: {} ({})]", link.name, link.uri));
            }
            ContentBlock::Resource(res) => match &res.resource {
                agent_client_protocol::schema::v1::EmbeddedResourceResource::TextResourceContents(
                    text,
                ) => {
                    parts.push(format!("File `{}`:\n{}", text.uri, text.text));
                }
                _ => {}
            },
            _ => {}
        }
    }
    parts.join("\n\n")
}

fn estimate_tokens(messages: &[ChatMessage], system_prompt: &str) -> u64 {
    let mut chars = system_prompt.len();
    for m in messages {
        match m {
            ChatMessage::User(t) => chars += t.len(),
            ChatMessage::Assistant { text, tool_calls } => {
                chars += text.len();
                for tc in tool_calls {
                    chars += tc.name.len() + tc.arguments.to_string().len();
                }
            }
            ChatMessage::ToolResult { output, .. } => chars += output.len(),
        }
    }
    ((chars as u64) / 4).max(1)
}

fn build_system_prompt(spec: &CustomApiSpec, cwd: &std::path::Path) -> String {
    let mut base = spec.system_prompt.clone().unwrap_or_else(|| {
        "You are a helpful AI coding assistant running inside Karsa.".to_string()
    });
    base.push_str(&format!(
        "\n\nActive workspace directory: {}",
        cwd.display()
    ));
    base
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn drive_api_connection(
    config: AgentConfig,
    sinks: Vec<Arc<dyn EventSink>>,
    agent_id: AgentId,
    mut command_rx: mpsc::UnboundedReceiver<AcpCommand>,
    init_tx: oneshot::Sender<Result<InitOutcome, String>>,
    spawned: Arc<AtomicBool>,
    driver_state: Arc<Mutex<DriverState>>,
    persistence: Option<Arc<SessionPersistence>>,
) -> Result<(), events::AcpErrorDetail> {
    let spec = match CustomApiSpec::from_agent_config(&config) {
        Ok(s) => Arc::new(s),
        Err(err) => {
            let _ = init_tx.send(Err(err.clone()));
            return Err(api_err(err));
        }
    };

    log::info!(
        "[custom-api] initialized agent {} name='{}' format={} models={}",
        agent_id,
        spec.name,
        spec.format.as_str(),
        spec.models.len()
    );

    spawned.store(true, Ordering::Release);
    let _ = init_tx.send(Ok(InitOutcome {
        capabilities: build_capabilities(),
        auth_methods: Vec::new(),
    }));

    let sessions: Arc<Mutex<HashMap<String, ApiSessionState>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let cancels: Arc<Mutex<HashMap<String, CancellationToken>>> =
        Arc::new(Mutex::new(HashMap::new()));

    while let Some(cmd) = command_rx.recv().await {
        match cmd {
            AcpCommand::Shutdown => {
                let active: Vec<CancellationToken> =
                    cancels.lock().drain().map(|(_, tok)| tok).collect();
                for tok in active {
                    tok.cancel();
                }
                break;
            }
            AcpCommand::NewSession {
                cwd,
                stable_agent_namespace,
                runtime_agent_id,
                project_id,
                ephemeral,
                worktree_path,
                worktree_branch,
                additional_directories,
                command_id,
                quick_chat_id,
                started_by,
                reply,
                ..
            } => {
                let session_id = SessionId::new(format!("karsa-api-{}", uuid::Uuid::new_v4()));
                let default_model = spec.models[0].clone();
                let model_state = build_model_state(&spec, &default_model);

                let registration = SessionRegistration {
                    session_id: session_id.0.clone(),
                    stable_agent_namespace,
                    runtime_agent_id: Some(runtime_agent_id),
                    project_id,
                    cwd: PathBuf::from(&cwd),
                    worktree_path,
                    worktree_branch,
                    worktree_created: false,
                    command_id,
                    started_by,
                    model: Some(snapshot_from_model_state(&model_state)),
                };

                if !ephemeral {
                    if let Some(p) = &persistence {
                        let res = match quick_chat_id {
                            Some(chat_id) => {
                                p.register_quick_session(registration.clone(), chat_id)
                                    .await
                            }
                            None => p.register_session(registration.clone()).await,
                        };
                        if let Err(err) = res {
                            let _ = reply.send(Err(format!("failed to persist new session: {err}")));
                            continue;
                        }
                        for sink in &sinks {
                            sink.note_session_registered(&session_id.0);
                        }
                    }
                }

                {
                    let mut state = driver_state.lock();
                    state.set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                    if ephemeral {
                        state.mark_ephemeral(session_id.0.clone());
                        state.note_promotable_registration(session_id.0.clone(), registration);
                    }
                }

                sessions.lock().insert(
                    session_id.0.clone(),
                    ApiSessionState {
                        cwd: PathBuf::from(&cwd),
                        additional_directories,
                        model: default_model,
                        messages: Vec::new(),
                        last_used_tokens: 0,
                    },
                );

                emit_available_commands(&sinks, &agent_id, &session_id);

                let _ = reply.send(Ok(NewSessionOutcome {
                    session_id,
                    modes: None,
                    models: Some(model_state),
                    config_options: None,
                    cwd: Some(cwd),
                    antigravity_tier: None,
                }));
            }
            AcpCommand::LoadSession {
                session_id,
                cwd,
                additional_directories,
                reply,
                ..
            }
            | AcpCommand::ResumeSession {
                session_id,
                cwd,
                additional_directories,
                reply,
                ..
            } => {
                let model = {
                    let mut map = sessions.lock();
                    let entry = map
                        .entry(session_id.0.clone())
                        .or_insert_with(|| ApiSessionState {
                            cwd: PathBuf::from(&cwd),
                            additional_directories: additional_directories.clone(),
                            model: spec.models[0].clone(),
                            messages: Vec::new(),
                            last_used_tokens: 0,
                        });
                    entry.cwd = PathBuf::from(&cwd);
                    entry.additional_directories = additional_directories;
                    entry.model.clone()
                };

                driver_state
                    .lock()
                    .set_session_root(session_id.0.clone(), PathBuf::from(&cwd));
                emit_available_commands(&sinks, &agent_id, &session_id);

                let _ = reply.send(Ok(SessionReopenOutcome {
                    modes: None,
                    models: Some(build_model_state(&spec, &model)),
                    config_options: None,
                    answered_by_host: false,
                }));
            }
            AcpCommand::CloseSession { session_id, reply }
            | AcpCommand::DeleteSession { session_id, reply }
            | AcpCommand::DisposeEphemeralSession { session_id, reply } => {
                if let Some(tok) = cancels.lock().remove(&session_id.0) {
                    tok.cancel();
                }
                sessions.lock().remove(&session_id.0);
                driver_state.lock().remove_session_root(&session_id.0);
                let _ = reply.send(Ok(()));
            }
            AcpCommand::ListSessions { reply, .. } => {
                let _ = reply.send(Ok(ListSessionsResponse::new(Vec::new())));
            }
            AcpCommand::SetModel {
                session_id,
                model_id,
                reply,
            } => {
                if let Some(sess) = sessions.lock().get_mut(&session_id.0) {
                    sess.model = model_id;
                    let _ = reply.send(Ok(()));
                } else {
                    let _ = reply.send(Err("Session not found".to_string()));
                }
            }
            AcpCommand::SetMode { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            AcpCommand::SetConfigOption { reply, .. } => {
                let _ = reply.send(Ok(None));
            }
            AcpCommand::SendPrompt {
                session_id,
                content,
                turn_id,
                on_accept,
                accepted,
                reply,
            } => {
                if !sessions.lock().contains_key(&session_id.0) {
                    let msg = "Custom API session is not open".to_string();
                    let _ = accepted.send(Err(msg.clone()));
                    let _ = reply.send(Err(msg));
                    continue;
                }

                if driver_state.lock().try_begin_turn(&session_id.0).is_none() {
                    let msg = "Another prompt turn is already active on this session".to_string();
                    let _ = accepted.send(Err(msg.clone()));
                    let _ = reply.send(Err(msg));
                    continue;
                }
                driver_state
                    .lock()
                    .set_active_turn_id(&session_id.0, turn_id.clone());

                if let Some(hook) = on_accept {
                    hook();
                }
                let _ = accepted.send(Ok(()));

                let cancel = CancellationToken::new();
                cancels.lock().insert(session_id.0.clone(), cancel.clone());

                let task_spec = spec.clone();
                let task_sinks = sinks.clone();
                let task_agent_id = agent_id.clone();
                let task_sessions = sessions.clone();
                let task_cancels = cancels.clone();
                let task_state = driver_state.clone();
                let prompt_text = extract_prompt_text(&content);

                tokio::task::spawn_local(async move {
                    let outcome = run_prompt_turn(
                        &task_spec,
                        &task_sinks,
                        &task_agent_id,
                        &session_id,
                        prompt_text,
                        &task_sessions,
                        cancel,
                    )
                    .await;

                    task_cancels.lock().remove(&session_id.0);
                    let had_active = {
                        let mut st = task_state.lock();
                        let was_active = st.is_turn_active(&session_id.0);
                        let _ = st.finish_turn(&session_id.0);
                        was_active
                    };
                    if had_active {
                        emit_turn_outcome(
                            &task_sinks,
                            &task_agent_id,
                            &session_id,
                            turn_id,
                            &outcome,
                        );
                    }
                    let _ = reply.send(outcome.map_err(|e| e.message));
                });
            }
            AcpCommand::CancelPrompt { session_id, reply } => {
                if let Some(tok) = cancels.lock().get(&session_id.0) {
                    tok.cancel();
                }
                let _ = reply.send(Ok(()));
            }
            AcpCommand::SessionIds { reply } => {
                let ids = driver_state.lock().active_session_ids();
                let _ = reply.send(Ok(ids));
            }
            AcpCommand::WorkingSessionIds { reply } => {
                let _ = reply.send(Ok(Vec::new()));
            }
            AcpCommand::BackgroundCommands { reply } => {
                let _ = reply.send(Ok(Default::default()));
            }
            AcpCommand::SessionRoots { reply } => {
                let roots = driver_state.lock().session_roots_snapshot();
                let _ = reply.send(Ok(roots));
            }
            AcpCommand::OwnsSession { session_id, reply } => {
                let owned = sessions.lock().contains_key(&session_id.0);
                let _ = reply.send(Ok(owned));
            }
            AcpCommand::IsEphemeralSession { session_id, reply } => {
                let eph = driver_state.lock().is_ephemeral(&session_id.0);
                let _ = reply.send(Ok(eph));
            }
            AcpCommand::PromoteSession { session_id, reply } => {
                let reg = driver_state.lock().promotable_registration(&session_id.0);
                if let (Some(p), Some(reg)) = (&persistence, reg) {
                    if let Err(err) = p.register_session(reg).await {
                        let _ = reply.send(Err(format!("failed to promote session: {err}")));
                        continue;
                    }
                    for sink in &sinks {
                        sink.note_session_registered(&session_id.0);
                    }
                }
                driver_state.lock().unmark_ephemeral(&session_id.0);
                let _ = reply.send(Ok(()));
            }
            AcpCommand::IsTurnActive { session_id, reply } => {
                let active = driver_state.lock().is_turn_active(&session_id.0);
                let _ = reply.send(Ok(active));
            }
            AcpCommand::ActivityProbe { reply } => {
                let _ = reply.send(Ok(driver_state.lock().activity(0)));
            }
            AcpCommand::WaitTurnIdle { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            AcpCommand::Authenticate { reply, .. } | AcpCommand::Logout { reply } => {
                let _ = reply.send(Ok(()));
            }
            AcpCommand::RespondPermission { reply, .. }
            | AcpCommand::AnswerQuestion { reply, .. }
            | AcpCommand::RespondElicitation { reply, .. }
            | AcpCommand::UpsertSubagent { reply, .. } => {
                let _ = reply.send(Ok(()));
            }
            AcpCommand::StopSubagent { reply, .. } => {
                let _ = reply.send(Err(
                    crate::acp::subagents::StopSubagentError::NotStoppable,
                ));
            }
        }
    }

    Ok(())
}

async fn run_prompt_turn(
    spec: &CustomApiSpec,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
    prompt_text: String,
    sessions: &Arc<Mutex<HashMap<String, ApiSessionState>>>,
    cancel: CancellationToken,
) -> Result<StopReason, events::AcpErrorDetail> {
    let trimmed = prompt_text.trim();

    // Built-in `/clear` or `/reset` command: wipe context cleanly in-place.
    if trimmed == "/clear" || trimmed == "/reset" {
        if let Some(sess) = sessions.lock().get_mut(&session_id.0) {
            sess.messages.clear();
            sess.last_used_tokens = 0;
        }
        emit_usage(sinks, agent_id, session_id, 0, spec.context_window);
        emit_chunk(
            sinks,
            agent_id,
            session_id,
            ChunkRole::Agent,
            "Context reset — starting fresh in this chat.".to_string(),
        );
        return Ok(StopReason::EndTurn);
    }

    let api_key = read_api_key(&spec.config_id).map_err(api_err)?;

    // Built-in `/compact` command: summarize conversation history and shrink context.
    if trimmed == "/compact" || trimmed.starts_with("/compact ") {
        return run_compact_turn(
            spec,
            sinks,
            agent_id,
            session_id,
            api_key.as_deref(),
            sessions,
            cancel,
        )
        .await;
    }

    let (cwd, additional_dirs, model, mut history) = {
        let mut map = sessions.lock();
        let Some(sess) = map.get_mut(&session_id.0) else {
            return Err(api_err("Session not found".to_string()));
        };
        sess.messages.push(ChatMessage::User(prompt_text));
        (
            sess.cwd.clone(),
            sess.additional_directories.clone(),
            sess.model.clone(),
            sess.messages.clone(),
        )
    };

    let system_prompt = build_system_prompt(spec, &cwd);
    let tool_defs = tools::available_tools(spec.allow_terminal);
    let mut last_used = 0u64;

    for _round in 0..MAX_TOOL_ROUNDS {
        let turn_res = protocols::stream_turn(
            &spec.endpoint,
            spec.format,
            &model,
            api_key.as_deref(),
            &spec.custom_headers,
            &system_prompt,
            &history,
            &tool_defs,
            cancel.clone(),
            |delta| match delta {
                StreamDelta::Text(text) => {
                    emit_chunk(sinks, agent_id, session_id, ChunkRole::Agent, text);
                }
                StreamDelta::Thought(thought) => {
                    emit_chunk(sinks, agent_id, session_id, ChunkRole::Thought, thought);
                }
            },
        )
        .await
        .map_err(api_err)?;

        let reported_total = turn_res.usage.input_tokens + turn_res.usage.output_tokens;
        history.push(ChatMessage::Assistant {
            text: turn_res.text,
            tool_calls: turn_res.tool_calls.clone(),
        });

        last_used = if reported_total > 0 {
            reported_total
        } else {
            estimate_tokens(&history, &system_prompt)
        };
        emit_usage(sinks, agent_id, session_id, last_used, spec.context_window);

        if turn_res.cancelled {
            save_history(sessions, &session_id.0, history, last_used);
            return Ok(StopReason::Cancelled);
        }

        if turn_res.tool_calls.is_empty() {
            save_history(sessions, &session_id.0, history, last_used);
            return Ok(StopReason::EndTurn);
        }

        // Execute requested workspace tools and emit ACP ToolCall cards.
        for call in turn_res.tool_calls {
            let acp_sid =
                agent_client_protocol::schema::v1::SessionId::new(session_id.0.as_str());
            let start_tc = ToolCall::new(call.id.clone(), format!("Running {}", call.name))
                .status(ToolCallStatus::InProgress)
                .raw_input(call.arguments.clone());
            client::emit_session_update(
                sinks,
                agent_id,
                SessionNotification::new(acp_sid.clone(), SessionUpdate::ToolCall(start_tc)),
            );

            let exec = tools::execute_tool(
                &call.name,
                &call.arguments,
                &cwd,
                &additional_dirs,
                spec.allow_terminal,
            )
            .await;

            let mut fields = ToolCallUpdateFields::new()
                .title(exec.title.clone())
                .status(if exec.ok {
                    ToolCallStatus::Completed
                } else {
                    ToolCallStatus::Failed
                })
                .content(vec![ToolCallContent::from(exec.output.clone())]);

            if !exec.locations.is_empty() {
                fields = fields.locations(
                    exec.locations
                        .iter()
                        .map(|p| ToolCallLocation::new(p.clone()))
                        .collect::<Vec<_>>(),
                );
            }

            client::emit_session_update(
                sinks,
                agent_id,
                SessionNotification::new(
                    acp_sid,
                    SessionUpdate::ToolCallUpdate(ToolCallUpdate::new(call.id.clone(), fields)),
                ),
            );

            history.push(ChatMessage::ToolResult {
                call_id: call.id,
                tool_name: call.name,
                output: exec.output,
            });
        }
    }

    save_history(sessions, &session_id.0, history, last_used);
    Ok(StopReason::EndTurn)
}

async fn run_compact_turn(
    spec: &CustomApiSpec,
    sinks: &[Arc<dyn EventSink>],
    agent_id: &AgentId,
    session_id: &SessionId,
    api_key: Option<&str>,
    sessions: &Arc<Mutex<HashMap<String, ApiSessionState>>>,
    cancel: CancellationToken,
) -> Result<StopReason, events::AcpErrorDetail> {
    let (cwd, model, mut history) = {
        let map = sessions.lock();
        let Some(sess) = map.get(&session_id.0) else {
            return Err(api_err("Session not found".to_string()));
        };
        if sess.messages.is_empty() {
            emit_chunk(
                sinks,
                agent_id,
                session_id,
                ChunkRole::Agent,
                "Nothing to compact yet.".to_string(),
            );
            return Ok(StopReason::EndTurn);
        }
        (sess.cwd.clone(), sess.model.clone(), sess.messages.clone())
    };

    history.push(ChatMessage::User(
        "Produce a concise, structured summary of our conversation so far (goals, decisions, files modified, and next steps) so we can continue with a compacted context.".to_string(),
    ));
    let system_prompt = build_system_prompt(spec, &cwd);
    let res = protocols::stream_turn(
        &spec.endpoint,
        spec.format,
        &model,
        api_key,
        &spec.custom_headers,
        &system_prompt,
        &history,
        &[],
        cancel,
        |_| {},
    )
    .await
    .map_err(api_err)?;

    if res.cancelled {
        return Ok(StopReason::Cancelled);
    }

    let compacted = vec![ChatMessage::Assistant {
        text: format!("[Compacted conversation summary]\n{}", res.text.trim()),
        tool_calls: Vec::new(),
    }];
    let new_used = estimate_tokens(&compacted, &system_prompt);
    save_history(sessions, &session_id.0, compacted, new_used);
    emit_usage(sinks, agent_id, session_id, new_used, spec.context_window);
    emit_chunk(
        sinks,
        agent_id,
        session_id,
        ChunkRole::Agent,
        format!("Context compacted (~{} tokens).\n\n{}", new_used, res.text.trim()),
    );
    Ok(StopReason::EndTurn)
}

fn save_history(
    sessions: &Arc<Mutex<HashMap<String, ApiSessionState>>>,
    session_id: &str,
    history: Vec<ChatMessage>,
    used: u64,
) {
    if let Some(sess) = sessions.lock().get_mut(session_id) {
        sess.messages = history;
        sess.last_used_tokens = used;
    }
}

fn api_err(message: String) -> events::AcpErrorDetail {
    events::AcpErrorDetail {
        message,
        code: None,
        data: None,
        timed_out: false,
        connection_closed: false,
        rpc_message_len: None,
    }
}
