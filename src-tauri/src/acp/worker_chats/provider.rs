//! The Account providers Karsa manages, and what a worker chat's Account
//! pick reads from and writes to each.

use std::collections::HashMap;
use std::time::SystemTime;

use crate::acp::antigravity_agent::AntigravityLaunchAuth;
use crate::acp::antigravity_limit::{self, AntigravityLimitHandle, ANTIGRAVITY_CONFIG_ID};
use crate::acp::claude_agent::ClaudeLaunchAuth;
use crate::acp::claude_limit::decide::Candidate;
use crate::acp::claude_limit::{self, AccountRef, ClaudeLimitHandle, CLAUDE_CONFIG_ID};
use crate::acp::codex_agent::CodexLaunchAuth;
use crate::acp::codex_limit::{self, CodexLimitHandle, CODEX_CONFIG_ID};
use crate::acp::manager::AgentLaunch;
use crate::acp::{AcpManager, AntigravitySignInCheck, CodexSignInCheck, SignInCheck};

/// The provider of the managed Account a caller runs on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
    Antigravity,
}

/// One provider's Accounts, as a worker chat's Account pick reads them.
pub(super) struct Accounts {
    pub(super) profiles: Vec<AccountRef>,
    /// The user's consent to run chats on other Accounts.
    pub(super) auto_switch: bool,
    pub(super) candidates: Vec<Candidate>,
}

impl Provider {
    /// The provider of the Account `launch` runs on; `None` when no Account
    /// switch changes its credentials.
    pub(crate) fn of(launch: &AgentLaunch) -> Option<Self> {
        match launch.config.config_id.as_deref()? {
            CLAUDE_CONFIG_ID if matches!(launch.claude, ClaudeLaunchAuth::Account(_)) => {
                Some(Self::Claude)
            }
            CODEX_CONFIG_ID if matches!(launch.codex, CodexLaunchAuth::Account(_)) => {
                Some(Self::Codex)
            }
            ANTIGRAVITY_CONFIG_ID
                if matches!(launch.antigravity, AntigravityLaunchAuth::Account(_)) =>
            {
                Some(Self::Antigravity)
            }
            _ => None,
        }
    }

    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude",
            Self::Codex => "Codex",
            Self::Antigravity => "Antigravity",
        }
    }

    /// The Accounts, with a fresh usage read when automatic switching is on.
    /// Antigravity reads none, since its usage checks are for display only.
    pub(super) async fn accounts(self, acp: &AcpManager) -> Result<Accounts, String> {
        match self {
            Self::Claude => {
                let agent = acp.claude_agent();
                let snapshot = agent.profile_list().await?;
                let usage = if snapshot.auto_switch {
                    self.usage_or_empty(agent.accounts_usage(true).await)
                } else {
                    Vec::new()
                };
                Ok(Accounts {
                    profiles: snapshot
                        .profiles
                        .iter()
                        .map(|account| named(&account.id, &account.name))
                        .collect(),
                    auto_switch: snapshot.auto_switch,
                    candidates: claude_limit::decide::candidates(&snapshot, &usage, None),
                })
            }
            Self::Codex => {
                let agent = acp.codex_agent();
                let snapshot = agent.profile_list().await?;
                let usage = if snapshot.auto_switch {
                    self.usage_or_empty(agent.accounts_usage(true).await)
                } else {
                    Vec::new()
                };
                Ok(Accounts {
                    profiles: snapshot
                        .profiles
                        .iter()
                        .map(|account| named(&account.id, &account.name))
                        .collect(),
                    auto_switch: snapshot.auto_switch,
                    candidates: codex_limit::decide::candidates(&snapshot, &usage, None),
                })
            }
            Self::Antigravity => {
                let agent = acp.antigravity_agent();
                let snapshot = agent.profile_list().await?;
                Ok(Accounts {
                    profiles: snapshot
                        .profiles
                        .iter()
                        .map(|account| named(&account.id, &account.name))
                        .collect(),
                    auto_switch: snapshot.auto_switch,
                    candidates: antigravity_limit::decide::candidates(&snapshot, None),
                })
            }
        }
    }

    fn usage_or_empty<T>(self, read: Result<Vec<T>, String>) -> Vec<T> {
        read.unwrap_or_else(|error| {
            log::warn!("[worker-chats] {} usage read failed: {error}", self.name());
            Vec::new()
        })
    }

    /// The Accounts this provider's limit supervisor saw reach a limit, and
    /// when each resets.
    pub(super) fn limited_until(self, acp: &AcpManager) -> HashMap<String, SystemTime> {
        match self {
            Self::Claude => acp.claude_limit().map(ClaudeLimitHandle::limited_until),
            Self::Codex => acp.codex_limit().map(CodexLimitHandle::limited_until),
            Self::Antigravity => acp
                .antigravity_limit()
                .map(AntigravityLimitHandle::limited_until),
        }
        .unwrap_or_default()
    }

    /// Write `account_id` as the chat's own Account, so the limit supervisor
    /// moves the chat alone.
    pub(super) async fn pin(
        self,
        acp: &AcpManager,
        project_id: &str,
        chat_id: &str,
        account_id: &str,
    ) -> Result<bool, String> {
        let account = Some(account_id);
        match self {
            Self::Claude => {
                acp.claude_agent()
                    .set_chat_account(project_id, chat_id, account, None, SignInCheck::Skip)
                    .await
            }
            Self::Codex => {
                acp.codex_agent()
                    .set_chat_account(project_id, chat_id, account, None, CodexSignInCheck::Skip)
                    .await
            }
            Self::Antigravity => {
                acp.antigravity_agent()
                    .set_chat_account(
                        project_id,
                        chat_id,
                        account,
                        None,
                        AntigravitySignInCheck::Skip,
                    )
                    .await
            }
        }
    }
}

fn named(id: &str, name: &str) -> AccountRef {
    AccountRef {
        id: id.to_string(),
        name: name.to_string(),
    }
}
