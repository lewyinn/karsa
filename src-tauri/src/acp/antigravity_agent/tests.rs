use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::{
    effective_home, AntigravityAgentService, AntigravityLaunchAuth, HomeSource,
    ANTIGRAVITY_ACP_CONFIG_ID, FORCE_FILE_STORAGE_ENV, GEMINI_HOME_ENV,
    STRIP_ANTIGRAVITY_API_CREDENTIALS,
};
use crate::acp::antigravity_accounts::{strip_signed_out_tag, AntigravityAccountStore};
use crate::acp::claude_agent::LaunchChat;
use crate::acp::config::AgentConfig;
use crate::acp::config::SessionId;

/// Records each probed home. A home equal to `signed_out` reports signed out.
struct RecordingProbe {
    probed: parking_lot::Mutex<Vec<Option<PathBuf>>>,
    signed_out: Option<PathBuf>,
    /// The host home (`None`) reports signed out.
    host_signed_out: bool,
    /// The probe cannot read the login.
    unavailable: bool,
    /// When set, the probe checks the directory already exists.
    require_dir: bool,
}

#[async_trait::async_trait]
impl super::AntigravityLoginStatus for RecordingProbe {
    async fn login_status(&self, antigravity_home: Option<&Path>) -> Result<Option<bool>, String> {
        if self.require_dir {
            let dir = antigravity_home.expect("a created home");
            assert!(
                dir.is_dir(),
                "Antigravity home must exist before the login probe"
            );
        }
        self.probed
            .lock()
            .push(antigravity_home.map(Path::to_path_buf));
        if self.unavailable {
            return Ok(None);
        }
        let signed_out = match antigravity_home {
            None => self.host_signed_out,
            Some(dir) => self.signed_out.as_deref() == Some(dir),
        };
        Ok(Some(!signed_out))
    }
}

struct Host {
    root: tempfile::TempDir,
    service: AntigravityAgentService,
    accounts: Arc<AntigravityAccountStore>,
    runtime: Arc<RecordingProbe>,
}

fn host(signed_out: impl FnOnce(&AntigravityAccountStore) -> Option<PathBuf>) -> Host {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let accounts = Arc::new(AntigravityAccountStore::new(
        &state,
        root.path().join("shared"),
    ));
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: signed_out(&accounts),
        host_signed_out: false,
        unavailable: false,
        require_dir: false,
    });
    let service = AntigravityAgentService::with_probe(Arc::clone(&accounts), runtime.clone());
    Host {
        root,
        service,
        accounts,
        runtime,
    }
}

fn managed() -> AgentConfig {
    AgentConfig {
        config_id: Some(ANTIGRAVITY_ACP_CONFIG_ID.to_string()),
        name: "Antigravity".to_string(),
        command: "agy_acp_server".to_string(),
        args: Vec::new(),
        env: HashMap::from([
            ("GEMINI_API_KEY".to_string(), "gm-test".to_string()),
            ("GOOGLE_API_KEY".to_string(), "goog-test".to_string()),
        ]),
        allow_terminal: false,
    }
}

fn with_home(dir: &str) -> AgentConfig {
    let mut config = managed();
    config
        .env
        .insert(GEMINI_HOME_ENV.to_string(), dir.to_string());
    config
}

#[tokio::test]
async fn a_project_account_exports_its_home_strips_keys_and_probes_that_login() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let dir = h.accounts.config_dir(&work.id).unwrap();

    let mut config = managed();
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get(GEMINI_HOME_ENV).map(String::as_str),
        dir.to_str()
    );
    assert!(!config.env.contains_key("GEMINI_API_KEY"));
    assert!(!config.env.contains_key("GOOGLE_API_KEY"));
    assert_eq!(
        config
            .env
            .get(STRIP_ANTIGRAVITY_API_CREDENTIALS)
            .map(String::as_str),
        Some("1")
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(dir.clone())]);
    assert_eq!(
        config.env.get(FORCE_FILE_STORAGE_ENV).map(String::as_str),
        Some("1")
    );
    assert!(dir.join("antigravity-acp").join("conversations").is_dir());
}

#[tokio::test]
async fn a_chat_exports_its_own_home_and_a_sibling_keeps_the_project_home() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    let spare = h.accounts.add("Spare").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    h.accounts
        .set_chat_account("office", "chat-1", Some(&spare.id), None)
        .unwrap();
    let spare_dir = h.accounts.config_dir(&spare.id).unwrap();
    let work_dir = h.accounts.config_dir(&work.id).unwrap();

    let mut own = managed();
    let auth = h
        .service
        .prepare_managed_launch(
            &mut own,
            Some("office"),
            &LaunchChat::Existing(SessionId("chat-1".to_string())),
        )
        .await
        .unwrap();
    assert_eq!(auth, AntigravityLaunchAuth::Account(spare.id.clone()));
    assert_eq!(
        own.env.get(GEMINI_HOME_ENV).map(String::as_str),
        spare_dir.to_str()
    );

    let mut follow = managed();
    h.service
        .prepare_managed_launch(
            &mut follow,
            Some("office"),
            &LaunchChat::Existing(SessionId("chat-2".to_string())),
        )
        .await
        .unwrap();
    assert_eq!(
        follow.env.get(GEMINI_HOME_ENV).map(String::as_str),
        work_dir.to_str()
    );
}

#[tokio::test]
async fn the_builtin_account_skips_the_login_check_and_keeps_api_keys() {
    let h = host(|_| None);
    let mut config = with_home("relative/home");
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(!config.env.contains_key(GEMINI_HOME_ENV));
    assert_eq!(
        config.env.get("GEMINI_API_KEY").map(String::as_str),
        Some("gm-test")
    );
    assert_eq!(
        config.env.get("GOOGLE_API_KEY").map(String::as_str),
        Some("goog-test")
    );
    assert!(!config.env.contains_key(STRIP_ANTIGRAVITY_API_CREDENTIALS));
    assert!(!config.env.contains_key(FORCE_FILE_STORAGE_ENV));
    assert!(h.runtime.probed.lock().is_empty());
}

#[tokio::test]
async fn a_signed_out_project_account_names_the_account_and_leaves_env_unchanged() {
    let h = host(|accounts| {
        let work = accounts.add("Work").unwrap();
        accounts
            .set_project_account("office", Some(&work.id), None)
            .unwrap();
        accounts.config_dir(&work.id)
    });
    let mut config = managed();
    let error = h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert_eq!(
        strip_signed_out_tag(&error),
        Some(
            "The Antigravity account \"Work\" is not signed in. Sign in to it in Settings → Provider → Antigravity, then retry."
        )
    );
    assert!(!config.env.contains_key(GEMINI_HOME_ENV));
    assert_eq!(
        config.env.get("GEMINI_API_KEY").map(String::as_str),
        Some("gm-test")
    );
}

#[tokio::test]
async fn a_project_env_home_overrides_the_linked_account() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let override_home = h.root.path().join("antigravity-work-home");
    let mut config = with_home(override_home.to_str().unwrap());
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get(GEMINI_HOME_ENV).map(String::as_str),
        override_home.to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(override_home)]);
    assert_eq!(
        config.env.get(FORCE_FILE_STORAGE_ENV).map(String::as_str),
        Some("1")
    );
    assert!(!config.env.contains_key("GEMINI_API_KEY"));
    assert!(!config.env.contains_key("GOOGLE_API_KEY"));
}

#[tokio::test]
async fn a_signed_out_project_env_home_names_the_project_env() {
    let root = tempfile::tempdir().unwrap();
    let override_home = root.path().join("antigravity-signed-out-home");
    let h = host(|_| Some(override_home.clone()));
    let mut config = with_home(override_home.to_str().unwrap());
    let error = h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert_eq!(
        strip_signed_out_tag(&error),
        Some("The Antigravity profile set by GEMINI_HOME in the project environment is not signed in. Sign in with that GEMINI_HOME, then retry.")
    );
}

#[tokio::test]
async fn a_relative_project_env_home_falls_back_to_the_account_dir() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let account_dir = h.accounts.config_dir(&work.id).unwrap();
    let mut config = with_home("relative/dir");
    assert!(h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get(GEMINI_HOME_ENV).map(String::as_str),
        account_dir.to_str()
    );
    assert_eq!(h.runtime.probed.lock().as_slice(), &[Some(account_dir)]);
}

#[tokio::test]
async fn the_home_directory_exists_before_the_login_probe() {
    let root = tempfile::tempdir().unwrap();
    let state = root.path().join("state");
    let accounts = Arc::new(AntigravityAccountStore::new(
        &state,
        root.path().join("shared"),
    ));
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: None,
        host_signed_out: false,
        unavailable: false,
        require_dir: true,
    });
    let service = AntigravityAgentService::with_probe(accounts, runtime);
    let home = root.path().join("brand-new-home");
    assert!(!home.exists());
    let mut config = with_home(home.to_str().unwrap());
    assert!(service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(home.is_dir());
}

#[test]
fn a_tilde_project_env_home_resolves_under_home() {
    let home = std::env::temp_dir().join("home-of-me");
    let env = HashMap::from([(GEMINI_HOME_ENV.to_string(), "~/.gemini-work".to_string())]);
    let (dir, source) = effective_home(&env, None, Some(&home));
    assert_eq!(dir, Some(home.join(".gemini-work")));
    assert_eq!(source, HomeSource::ProjectEnv);
    let env = HashMap::from([(GEMINI_HOME_ENV.to_string(), "~".to_string())]);
    let (dir, _) = effective_home(&env, None, Some(&home));
    assert_eq!(dir, Some(home));
}

#[test]
fn a_tilde_project_env_home_without_a_home_is_ignored() {
    let env = HashMap::from([(GEMINI_HOME_ENV.to_string(), "~/.gemini-work".to_string())]);
    let (dir, source) = effective_home(&env, None, None);
    assert_eq!(dir, None);
    assert_eq!(source, HomeSource::Host);
}

#[tokio::test]
async fn a_signed_out_builtin_account_still_starts() {
    let root = tempfile::tempdir().unwrap();
    let accounts = Arc::new(AntigravityAccountStore::new(
        &root.path().join("state"),
        root.path().join("shared"),
    ));
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: None,
        host_signed_out: true,
        unavailable: true,
        require_dir: false,
    });
    let service = AntigravityAgentService::with_probe(accounts, runtime.clone());
    let mut config = managed();
    assert!(service
        .prepare_managed_config_for_project(&mut config, None)
        .await
        .unwrap());
    assert!(runtime.probed.lock().is_empty());
    assert_eq!(
        config.env.get("GEMINI_API_KEY").map(String::as_str),
        Some("gm-test")
    );
}

#[tokio::test]
async fn an_unreadable_login_for_a_linked_account_is_not_a_signed_out_error() {
    let root = tempfile::tempdir().unwrap();
    let accounts = Arc::new(AntigravityAccountStore::new(
        &root.path().join("state"),
        root.path().join("shared"),
    ));
    let work = accounts.add("Work").unwrap();
    accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: None,
        host_signed_out: false,
        unavailable: true,
        require_dir: false,
    });
    let service = AntigravityAgentService::with_probe(Arc::clone(&accounts), runtime);
    let mut config = managed();
    let error = service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert!(
        strip_signed_out_tag(&error).is_none(),
        "an unreadable login must not look like a signed-out account: {error}"
    );
    assert!(error.contains("could not be read"), "{error}");
}

#[tokio::test]
async fn another_agent_keeps_its_api_key_and_antigravity_home() {
    let h = host(|_| None);
    let mut config = managed();
    config.config_id = Some("acp-registry:claude-acp".to_string());
    config
        .env
        .insert(GEMINI_HOME_ENV.to_string(), "/tmp/keep".to_string());
    assert!(!h
        .service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert_eq!(
        config.env.get("GEMINI_API_KEY").map(String::as_str),
        Some("gm-test")
    );
    assert_eq!(
        config.env.get(GEMINI_HOME_ENV).map(String::as_str),
        Some("/tmp/keep")
    );
    assert!(h.runtime.probed.lock().is_empty());
}

#[tokio::test]
async fn an_inactive_service_does_not_prepare_antigravity() {
    let service = AntigravityAgentService::without_host_state();
    let mut config = managed();
    assert!(!service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap());
    assert!(config.env.contains_key("GEMINI_API_KEY"));
}

#[tokio::test]
async fn an_unreadable_login_leaves_the_env_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let accounts = Arc::new(AntigravityAccountStore::new(
        &root.path().join("state"),
        root.path().join("shared"),
    ));
    let work = accounts.add("Work").unwrap();
    accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let runtime = Arc::new(RecordingProbe {
        probed: parking_lot::Mutex::new(Vec::new()),
        signed_out: None,
        host_signed_out: false,
        unavailable: true,
        require_dir: false,
    });
    let service = AntigravityAgentService::with_probe(accounts, runtime);
    let mut config = managed();
    let error = service
        .prepare_managed_config_for_project(&mut config, Some("office"))
        .await
        .unwrap_err();
    assert!(strip_signed_out_tag(&error).is_none(), "{error}");
    assert!(error.contains("Antigravity sign-in"), "{error}");
    assert!(!config.env.contains_key(FORCE_FILE_STORAGE_ENV));
    assert!(!config.env.contains_key(STRIP_ANTIGRAVITY_API_CREDENTIALS));
}

#[tokio::test]
async fn a_codex_or_claude_config_is_never_given_a_gemini_home() {
    let h = host(|_| None);
    let work = h.accounts.add("Work").unwrap();
    h.accounts
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    for config_id in [
        "acp-registry:codex-acp",
        "acp-registry:claude-acp",
        "custom",
    ] {
        let mut config = managed();
        config.config_id = Some(config_id.to_string());
        let auth = h
            .service
            .prepare_managed_launch(&mut config, Some("office"), &LaunchChat::None)
            .await
            .unwrap();
        assert_eq!(auth, AntigravityLaunchAuth::Unmanaged);
        assert!(!config.env.contains_key(GEMINI_HOME_ENV));
        assert!(!config.env.contains_key(FORCE_FILE_STORAGE_ENV));
    }
}

#[test]
fn host_auth_ready_is_false_for_unverified_builtin_account_and_true_for_verified_homes() {
    assert!(!AntigravityLaunchAuth::Unmanaged.host_auth_ready());
    assert!(!AntigravityLaunchAuth::Account("default".to_string()).host_auth_ready());
    assert!(AntigravityLaunchAuth::Account("work".to_string()).host_auth_ready());
    assert!(AntigravityLaunchAuth::Fixed.host_auth_ready());
}
