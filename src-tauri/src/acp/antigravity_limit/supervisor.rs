use std::collections::HashSet;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tokio::sync::mpsc;

use super::decide::{self, ChatHolder, LimitContext, LimitDecision, ResumePlan, SHORTEST_WINDOW};
use super::relaunch::Relaunch;
use super::{
    resume_notice, switch_notice, window_name, AccountRef, AntigravityLimitAction,
    AntigravityLimitActionEvent, Input, LimitedAccounts, TurnClock, ANTIGRAVITY_CONFIG_ID,
};
use crate::acp::antigravity_accounts::AntigravityAccountsSnapshot;
use crate::acp::antigravity_agent::AntigravityLaunchAuth;
use crate::acp::claude_limit::schedule::{Schedule, ScheduledResume};
use crate::acp::config::{AgentId, SessionId};
use crate::acp::events::EVENT_ANTIGRAVITY_LIMIT_ACTION;
use crate::acp::{AcpManager, AntigravitySignInCheck};
use crate::logging::redact_session_id;
use crate::web::WsRelaySink;

const CANCEL_WAIT: Duration = Duration::from_secs(10);

#[derive(PartialEq, Eq, Hash)]
struct Attempt {
    session_id: String,
    resets_at: Option<i64>,
    account_id: String,
}

pub(super) struct Supervisor {
    pub(super) acp: Arc<AcpManager>,
    pub(super) relay: Arc<WsRelaySink>,
    pub(super) schedule: Schedule,
    grace: Duration,
    limited: Arc<LimitedAccounts>,
    attempts: HashSet<Attempt>,
    clock: Arc<TurnClock>,
}

impl Supervisor {
    pub(super) fn new(
        acp: Arc<AcpManager>,
        relay: Arc<WsRelaySink>,
        schedule: Schedule,
        grace: Duration,
        clock: Arc<TurnClock>,
        limited: Arc<LimitedAccounts>,
    ) -> Self {
        // A resume loaded from disk was not held when it was scheduled. Hold
        // it now so a reap after a client reopens the chat keeps the recipe.
        for session_id in schedule.session_ids() {
            acp.keep_launch_recipe(&session_id, true);
        }
        Self {
            acp,
            relay,
            schedule,
            grace,
            limited,
            attempts: HashSet::new(),
            clock,
        }
    }

    pub(super) async fn run(mut self, mut inbox: mpsc::UnboundedReceiver<Input>) {
        loop {
            let wait = self.schedule.next_at().map(|at| {
                let due = epoch(at) + self.grace;
                due.duration_since(SystemTime::now()).unwrap_or_default()
            });
            tokio::select! {
                biased;
                input = inbox.recv() => match input {
                    Some(input) => self.handle(input).await,
                    None => break,
                },
                () = sleep_or_forever(wait) => self.resume_due().await,
            }
        }
    }

    async fn handle(&mut self, input: Input) {
        match input {
            Input::Limit {
                agent_id,
                session_id,
                kind,
                resets_at,
            } => self.on_limit(agent_id, session_id, kind, resets_at).await,
            Input::SetResume {
                session_id,
                at,
                reply,
            } => {
                let _ = reply.send(self.set_resume(&session_id, at));
            }
            Input::TurnStarted { session_id, seq } => {
                self.drop_resume(&session_id, "a turn of the chat started", true);
                self.clock.settle(&session_id.0, seq);
            }
            Input::Closed {
                session_id,
                deleted,
            } => self.drop_resume(&session_id, "the chat was closed", !deleted),
            Input::AgentStopped { agent_id } => {
                log::debug!("[antigravity-limit] agent {agent_id} stopped");
                self.forget_unheld_recipes();
            }
        }
    }

    /// Forget the recipe of every chat whose agent stopped and that neither
    /// supervisor is holding for a scheduled resume.
    fn forget_unheld_recipes(&self) {
        self.acp.forget_recipes_without_agent();
    }

    fn hold_recipe(&self, session_id: &str) {
        self.acp.keep_launch_recipe(session_id, true);
    }

    fn release_recipe(&mut self, session_id: &str) {
        self.acp.keep_launch_recipe(session_id, false);
        self.forget_unheld_recipes();
    }

    fn drop_resume(&mut self, session_id: &SessionId, why: &str, announce: bool) {
        let Some(entry) = self.schedule.remove(&session_id.0) else {
            return;
        };
        log::info!(
            "[antigravity-limit] scheduled resume of chat {} dropped: {why}",
            redact_session_id(&session_id.0)
        );
        self.release_recipe(&session_id.0);
        if announce {
            self.emit(
                session_id,
                &entry.project_id,
                AntigravityLimitAction::ResumeCancelled,
            );
        }
    }

    async fn on_limit(
        &mut self,
        agent_id: AgentId,
        session_id: SessionId,
        kind: String,
        reported_reset: Option<i64>,
    ) {
        let chat = redact_session_id(&session_id.0);
        let Some(launch) = self.acp.agent_launch(&agent_id) else {
            log::info!("[antigravity-limit] chat {chat} reached a limit on an agent the host did not launch for a client; skipped");
            return;
        };
        if launch.config.config_id.as_deref() != Some(ANTIGRAVITY_CONFIG_ID) {
            return;
        }
        let AntigravityLaunchAuth::Account(agent_account) = launch.antigravity else {
            log::info!("[antigravity-limit] chat {chat} reached a limit on credentials that no account switch changes; skipped");
            return;
        };
        let Some(project_id) = launch.project_id else {
            log::info!(
                "[antigravity-limit] chat {chat} reached a limit outside a project; skipped"
            );
            return;
        };
        let antigravity = self.acp.antigravity_agent();
        // A prompt that starts during either read belongs to a newer turn.
        // Moving the chat would cancel that turn, so the move is skipped.
        let turn_mark = self.clock.now();
        let snapshot = match antigravity.profile_list().await {
            Ok(snapshot) => snapshot,
            Err(error) => {
                log::warn!("[antigravity-limit] chat {chat}: could not read the accounts: {error}");
                return;
            }
        };
        let chat_account = snapshot
            .account_for(Some(&project_id), Some(&session_id.0))
            .to_string();
        // Only the reset the agent named in its limit message counts. A usage
        // check the user ran is display only.
        let resets_at = reported_reset.map(|ms| ms.div_euclid(1000));
        if resets_at.is_none() {
            log::info!("[antigravity-limit] chat {chat}: no reset time is known for this limit");
        }
        if !self.attempts.insert(Attempt {
            session_id: session_id.0.clone(),
            resets_at,
            account_id: agent_account.clone(),
        }) {
            return;
        }
        let now = SystemTime::now();
        self.limited.mark(
            &agent_account,
            resets_at.map_or(now + SHORTEST_WINDOW, epoch),
        );
        if self.clock.started_since(&session_id.0, turn_mark) {
            // The account stays limited. This signal did not move the chat,
            // so a later limit for the same reset can still switch or resume.
            self.attempts.remove(&Attempt {
                session_id: session_id.0.clone(),
                resets_at,
                account_id: agent_account.clone(),
            });
            log::info!(
                "[antigravity-limit] chat {chat} started a newer turn during the limit check; left alone"
            );
            return;
        }
        let candidates =
            decide::rank_alternatives(&decide::candidates(&snapshot, Some(&agent_account)));
        let decision = decide::decide(&LimitContext {
            agent_account: &agent_account,
            chat_account: &chat_account,
            auto_switch: snapshot.auto_switch,
            candidates: &candidates,
            limited_until: &self.limited.snapshot(),
            resets_at: resets_at.map(epoch),
            now,
        });
        log::info!("[antigravity-limit] chat {chat} reached its limit: {decision:?}");
        let window = window_name(Some(kind.as_str()));
        let name = |id: &str| account_ref(&snapshot, id);
        match decision {
            LimitDecision::Switch { to } => {
                let applied = antigravity
                    .set_chat_account(
                        &project_id,
                        &session_id.0,
                        Some(&to),
                        Some(&agent_account),
                        AntigravitySignInCheck::Required,
                    )
                    .await;
                match applied {
                    Ok(true) => {
                        let (from, to) = (name(&agent_account), name(&to));
                        let notice = switch_notice(&from.name, &to.name, window);
                        self.move_chat(&session_id, &project_id, &agent_id, from, to, notice)
                            .await;
                    }
                    Ok(false) => log::info!(
                        "[antigravity-limit] chat {chat} changed its account first; it continues there"
                    ),
                    Err(error) => {
                        self.attempts.remove(&Attempt {
                            session_id: session_id.0.clone(),
                            resets_at,
                            account_id: agent_account.clone(),
                        });
                        log::warn!(
                            "[antigravity-limit] switching the account of chat {chat} failed: {}",
                            scrub(&error, &session_id)
                        );
                        self.emit(
                            &session_id,
                            &project_id,
                            AntigravityLimitAction::Failed { reason: error },
                        );
                    }
                }
            }
            LimitDecision::Restart => {
                let (from, to) = (name(&agent_account), name(&chat_account));
                let notice = switch_notice(&from.name, &to.name, window);
                self.move_chat(&session_id, &project_id, &agent_id, from, to, notice)
                    .await;
            }
            LimitDecision::ResumeAt { at } => {
                let at = epoch_secs(at);
                self.hold_recipe(&session_id.0);
                self.schedule.insert(ScheduledResume {
                    session_id: session_id.0.clone(),
                    project_id: project_id.clone(),
                    at,
                    account_id: Some(agent_account),
                    window: Some(kind),
                    turn_mark: self.clock.now(),
                });
                self.emit(
                    &session_id,
                    &project_id,
                    AntigravityLimitAction::ResumeScheduled { at: at * 1000 },
                );
            }
            LimitDecision::Ignore { .. } => {}
        }
    }

    fn set_resume(&mut self, session_id: &SessionId, at: Option<SystemTime>) -> Result<(), String> {
        let chat = redact_session_id(&session_id.0);
        match at {
            Some(at) => {
                let (recipe, added) = self
                    .acp
                    .keep_present_launch_recipe(session_id)
                    .ok_or_else(|| "This chat is not open on the host.".to_string())?;
                let AntigravityLaunchAuth::Account(account_id) = &recipe.launch.antigravity else {
                    if added {
                        self.acp.keep_launch_recipe(&session_id.0, false);
                    }
                    return Err(
                        "This chat does not run on an Antigravity account Karsa manages."
                            .to_string(),
                    );
                };
                if recipe.launch.config.config_id.as_deref() != Some(ANTIGRAVITY_CONFIG_ID) {
                    if added {
                        self.acp.keep_launch_recipe(&session_id.0, false);
                    }
                    return Err(
                        "This chat does not run on an Antigravity account Karsa manages."
                            .to_string(),
                    );
                }
                let account_id = account_id.clone();
                let project_id = recipe.launch.project_id.clone().unwrap_or_default();
                let at = epoch_secs(at);
                self.schedule.insert(ScheduledResume {
                    session_id: session_id.0.clone(),
                    project_id: project_id.clone(),
                    at,
                    account_id: Some(account_id),
                    window: None,
                    turn_mark: self.clock.now(),
                });
                log::info!("[antigravity-limit] chat {chat} continues at {at} (asked by a client)");
                self.emit(
                    session_id,
                    &project_id,
                    AntigravityLimitAction::ResumeScheduled { at: at * 1000 },
                );
            }
            None => self.drop_resume(session_id, "a client cancelled it", true),
        }
        Ok(())
    }

    async fn resume_due(&mut self) {
        let now = SystemTime::now()
            .checked_sub(self.grace)
            .unwrap_or(UNIX_EPOCH);
        while let Some(entry) = self.schedule.take_next_due(epoch_secs(now)) {
            self.resume(entry).await;
        }
    }

    fn turn_started_since(&self, entry: &ScheduledResume) -> bool {
        let started = self.clock.started_since(&entry.session_id, entry.turn_mark);
        if started {
            log::info!(
                "[antigravity-limit] chat {} started a turn after its resume was scheduled; left alone",
                redact_session_id(&entry.session_id)
            );
        }
        started
    }

    async fn resume(&mut self, entry: ScheduledResume) {
        let session_id = SessionId(entry.session_id.clone());
        let chat = redact_session_id(&entry.session_id);
        let finish = |this: &mut Self| this.release_recipe(&entry.session_id);
        if self.acp.launch_recipe(&session_id).is_none() {
            log::warn!("[antigravity-limit] chat {chat} was due to continue, but the host restarted since; it continues when a client reopens it");
            self.emit(
                &session_id,
                &entry.project_id,
                AntigravityLimitAction::Failed {
                    reason: "The host restarted while this chat waited for its limit to reset. Send a message to continue."
                        .to_string(),
                },
            );
            finish(self);
            return;
        }
        let cancelled = |this: &mut Self| {
            this.emit(
                &session_id,
                &entry.project_id,
                AntigravityLimitAction::ResumeCancelled,
            );
            this.release_recipe(&entry.session_id);
        };
        let moving = self.acp.begin_host_move(&session_id).await;
        let antigravity = self.acp.antigravity_agent();
        let snapshot = antigravity.profile_list().await.ok();
        let chat_account = snapshot.as_ref().map(|s| {
            s.account_for(Some(&entry.project_id), Some(&entry.session_id))
                .to_string()
        });
        let owner = self.live_owner(&session_id, None).await;
        let from_agent_id = owner.as_ref().map(|agent| agent.0.clone()).or_else(|| {
            self.acp
                .persistence()?
                .metadata(&entry.session_id)
                .ok()?
                .runtime_agent_id
        });
        let launch = owner
            .as_ref()
            .and_then(|agent| self.acp.agent_launch(agent));
        let holder = match (&owner, &launch) {
            (None, _) => ChatHolder::Nobody,
            (Some(_), Some(launch))
                if launch.config.config_id.as_deref() == Some(ANTIGRAVITY_CONFIG_ID) =>
            {
                match &launch.antigravity {
                    AntigravityLaunchAuth::Account(id) => ChatHolder::Account(id),
                    _ => ChatHolder::Other,
                }
            }
            (Some(_), _) => ChatHolder::Other,
        };
        let plan =
            decide::plan_resume(holder, entry.account_id.as_deref(), chat_account.as_deref());
        log::info!("[antigravity-limit] chat {chat} is due to continue: {plan:?}");
        if plan == ResumePlan::Skip || self.turn_started_since(&entry) {
            cancelled(self);
            return;
        }
        let agent_id = match (plan, owner) {
            (ResumePlan::Continue, Some(agent)) => {
                if self
                    .acp
                    .is_turn_active(&agent, session_id.clone())
                    .await
                    .unwrap_or(false)
                {
                    if self.turn_started_since(&entry) {
                        cancelled(self);
                        return;
                    }
                    let _ = self.acp.cancel_prompt(&agent, session_id.clone()).await;
                    let _ = tokio::time::timeout(
                        CANCEL_WAIT,
                        self.acp.wait_turn_idle(&agent, session_id.clone()),
                    )
                    .await;
                }
                agent
            }
            (_, owner) => match self.relaunch(&moving, &session_id, owner.as_ref()).await {
                Ok(Relaunch::Done(relaunched)) => relaunched,
                Ok(Relaunch::HeldElsewhere(holder)) => {
                    log::info!(
                        "[antigravity-limit] chat {chat} is open on agent {holder} now; left there"
                    );
                    cancelled(self);
                    return;
                }
                Err(reason) => {
                    log::warn!(
                        "[antigravity-limit] chat {chat} did not continue after the reset: {}",
                        scrub(&reason, &session_id)
                    );
                    self.emit(
                        &session_id,
                        &entry.project_id,
                        AntigravityLimitAction::Failed { reason },
                    );
                    finish(self);
                    return;
                }
            },
        };
        self.emit(
            &session_id,
            &entry.project_id,
            AntigravityLimitAction::Resumed {
                from_agent_id,
                new_agent_id: agent_id.0.clone(),
            },
        );
        let account = match (&entry.account_id, &snapshot) {
            (Some(id), Some(snapshot)) => account_ref(snapshot, id).name,
            _ => "the account".to_string(),
        };
        let reset = chrono::DateTime::from_timestamp(entry.at, 0)
            .map_or_else(String::new, |at| at.format("%H:%M UTC").to_string());
        let notice = resume_notice(&account, window_name(entry.window.as_deref()), &reset);
        self.send_notice(&agent_id, &session_id, &notice).await;
        drop(moving);
        finish(self);
    }

    pub(super) async fn live_owner(
        &self,
        session_id: &SessionId,
        except: Option<&AgentId>,
    ) -> Option<AgentId> {
        crate::acp::limit_runtime::live_owner(&self.acp, session_id, except).await
    }

    pub(super) fn emit(
        &self,
        session_id: &SessionId,
        project_id: &str,
        action: AntigravityLimitAction,
    ) {
        self.acp.record_session_event(
            &session_id.0,
            EVENT_ANTIGRAVITY_LIMIT_ACTION,
            &AntigravityLimitActionEvent {
                session_id: session_id.0.clone(),
                project_id: project_id.to_string(),
                action,
            },
        );
    }
}

pub(super) use crate::acp::limit_runtime::scrub;

fn account_ref(snapshot: &AntigravityAccountsSnapshot, id: &str) -> AccountRef {
    let name = snapshot
        .profiles
        .iter()
        .find(|account| account.id == id)
        .map_or_else(|| id.to_string(), |account| account.name.clone());
    AccountRef {
        id: id.to_string(),
        name,
    }
}

fn epoch(secs: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_secs(u64::try_from(secs).unwrap_or(0))
}

fn epoch_secs(at: SystemTime) -> i64 {
    at.duration_since(UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_secs()).unwrap_or(i64::MAX))
}

async fn sleep_or_forever(wait: Option<Duration>) {
    match wait {
        Some(wait) => tokio::time::sleep(wait).await,
        None => std::future::pending().await,
    }
}

#[cfg(test)]
#[path = "supervisor_tests.rs"]
mod tests;
