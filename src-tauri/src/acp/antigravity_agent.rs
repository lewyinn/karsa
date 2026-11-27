//! Host-managed Antigravity homes for the catalog Antigravity ACP agent
//! (`acp-registry:antigravity-acp`, binary `agy_acp_server`).
//!
//! A Project's Account chooses the `GEMINI_HOME` of that spawn. An absolute
//! `GEMINI_HOME` in the project env wins, then the linked Account directory,
//! then the host home with the variable unset. A managed (non-host) home
//! strips `GEMINI_API_KEY` and `GOOGLE_API_KEY`, so the Google login of that
//! home is what the agent uses, and sets `AGY_ACP_FORCE_FILE_STORAGE=1`: on
//! macOS the agent otherwise keeps every home's login in one keychain entry.
//! The home directory is created before the login check and before the agent
//! process starts.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Antigravity home override. Unset means the host default (`~/.gemini`).
pub use super::antigravity_accounts::GEMINI_HOME_ENV;
use super::antigravity_accounts::{
    signed_out_error, AccountResolution, AntigravityAccountStore, BUILTIN_ACCOUNT_ID,
};
use super::config::AgentConfig;

/// Catalog id of the managed Antigravity ACP agent.
pub const ANTIGRAVITY_ACP_CONFIG_ID: &str = "acp-registry:antigravity-acp";
/// The agent's API-key sign-in.
const GEMINI_API_KEY_ENV: &str = "GEMINI_API_KEY";
/// The Agent Platform (Vertex) sign-in.
const GOOGLE_API_KEY_ENV: &str = "GOOGLE_API_KEY";
/// Makes the agent keep its Google login in `<home>/antigravity-acp/acp_token.json`
/// instead of the one macOS keychain entry every home shares.
pub const FORCE_FILE_STORAGE_ENV: &str = "AGY_ACP_FORCE_FILE_STORAGE";
/// Set on the agent env only as a signal to the spawn path. The child
/// command removes this name and the two credential names from its own
/// environment, including values inherited from the host process.
pub(crate) const STRIP_ANTIGRAVITY_API_CREDENTIALS: &str =
    "TERMUL_STRIP_ANTIGRAVITY_API_CREDENTIALS";
/// The credential names the strip marker removes from the child.
pub(crate) const STRIPPED_CREDENTIALS: &[&str] = &[GEMINI_API_KEY_ENV, GOOGLE_API_KEY_ENV];

/// The Antigravity Account a managed spawn runs on.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AntigravityLaunchAuth {
    /// Not the host Antigravity agent.
    Unmanaged,
    /// A `GEMINI_HOME` in the project env: switching the account would not
    /// change it.
    Fixed,
    Account(String),
}

impl AntigravityLaunchAuth {
    /// `true` when this service applied an Antigravity home.
    #[must_use]
    pub fn applied(&self) -> bool {
        !matches!(self, Self::Unmanaged)
    }

    /// `true` only when the host already verified a login for this launch
    /// (a linked Account or a `GEMINI_HOME` override). The built-in `default`
    /// Account skips the host login probe so in-app ACP `authenticate`
    /// (`oauth-personal`) and auto-retry stay enabled.
    #[must_use]
    pub fn host_auth_ready(&self) -> bool {
        match self {
            Self::Unmanaged => false,
            Self::Fixed => true,
            Self::Account(id) => id != BUILTIN_ACCOUNT_ID,
        }
    }
}

/// Which setting chose the Antigravity home of a managed agent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HomeSource {
    /// The host's own Antigravity home. The spawn leaves `GEMINI_HOME` unset.
    Host,
    /// The directory of the Project's linked Antigravity Account.
    Linked,
    /// An explicit absolute `GEMINI_HOME` in the agent env.
    ProjectEnv,
}

impl HomeSource {
    fn label(self) -> &'static str {
        match self {
            Self::Host => "host",
            Self::Linked => "linked",
            Self::ProjectEnv => "project env",
        }
    }
}

/// The `GEMINI_HOME` a managed Antigravity agent runs with. `None` is the host
/// home (the variable is removed). A blank env value counts as unset. A value
/// that is not absolute, after a leading `~` expands to `home`, is ignored.
fn effective_home(
    env: &HashMap<String, String>,
    linked_dir: Option<&Path>,
    home: Option<&Path>,
) -> (Option<PathBuf>, HomeSource) {
    if let Some(value) = env
        .get(GEMINI_HOME_ENV)
        .filter(|dir| !dir.trim().is_empty())
    {
        match absolute_home(value, home) {
            Some(dir) => return (Some(dir), HomeSource::ProjectEnv),
            None => log::warn!(
                "[acp-antigravity] the project env GEMINI_HOME is not an absolute path and was ignored"
            ),
        }
    }
    match linked_dir {
        Some(dir) => (Some(dir.to_path_buf()), HomeSource::Linked),
        None => (None, HomeSource::Host),
    }
}

/// Expand a leading `~` to `home`, then keep the result only when absolute.
fn absolute_home(value: &str, home: Option<&Path>) -> Option<PathBuf> {
    let is_separator = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let path = match value.strip_prefix('~') {
        Some("") => home?.to_path_buf(),
        Some(rest) if rest.starts_with(is_separator) => {
            home?.join(rest.trim_start_matches(is_separator))
        }
        _ => PathBuf::from(value),
    };
    path.is_absolute().then_some(path)
}

/// The login state of one Antigravity home. `None` is the host's own home
/// (the built-in Account).
#[async_trait::async_trait]
pub(crate) trait AntigravityLoginStatus: Send + Sync {
    async fn login_status(&self, home: Option<&Path>) -> Result<Option<bool>, String>;

    /// Best-effort sign-out of one home. The default does nothing so a test
    /// probe can ignore sign-out.
    async fn logout(&self, _home: Option<&Path>) -> Result<(), String> {
        Ok(())
    }

    /// Best-effort display label (email address) read from non-secret local
    /// profile metadata (e.g. `google_accounts.json`). Test probes return `None`.
    fn detected_profile_label(&self, _home: Option<&Path>) -> Option<String> {
        None
    }
}

mod login;
use login::SystemAntigravityLoginProbe;

/// Shared host-wide Antigravity Account service. Spawn preparation is active
/// only for a service built with [`AntigravityAgentService::system`]. Test
/// managers use [`AntigravityAgentService::without_host_state`] and leave
/// Antigravity spawns unchanged.
pub struct AntigravityAgentService {
    active: bool,
    profile_store: Option<Arc<AntigravityAccountStore>>,
    login_probe: Arc<dyn AntigravityLoginStatus>,
    usage: Arc<usage::UsageBook>,
}

impl AntigravityAgentService {
    /// Account store under the parent of `install_root` (the host state dir),
    /// linking Account directories to the host Antigravity home.
    #[must_use]
    pub fn system(install_root: PathBuf) -> Self {
        let store = install_root
            .parent()
            .zip(AntigravityAccountStore::host_shared_dir())
            .map(|(state_dir, shared)| Arc::new(AntigravityAccountStore::new(state_dir, shared)));
        if store.is_none() {
            log::warn!(
                "[antigravity-accounts] no home directory; only the built-in account is available"
            );
        }
        Self::assemble(true, store, Arc::new(SystemAntigravityLoginProbe))
    }

    /// A service that does not select an Antigravity home. Used by unit-test managers.
    #[must_use]
    pub fn without_host_state() -> Self {
        Self::assemble(false, None, Arc::new(SystemAntigravityLoginProbe))
    }

    fn assemble(
        active: bool,
        profile_store: Option<Arc<AntigravityAccountStore>>,
        login_probe: Arc<dyn AntigravityLoginStatus>,
    ) -> Self {
        Self {
            active,
            profile_store,
            login_probe,
            usage: Arc::default(),
        }
    }

    #[cfg(test)]
    fn with_probe(
        store: Arc<AntigravityAccountStore>,
        login_probe: Arc<dyn AntigravityLoginStatus>,
    ) -> Self {
        Self::assemble(true, Some(store), login_probe)
    }

    fn resolve_account(
        &self,
        project_id: Option<&str>,
        chat: &crate::acp::claude_agent::LaunchChat,
    ) -> AccountResolution {
        match (&self.profile_store, chat) {
            (Some(store), crate::acp::claude_agent::LaunchChat::None) => {
                store.resolve(project_id, None)
            }
            (Some(store), crate::acp::claude_agent::LaunchChat::Existing(chat_id)) => {
                store.resolve(project_id, Some(&chat_id.0))
            }
            (Some(store), crate::acp::claude_agent::LaunchChat::New { account_id }) => {
                store.resolve_id(account_id)
            }
            (None, _) => AccountResolution {
                account_id: BUILTIN_ACCOUNT_ID.to_string(),
                account_name: "Default".to_string(),
                config_dir: None,
            },
        }
    }

    /// Prepare `acp-registry:antigravity-acp` for the Project's Account.
    /// Returns `true` when this service applied an Antigravity home. A chat
    /// that follows its Project uses this. A home that is not signed in fails
    /// before the agent process starts.
    pub async fn prepare_managed_config_for_project(
        &self,
        config: &mut AgentConfig,
        project_id: Option<&str>,
    ) -> Result<bool, String> {
        self.prepare_managed_launch(
            config,
            project_id,
            &crate::acp::claude_agent::LaunchChat::None,
        )
        .await
        .map(|auth| auth.applied())
    }

    /// [`prepare_managed_config_for_project`](Self::prepare_managed_config_for_project)
    /// for a spawn that opens `chat` in `project_id`.
    pub async fn prepare_managed_launch(
        &self,
        config: &mut AgentConfig,
        project_id: Option<&str>,
        chat: &crate::acp::claude_agent::LaunchChat,
    ) -> Result<AntigravityLaunchAuth, String> {
        if !self.active || config.config_id.as_deref() != Some(ANTIGRAVITY_ACP_CONFIG_ID) {
            return Ok(AntigravityLaunchAuth::Unmanaged);
        }
        let account = self.resolve_account(project_id, chat);
        let (home, source) = effective_home(
            &config.env,
            account.config_dir.as_deref(),
            AntigravityAccountStore::host_home_dir().as_deref(),
        );
        if source == HomeSource::ProjectEnv && account.config_dir.is_some() {
            log::info!(
                "[acp-antigravity] the project env GEMINI_HOME overrides the project's linked Antigravity profile"
            );
        }
        if let Some(dir) = &home {
            if let Err(error) = std::fs::create_dir_all(dir) {
                log::warn!(
                    "[acp-antigravity] could not create Antigravity home before spawn: {:?}",
                    error.kind()
                );
                return Err("Could not create the Antigravity home folder".to_string());
            }
        }
        // The built-in Default account is the host Antigravity home. It does
        // not require a login check: an API key in the project env, and the
        // in-app sign-in gate, still work there. A linked account or a
        // project-env GEMINI_HOME does require a Google login.
        if source != HomeSource::Host {
            match self.login_probe.login_status(home.as_deref()).await {
                Ok(Some(true)) => {}
                Ok(Some(false)) => {
                    log::warn!(
                        "[acp-antigravity] managed config rejected: {} profile is not signed in",
                        source.label()
                    );
                    let message = match source {
                        HomeSource::Linked => format!(
                            "The Antigravity account \"{}\" is not signed in. Sign in to it in Settings → Provider → Antigravity, then retry.",
                            account.account_name
                        ),
                        HomeSource::ProjectEnv => "The Antigravity profile set by GEMINI_HOME in the project environment is not signed in. Sign in with that GEMINI_HOME, then retry."
                            .to_string(),
                        HomeSource::Host => unreachable!("the built-in account does not check login"),
                    };
                    return Err(signed_out_error(message));
                }
                Ok(None) => {
                    log::warn!(
                        "[acp-antigravity] managed config rejected: {} profile login could not be checked",
                        source.label()
                    );
                    return Err(
                        "The Antigravity sign-in of this account could not be read. Check the account folder, then retry."
                            .to_string(),
                    );
                }
                Err(error) => {
                    log::warn!("[acp-antigravity] managed config rejected: {error}");
                    return Err(error);
                }
            }
            // Managed homes must not inherit the host API key. The marker tells
            // the spawn path to env_remove the same names from the child.
            apply_managed_home_env(&mut config.env);
        }
        set_home_env(&mut config.env, home.as_deref())?;
        log::info!(
            "[acp-antigravity] managed config uses the {} Antigravity profile",
            source.label()
        );
        Ok(match source {
            HomeSource::ProjectEnv => AntigravityLaunchAuth::Fixed,
            HomeSource::Host | HomeSource::Linked => {
                AntigravityLaunchAuth::Account(account.account_id)
            }
        })
    }
}

fn strip_api_credentials(env: &mut HashMap<String, String>) {
    for name in STRIPPED_CREDENTIALS {
        env.remove(*name);
    }
}

/// A non-host home: strip the API keys (and mark the child to strip them
/// too), and keep the Google login in that home's token file.
fn apply_managed_home_env(env: &mut HashMap<String, String>) {
    strip_api_credentials(env);
    env.insert(
        STRIP_ANTIGRAVITY_API_CREDENTIALS.to_string(),
        "1".to_string(),
    );
    env.insert(FORCE_FILE_STORAGE_ENV.to_string(), "1".to_string());
}

/// Export `home` as `GEMINI_HOME`, or remove the variable for the host home.
fn set_home_env(env: &mut HashMap<String, String>, home: Option<&Path>) -> Result<(), String> {
    match home {
        Some(dir) => {
            let dir = dir.to_str().ok_or_else(|| {
                log::warn!("[acp-antigravity] account home is not valid Unicode");
                "The Antigravity account folder path is not supported".to_string()
            })?;
            let plain = crate::path_validation::strip_verbatim_prefix(dir);
            env.insert(GEMINI_HOME_ENV.to_string(), plain.into_owned());
        }
        None => {
            env.remove(GEMINI_HOME_ENV);
        }
    }
    Ok(())
}

mod accounts;
mod usage;
pub use accounts::{AntigravitySignInCheck, CLI_LOGIN_UNSUPPORTED};
pub use usage::{antigravity_tier_name, check_antigravity_usage};

#[cfg(test)]
#[path = "antigravity_agent/tests.rs"]
mod tests;
