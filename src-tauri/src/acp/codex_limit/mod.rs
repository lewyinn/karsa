//! The host acts when a managed Codex chat reaches its account's plan limit,
//! with or without a client connected: it moves that chat alone to the
//! signed-in account with the most room and continues it there, or continues
//! it when the limit resets. The renderer only shows what happened
//! (`acp:codex_limit_action`).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

pub(crate) use crate::acp::limit_runtime::{LimitedAccounts, TurnClock};

use serde::Serialize;
use tokio::sync::{mpsc, oneshot};

use crate::acp::config::{AgentId, SessionId};
use crate::acp::events::{EVENT_AGENT_DISCONNECTED, EVENT_AGENT_ERROR};
use crate::acp::AcpManager;
use crate::web::sink::{AcpEvent, EventSink};
use crate::web::WsRelaySink;

pub mod decide;
mod relaunch;
mod supervisor;

pub use crate::acp::claude_limit::decide::SHORTEST_WINDOW;

pub const CODEX_CONFIG_ID: &str = crate::acp::codex_agent::CODEX_ACP_CONFIG_ID;

pub const RESUME_GRACE: Duration = Duration::from_secs(15);

const SCHEDULE_FILE: &str = "codex-limit-resumes.json";

enum Input {
    Limit {
        agent_id: AgentId,
        session_id: SessionId,
        kind: String,
    },
    SetResume {
        session_id: SessionId,
        at: Option<SystemTime>,
        reply: oneshot::Sender<Result<(), String>>,
    },
    TurnStarted {
        session_id: SessionId,
        seq: u64,
    },
    Closed {
        session_id: SessionId,
        deleted: bool,
    },
    AgentStopped {
        agent_id: AgentId,
    },
}

#[derive(Clone)]
pub struct CodexLimitHandle {
    tx: mpsc::UnboundedSender<Input>,
    clock: Arc<TurnClock>,
    limited: Arc<LimitedAccounts>,
}

pub struct CodexLimitInbox {
    rx: mpsc::UnboundedReceiver<Input>,
    clock: Arc<TurnClock>,
    limited: Arc<LimitedAccounts>,
}

impl CodexLimitHandle {
    #[must_use]
    pub fn channel() -> (Self, CodexLimitInbox) {
        let (tx, rx) = mpsc::unbounded_channel();
        let clock = Arc::new(TurnClock::default());
        let limited = Arc::new(LimitedAccounts::default());
        (
            Self {
                tx,
                clock: Arc::clone(&clock),
                limited: Arc::clone(&limited),
            },
            CodexLimitInbox { rx, clock, limited },
        )
    }

    #[must_use]
    pub fn sink(&self) -> Arc<dyn EventSink> {
        Arc::new(LimitSignalSink {
            tx: self.tx.clone(),
        })
    }

    /// Continue the chat at `at`, or cancel its scheduled resume with `None`.
    pub async fn set_resume(
        &self,
        session_id: SessionId,
        at: Option<SystemTime>,
    ) -> Result<(), String> {
        let (reply, answer) = oneshot::channel();
        self.tx
            .send(Input::SetResume {
                session_id,
                at,
                reply,
            })
            .map_err(|_| "the Codex limit supervisor is not running".to_string())?;
        answer
            .await
            .map_err(|_| "the Codex limit supervisor stopped".to_string())?
    }

    /// The Accounts the supervisor saw reach a limit, and when each resets.
    #[must_use]
    pub(crate) fn limited_until(&self) -> HashMap<String, SystemTime> {
        self.limited.snapshot()
    }

    /// A turn of the chat started: its scheduled resume no longer applies.
    pub fn turn_started(&self, session_id: SessionId) {
        let seq = self.clock.start(&session_id.0);
        let _ = self.tx.send(Input::TurnStarted { session_id, seq });
    }

    /// The chat closed, or was deleted with its log: drop its scheduled resume.
    pub fn chat_closed(&self, session_id: SessionId, deleted: bool) {
        let _ = self.tx.send(Input::Closed {
            session_id,
            deleted,
        });
    }
}

struct LimitSignalSink {
    tx: mpsc::UnboundedSender<Input>,
}

impl EventSink for LimitSignalSink {
    fn emit(&self, event: &AcpEvent) {
        if event.type_ == EVENT_AGENT_DISCONNECTED {
            if let Some(agent_id) = event.payload.get("agentId").and_then(|id| id.as_str()) {
                let _ = self.tx.send(Input::AgentStopped {
                    agent_id: AgentId(agent_id.to_string()),
                });
            }
            return;
        }
        if event.type_ != EVENT_AGENT_ERROR {
            return;
        }
        let data = event.payload.get("data");
        // An Antigravity plan limit carries the same `errorKind`; its own
        // supervisor handles it.
        if data
            .and_then(crate::acp::antigravity_accounts::usage::antigravity_plan_limit)
            .is_some()
        {
            return;
        }
        let Some(kind) = data.and_then(crate::acp::codex_accounts::usage::codex_plan_limit_kind)
        else {
            return;
        };
        let text = |key: &str| event.payload.get(key)?.as_str().map(str::to_string);
        let (Some(agent_id), Some(session_id)) = (text("agentId"), text("sessionId")) else {
            return;
        };
        let _ = self.tx.send(Input::Limit {
            agent_id: AgentId(agent_id),
            session_id: SessionId(session_id),
            kind: kind.to_string(),
        });
    }
}

pub fn start(
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    handle: CodexLimitHandle,
    inbox: CodexLimitInbox,
    runtime: &tokio::runtime::Handle,
) {
    let path = acp
        .codex_agent()
        .state_dir()
        .map(|dir| dir.join(SCHEDULE_FILE));
    acp.set_codex_limit(handle);
    let CodexLimitInbox { rx, clock, limited } = inbox;
    let supervisor = supervisor::Supervisor::new(
        Arc::clone(acp),
        Arc::clone(relay),
        crate::acp::claude_limit::schedule::Schedule::open(path, "codex-limit"),
        RESUME_GRACE,
        clock,
        limited,
    );
    runtime.spawn(supervisor.run(rx));
    log::info!("[codex-limit] supervisor started");
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountRef {
    pub id: String,
    pub name: String,
}

/// Payload of `acp:codex_limit_action`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexLimitActionEvent {
    pub session_id: String,
    pub project_id: String,
    #[serde(flatten)]
    pub action: CodexLimitAction,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum CodexLimitAction {
    #[serde(rename_all = "camelCase")]
    Switched {
        from: AccountRef,
        to: AccountRef,
        from_agent_id: String,
        new_agent_id: String,
    },
    ResumeScheduled {
        at: i64,
    },
    ResumeCancelled,
    #[serde(rename_all = "camelCase")]
    Resumed {
        from_agent_id: Option<String>,
        new_agent_id: String,
    },
    Failed {
        reason: String,
    },
}

#[must_use]
pub fn window_name(kind: Option<&str>) -> &'static str {
    match kind {
        Some("rate_limited" | "session" | "five_hour") => "5-hour",
        Some("quota_exhausted" | "weekly" | "seven_day") => "weekly",
        _ => "usage",
    }
}

#[must_use]
pub fn switch_notice(from: &str, to: &str, window: &str) -> String {
    format!(
        "Karsa moved this chat from Codex account {from} to {to} because {from} reached its \
         {window} limit. Continue the task you were working on. Subagents and background \
         commands that were running before the switch were stopped; restart the ones that are \
         still needed."
    )
}

#[must_use]
pub fn resume_notice(account: &str, window: &str, reset: &str) -> String {
    format!(
        "Karsa continued this chat because the {window} limit of Codex account {account} \
         reset at {reset}. Continue the task you were working on. Subagents and background \
         commands that were running when the limit was reached may have stopped; restart the \
         ones that are still needed."
    )
}

#[cfg(test)]
#[path = "real_loop_tests.rs"]
pub(crate) mod real_loop_tests;

#[cfg(test)]
#[path = "cross_keep_tests.rs"]
mod cross_keep_tests;

#[cfg(test)]
#[path = "sink_tests.rs"]
mod sink_tests;
