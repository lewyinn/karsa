//! Antigravity Account operations on [`AntigravityAgentService`]: the store
//! calls, the per-home login probe, deleting the login on remove, and the
//! Google sign-in spawn that skips the signed-out gate.

use std::path::PathBuf;
use std::sync::Arc;

use super::{
    apply_managed_home_env, set_home_env, strip_api_credentials, AntigravityAgentService,
    ANTIGRAVITY_ACP_CONFIG_ID,
};
use crate::acp::antigravity_accounts::{
    signed_out_error, AntigravityAccount, AntigravityAccountStore, AntigravityAccountsSnapshot,
    RemovedAccount, BUILTIN_ACCOUNT_ID,
};
use crate::acp::config::AgentConfig;

/// What `troupe-server antigravity account login` prints: there is no
/// terminal sign-in for Antigravity.
pub const CLI_LOGIN_UNSUPPORTED: &str = "Antigravity has no terminal sign-in. Sign in to this account from Settings → Provider → Antigravity in the Karsa app or the Karsa web UI.";

/// Whether choosing an Account first checks that its login is confirmed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AntigravitySignInCheck {
    /// A switch from the desktop or web UI. The renderer restarts the
    /// Project's open Antigravity chats right after it, and the spawn gate rejects
    /// an Account that is not signed in, so refuse it before anything changes.
    Required,
    /// Headless setup (`troupe-server antigravity account`), where an admin may
    /// choose an Account before it is signed in. Nothing restarts there.
    Skip,
}

/// Which Account a choice names: the one picked, or the Default Account a
/// Project follows.
#[derive(Debug, Clone, Copy)]
enum Choice {
    Account,
    FollowDefault,
    FollowProject,
}

impl AntigravityAgentService {
    /// The host state directory, when this service has an account store.
    #[must_use]
    pub fn state_dir(&self) -> Option<&std::path::Path> {
        self.profile_store.as_ref().map(|store| store.state_dir())
    }

    pub(super) fn account_store(&self) -> Result<&Arc<AntigravityAccountStore>, String> {
        self.profile_store
            .as_ref()
            .ok_or_else(|| "Antigravity accounts are not available on this host".to_string())
    }

    /// The Account list with the login state of each home.
    pub async fn accounts_snapshot(&self) -> Result<AntigravityAccountsSnapshot, String> {
        self.profile_list().await
    }

    /// Same list as [`Self::accounts_snapshot`]. The CLI prints these ids, so
    /// this name stays free of the word "account".
    pub async fn profile_list(&self) -> Result<AntigravityAccountsSnapshot, String> {
        let store = self.account_store()?;
        let mut snapshot = store.snapshot()?;
        let dirs: Vec<Option<PathBuf>> = snapshot
            .profiles
            .iter()
            .map(|row| store.config_dir(&row.id))
            .collect();
        let probes = dirs
            .iter()
            .map(|dir| self.login_probe.login_status(dir.as_deref()));
        let states = futures::future::join_all(probes).await;
        for ((row, dir), state) in snapshot.profiles.iter_mut().zip(&dirs).zip(states) {
            row.signed_in = state.unwrap_or_else(|_error| {
                log::warn!("[antigravity-accounts] login probe failed");
                None
            });
            if row.signed_in == Some(true)
                && row.builtin
                && row.name.eq_ignore_ascii_case("Default")
            {
                if let Some(label) = self.login_probe.detected_profile_label(dir.as_deref()) {
                    row.name = label;
                }
            }
            self.usage.observe_login(&row.id, row.signed_in);
        }
        Ok(snapshot)
    }

    pub fn add_account(&self, name: &str) -> Result<AntigravityAccount, String> {
        self.insert_profile(name)
    }

    /// Same as [`Self::add_account`]. The CLI prints the new id, so this name
    /// stays free of the word "account".
    pub fn insert_profile(&self, name: &str) -> Result<AntigravityAccount, String> {
        self.account_store()?.add(name)
    }

    pub fn has_account(&self, id: &str) -> Result<bool, String> {
        Ok(self
            .account_store()?
            .snapshot()?
            .profiles
            .iter()
            .any(|row| row.id == id))
    }

    pub fn rename_account(&self, id: &str, name: &str) -> Result<(), String> {
        self.account_store()?.rename(id, name)
    }

    pub async fn set_default_account(
        &self,
        id: &str,
        check: AntigravitySignInCheck,
    ) -> Result<(), String> {
        let store = self.account_store()?;
        if check == AntigravitySignInCheck::Required {
            self.ensure_signed_in(store, id, Choice::Account).await?;
        }
        store.set_default(id)
    }

    pub fn set_auto_switch(&self, enabled: bool) -> Result<(), String> {
        self.account_store()?.set_auto_switch(enabled)
    }

    /// `account_id: None` returns the Project to the Default Account, so the
    /// check probes the Default Account. `expected` makes the choice a
    /// compare-and-set. Returns whether the choice applied.
    pub async fn set_project_account(
        &self,
        project_id: &str,
        account_id: Option<&str>,
        expected: Option<&str>,
        check: AntigravitySignInCheck,
    ) -> Result<bool, String> {
        let store = self.account_store()?;
        if let Some(expected) = expected {
            let snapshot = store.snapshot()?;
            let current = snapshot
                .project_profiles
                .get(project_id.trim())
                .unwrap_or(&snapshot.default_account_id);
            if current != expected {
                log::info!(
                    "[antigravity-accounts] project profile unchanged: the project no longer uses the expected profile"
                );
                return Ok(false);
            }
        }
        if check == AntigravitySignInCheck::Required {
            match account_id {
                Some(id) => self.ensure_signed_in(store, id, Choice::Account).await?,
                None => {
                    let default_id = store.snapshot()?.default_account_id;
                    self.ensure_signed_in(store, &default_id, Choice::FollowDefault)
                        .await?;
                    let current = store.snapshot()?.default_account_id;
                    if current != default_id {
                        log::info!(
                            "[antigravity-accounts] project profile unchanged: the default account changed during the sign-in check"
                        );
                        return Err(
                            "The default Antigravity account changed while its sign-in was checked. Choose it again."
                                .to_string(),
                        );
                    }
                }
            }
        }
        store.set_project_account(project_id, account_id, expected)
    }

    /// Choose the Account of one chat; `None` makes it follow its Project
    /// again, so the check probes the Account the Project resolves to.
    /// `expected` makes the choice a compare-and-set on the Account the chat
    /// runs on now; returns whether the choice applied.
    pub async fn set_chat_account(
        &self,
        project_id: &str,
        chat_id: &str,
        account_id: Option<&str>,
        expected: Option<&str>,
        check: AntigravitySignInCheck,
    ) -> Result<bool, String> {
        let store = self.account_store()?;
        if let Some(expected) = expected {
            if store
                .snapshot()?
                .account_for(Some(project_id), Some(chat_id))
                != expected
            {
                log::info!(
                    "[antigravity-accounts] chat profile unchanged: the chat no longer uses the expected profile"
                );
                return Ok(false);
            }
        }
        if check == AntigravitySignInCheck::Required {
            match account_id {
                Some(id) => self.ensure_signed_in(store, id, Choice::Account).await?,
                None => {
                    let project_account = store
                        .snapshot()?
                        .account_for(Some(project_id), None)
                        .to_string();
                    self.ensure_signed_in(store, &project_account, Choice::FollowProject)
                        .await?;
                    let current = store
                        .snapshot()?
                        .account_for(Some(project_id), None)
                        .to_string();
                    if current != project_account {
                        log::info!(
                            "[antigravity-accounts] chat profile unchanged: the project account changed during the sign-in check"
                        );
                        return Err(
                            "The project's Antigravity account changed while its sign-in was checked. Choose it again."
                                .to_string(),
                        );
                    }
                }
            }
        }
        store.set_chat_account(project_id, chat_id, account_id, expected)
    }

    /// Drop the Account choice of a deleted chat. A host without Accounts
    /// has none.
    pub fn forget_chat_account(&self, chat_id: &str) {
        let Some(store) = &self.profile_store else {
            return;
        };
        if let Err(error) = store.forget_chat(chat_id) {
            log::warn!("[antigravity-accounts] could not drop the chat profile: {error}");
        }
    }

    /// Only a confirmed login (a token file with a refresh token, or the
    /// built-in Account's keychain entry) may be chosen.
    /// An unknown id passes here; the store setter reports it.
    async fn ensure_signed_in(
        &self,
        store: &AntigravityAccountStore,
        id: &str,
        choice: Choice,
    ) -> Result<(), String> {
        let snapshot = store.snapshot()?;
        let Some(account) = snapshot.profiles.iter().find(|row| row.id == id) else {
            return Ok(());
        };
        let status = self
            .login_probe
            .login_status(store.config_dir(id).as_deref())
            .await;
        if matches!(status, Ok(Some(true))) {
            return Ok(());
        }
        log::warn!(
            "[antigravity-accounts] refused to choose an account that is not signed in (status={status:?})"
        );
        let subject = match choice {
            Choice::FollowDefault => {
                format!("The default Antigravity account \"{}\"", account.name)
            }
            Choice::FollowProject => {
                format!("The project's Antigravity account \"{}\"", account.name)
            }
            Choice::Account => format!("The Antigravity account \"{}\"", account.name),
        };
        let state = if matches!(status, Ok(Some(false))) {
            "is not signed in"
        } else {
            "could not be checked for a sign-in"
        };
        Err(signed_out_error(format!(
            "{subject} {state}. Sign in to it in Settings → Provider, then choose it again."
        )))
    }

    /// Delete the Account's login files, then remove it. A failed
    /// sign-out is logged; the Account is still removed. Returns the Projects
    /// and chats that moved.
    pub async fn remove_account(&self, id: &str) -> Result<RemovedAccount, String> {
        let store = self.account_store()?;
        if id == BUILTIN_ACCOUNT_ID {
            return store.remove(id);
        }
        let known = self.has_account(id)?;
        if let Some(dir) = store.config_dir(id).filter(|_| known) {
            match self.login_probe.logout(Some(dir.as_path())).await {
                Ok(()) => log::info!("[antigravity-accounts] signed out before removal"),
                Err(_error) => log::warn!("[antigravity-accounts] sign-out failed"),
            }
        }
        store.remove(id).inspect(|_| self.usage.forget(id))
    }

    /// Headless `troupe-server antigravity account login`: Antigravity has no
    /// terminal sign-in, so this explains where the Google sign-in happens.
    pub fn run_account_cli_login(&self, id: &str) -> Result<(), String> {
        if !self.has_account(id)? {
            return Err("That Antigravity account does not exist".to_string());
        }
        log::info!("[antigravity-accounts] terminal login refused: sign-in runs in the Karsa UI");
        Err(CLI_LOGIN_UNSUPPORTED.to_string())
    }

    /// Point an Antigravity ACP config at one Account's home and do not require a
    /// login. Chat spawn still uses [`Self::prepare_managed_config_for_project`],
    /// which refuses a signed-out home. This path is only for the sign-in
    /// agent that then runs ACP `authenticate`.
    pub async fn prepare_sign_in_config(
        &self,
        config: &mut AgentConfig,
        account_id: &str,
    ) -> Result<(), String> {
        if !self.active || config.config_id.as_deref() != Some(ANTIGRAVITY_ACP_CONFIG_ID) {
            log::warn!("[antigravity-accounts] sign-in spawn refused: not the Antigravity agent");
            return Err("Sign-in is only available for the Antigravity agent".to_string());
        }
        let store = self.account_store()?;
        if !self.has_account(account_id)? {
            return Err("That Antigravity account does not exist".to_string());
        }
        let home = if account_id == BUILTIN_ACCOUNT_ID {
            None
        } else {
            store.config_dir(account_id)
        };
        if let Some(dir) = &home {
            if let Err(error) = std::fs::create_dir_all(dir) {
                log::warn!(
                    "[antigravity-accounts] could not create Antigravity home before sign-in: {:?}",
                    error.kind()
                );
                return Err("Could not create the Antigravity home folder".to_string());
            }
        }
        if home.is_some() {
            // A linked home keeps its Google login in its own token file.
            apply_managed_home_env(&mut config.env);
        } else {
            // The built-in Account is the host home: no `GEMINI_HOME` and no
            // file-storage flag, the same as a chat spawn. The sign-in still
            // must not pick up a host API key.
            strip_api_credentials(&mut config.env);
            config.env.insert(
                super::STRIP_ANTIGRAVITY_API_CREDENTIALS.to_string(),
                "1".to_string(),
            );
        }
        set_home_env(&mut config.env, home.as_deref())?;
        // A sign-in can change the Google login behind the Account, so the
        // tier and the last check no longer describe it.
        self.usage.forget(account_id);
        log::info!("[antigravity-accounts] sign-in spawn prepared");
        Ok(())
    }
}

/// Login probe for tests: a home directory whose file name is in the list is
/// signed out. The built-in Account (`None`) is signed out when the list
/// contains `default`. Logout calls are recorded and succeed.
#[cfg(test)]
pub(crate) struct FixedLogins {
    signed_out: Vec<String>,
    pub logouts: std::sync::Mutex<Vec<Option<PathBuf>>>,
}

#[cfg(test)]
impl FixedLogins {
    pub(crate) fn new(signed_out: &[&str]) -> Self {
        Self {
            signed_out: signed_out.iter().map(ToString::to_string).collect(),
            logouts: std::sync::Mutex::new(Vec::new()),
        }
    }
}

#[cfg(test)]
#[async_trait::async_trait]
impl super::AntigravityLoginStatus for FixedLogins {
    async fn login_status(
        &self,
        antigravity_home: Option<&std::path::Path>,
    ) -> Result<Option<bool>, String> {
        let id = antigravity_home
            .and_then(|dir| dir.file_name()?.to_str())
            .unwrap_or(BUILTIN_ACCOUNT_ID);
        Ok(Some(!self.signed_out.iter().any(|out| out == id)))
    }

    async fn logout(&self, antigravity_home: Option<&std::path::Path>) -> Result<(), String> {
        self.logouts
            .lock()
            .expect("logout record")
            .push(antigravity_home.map(std::path::Path::to_path_buf));
        Ok(())
    }
}

#[cfg(test)]
impl AntigravityAgentService {
    /// A host store under `state_dir` whose login probe reports the named
    /// homes signed out. `default` is the built-in Account.
    pub(crate) fn with_logins_for_test(state_dir: &std::path::Path, signed_out: &[&str]) -> Self {
        let store = Arc::new(AntigravityAccountStore::new(
            state_dir,
            state_dir.join("shared"),
        ));
        Self::with_probe(
            store,
            Arc::new(FixedLogins::new(signed_out)) as Arc<dyn super::AntigravityLoginStatus>,
        )
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
