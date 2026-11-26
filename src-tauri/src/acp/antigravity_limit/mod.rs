//! The host acts when a managed Antigravity chat reaches its account's plan
//! limit (the "Usage Limit Reached" turn the command loop turns into an
//! `agent_error` with `data.agent == "antigravity"`),
//! with or without a client connected: it moves that chat alone to the
//! signed-in account with the most room and continues it there, or continues
//! it when the limit resets. The renderer only shows what happened
//! (`acp:antigravity_limit_action`).

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

pub const ANTIGRAVITY_CONFIG_ID: &str = crate::acp::antigravity_agent::ANTIGRAVITY_ACP_CONFIG_ID;

pub const RESUME_GRACE: Duration = Duration::from_secs(15);

const SCHEDULE_FILE: &str = "antigravity-limit-resumes.json";

enum Input {
    Limit {
        agent_id: AgentId,
        session_id: SessionId,
        kind: String,
        /// Epoch milliseconds of the reset the agent named, if any.
        resets_at: Option<i64>,
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
pub struct AntigravityLimitHandle {
    tx: mpsc::UnboundedSender<Input>,
    clock: Arc<TurnClock>,
    limited: Arc<LimitedAccounts>,
}

pub struct AntigravityLimitInbox {
    rx: mpsc::UnboundedReceiver<Input>,
    clock: Arc<TurnClock>,
    limited: Arc<LimitedAccounts>,
}

impl AntigravityLimitHandle {
    #[must_use]
    pub fn channel() -> (Self, AntigravityLimitInbox) {
        let (tx, rx) = mpsc::unbounded_channel();
        let clock = Arc::new(TurnClock::default());
        let limited = Arc::new(LimitedAccounts::default());
        (
            Self {
                tx,
                clock: Arc::clone(&clock),
                limited: Arc::clone(&limited),
            },
            AntigravityLimitInbox { rx, clock, limited },
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
            .map_err(|_| "the Antigravity limit supervisor is not running".to_string())?;
        answer
            .await
            .map_err(|_| "the Antigravity limit supervisor stopped".to_string())?
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
        // Only an Antigravity plan limit: the Codex supervisor reads the
        // errors without `data.agent`.
        let Some((kind, resets_at)) = event
            .payload
            .get("data")
            .and_then(crate::acp::antigravity_accounts::usage::antigravity_plan_limit)
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
            resets_at,
        });
    }
}

pub fn start(
    acp: &Arc<AcpManager>,
    relay: &Arc<WsRelaySink>,
    handle: AntigravityLimitHandle,
    inbox: AntigravityLimitInbox,
    runtime: &tokio::runtime::Handle,
) {
    let path = acp
        .antigravity_agent()
        .state_dir()
        .map(|dir| dir.join(SCHEDULE_FILE));
    acp.set_antigravity_limit(handle);
    let AntigravityLimitInbox { rx, clock, limited } = inbox;
    let supervisor = supervisor::Supervisor::new(
        Arc::clone(acp),
        Arc::clone(relay),
        crate::acp::claude_limit::schedule::Schedule::open(path, "antigravity-limit"),
        RESUME_GRACE,
        clock,
        limited,
    );
    runtime.spawn(supervisor.run(rx));
    log::info!("[antigravity-limit] supervisor started");
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AccountRef {
    pub id: String,
    pub name: String,
}

/// Payload of `acp:antigravity_limit_action`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityLimitActionEvent {
    pub session_id: String,
    pub project_id: String,
    #[serde(flatten)]
    pub action: AntigravityLimitAction,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum AntigravityLimitAction {
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

/// The limit named in notices. Antigravity reports one quota per model with
/// no fixed window length, so every kind is the `usage` limit.
#[must_use]
pub fn window_name(_kind: Option<&str>) -> &'static str {
    "usage"
}

#[must_use]
pub fn switch_notice(from: &str, to: &str, window: &str) -> String {
    format!(
        "Karsa moved this chat from Antigravity account {from} to {to} because {from} reached its \
         {window} limit. Continue the task you were working on. Subagents and background \
         commands that were running before the switch were stopped; restart the ones that are \
         still needed."
    )
}

#[must_use]
pub fn resume_notice(account: &str, window: &str, reset: &str) -> String {
    format!(
        "Karsa continued this chat because the {window} limit of Antigravity account {account} \
         reset at {reset}. Continue the task you were working on. Subagents and background \
         commands that were running when the limit was reached may have stopped; restart the \
         ones that are still needed."
    )
}

#[cfg(test)]
#[path = "real_loop_tests.rs"]
mod real_loop_tests;

#[cfg(test)]
#[path = "cross_keep_tests.rs"]
mod cross_keep_tests;

#[cfg(test)]
#[path = "sink_tests.rs"]
mod sink_tests;
