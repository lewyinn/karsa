use std::sync::Arc;

use super::{AntigravityAgentService, AntigravitySignInCheck, FixedLogins};
use crate::acp::antigravity_accounts::{strip_signed_out_tag, AntigravityAccountStore};
use crate::acp::antigravity_agent::{ANTIGRAVITY_ACP_CONFIG_ID, GEMINI_HOME_ENV};
use crate::acp::config::AgentConfig;

fn host(signed_out: &[&str]) -> (tempfile::TempDir, AntigravityAgentService, Arc<FixedLogins>) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(AntigravityAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let probe = Arc::new(FixedLogins::new(signed_out));
    let service = AntigravityAgentService::with_probe(
        Arc::clone(&store),
        probe.clone() as Arc<dyn crate::acp::antigravity_agent::AntigravityLoginStatus>,
    );
    (root, service, probe)
}

fn antigravity_config() -> AgentConfig {
    AgentConfig {
        config_id: Some(ANTIGRAVITY_ACP_CONFIG_ID.to_string()),
        name: "Antigravity".to_string(),
        command: "agy_acp_server".to_string(),
        args: vec![],
        env: [("GEMINI_API_KEY".to_string(), "gm-test".to_string())]
            .into_iter()
            .collect(),
        allow_terminal: false,
    }
}

#[tokio::test]
async fn the_snapshot_reports_each_home_login_and_no_secret() {
    let (_root, service, _) = host(&["default"]);
    let work = service.insert_profile("Work").unwrap();
    let snapshot = service.profile_list().await.unwrap();
    let text = serde_json::to_string(&snapshot).unwrap();
    assert!(!text.to_ascii_lowercase().contains("token"));
    assert!(!text.contains("sk-"));
    let signed_in = |id: &str| {
        snapshot
            .profiles
            .iter()
            .find(|row| row.id == id)
            .unwrap()
            .signed_in
    };
    assert_eq!(signed_in("default"), Some(false));
    assert_eq!(signed_in(&work.id), Some(true));
    assert!(!snapshot.auto_switch);
}

#[tokio::test]
async fn choosing_a_signed_out_account_leaves_the_store_unchanged() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(AntigravityAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let work = store.add("Work").unwrap();
    let service = AntigravityAgentService::with_probe(
        Arc::clone(&store),
        Arc::new(FixedLogins::new(&[work.id.as_str()]))
            as Arc<dyn crate::acp::antigravity_agent::AntigravityLoginStatus>,
    );
    let error = service
        .set_project_account(
            "office",
            Some(&work.id),
            None,
            AntigravitySignInCheck::Required,
        )
        .await
        .unwrap_err();
    assert_eq!(
        strip_signed_out_tag(&error),
        Some(
            "The Antigravity account \"Work\" is not signed in. Sign in to it in Settings → Provider, then choose it again."
        )
    );
    assert!(service
        .set_default_account(&work.id, AntigravitySignInCheck::Required)
        .await
        .unwrap_err()
        .contains("ACP_ANTIGRAVITY_ACCOUNT_SIGNED_OUT"));
    assert!(store.snapshot().unwrap().project_profiles.is_empty());
    assert_eq!(store.snapshot().unwrap().default_account_id, "default");
    assert!(service
        .set_default_account(&work.id, AntigravitySignInCheck::Skip)
        .await
        .is_ok());
    assert_eq!(store.snapshot().unwrap().default_account_id, work.id);
}

#[tokio::test]
async fn an_expected_account_loses_before_the_sign_in_probe() {
    let (_root, service, _) = host(&[]);
    let work = service.insert_profile("Work").unwrap();
    assert!(service
        .set_project_account(
            "office",
            Some(&work.id),
            Some("default"),
            AntigravitySignInCheck::Required
        )
        .await
        .unwrap());
    let applied = service
        .set_project_account(
            "office",
            None,
            Some("default"),
            AntigravitySignInCheck::Required,
        )
        .await
        .unwrap();
    assert!(!applied);
}

#[tokio::test]
async fn remove_signs_out_that_home_then_moves_projects() {
    let (root, service, probe) = host(&[]);
    let work = service.insert_profile("Work").unwrap();
    service
        .set_project_account(
            "office",
            Some(&work.id),
            None,
            AntigravitySignInCheck::Required,
        )
        .await
        .unwrap();
    let moved = service.remove_account(&work.id).await.unwrap();
    assert_eq!(moved.moved_project_ids, vec!["office".to_string()]);
    assert!(moved.moved_chat_ids.is_empty());
    let logouts = probe.logouts.lock().unwrap().clone();
    assert_eq!(
        logouts[0].as_deref(),
        Some(
            root.path()
                .join("antigravity-accounts")
                .join(&work.id)
                .as_path()
        )
    );
    assert!(!service.has_account(&work.id).unwrap());
    assert!(service.remove_account("default").await.is_err());
    assert_eq!(probe.logouts.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn sign_in_spawn_sets_the_account_home_without_a_login_check() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(AntigravityAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let work = store.add("Work").unwrap();
    let probe = Arc::new(FixedLogins::new(&[work.id.as_str()]));
    let service = AntigravityAgentService::with_probe(
        store,
        probe.clone() as Arc<dyn crate::acp::antigravity_agent::AntigravityLoginStatus>,
    );
    let mut config = antigravity_config();
    service
        .prepare_sign_in_config(&mut config, &work.id)
        .await
        .unwrap();
    assert!(probe.logouts.lock().unwrap().is_empty());
    assert!(!config.env.contains_key("GEMINI_API_KEY"));
    assert_eq!(
        config
            .env
            .get(crate::acp::antigravity_agent::FORCE_FILE_STORAGE_ENV)
            .map(String::as_str),
        Some("1")
    );
    let home = config.env.get(GEMINI_HOME_ENV).unwrap();
    assert!(home.ends_with(&work.id));
    assert!(std::path::Path::new(home).is_dir());
    config.config_id = Some("acp-registry:claude-acp".to_string());
    assert!(service
        .prepare_sign_in_config(&mut config, &work.id)
        .await
        .is_err());
}

#[tokio::test]
async fn the_built_in_sign_in_spawn_does_not_set_antigravity_home() {
    let (_root, service, _) = host(&["default"]);
    let mut config = antigravity_config();
    config
        .env
        .insert(GEMINI_HOME_ENV.to_string(), "/tmp/other".to_string());
    service
        .prepare_sign_in_config(&mut config, "default")
        .await
        .unwrap();
    assert!(!config.env.contains_key(GEMINI_HOME_ENV));
    assert!(!config.env.contains_key("GEMINI_API_KEY"));
    // The built-in Account keeps the host login store (the macOS keychain).
    assert!(!config
        .env
        .contains_key(crate::acp::antigravity_agent::FORCE_FILE_STORAGE_ENV));
}

#[test]
fn a_missing_account_cannot_start_a_terminal_login() {
    let (_root, service, _) = host(&[]);
    let error = service.run_account_cli_login("ffff").unwrap_err();
    assert_eq!(error, "That Antigravity account does not exist");
}

struct FlipDefault {
    store: Arc<AntigravityAccountStore>,
    flipped: std::sync::atomic::AtomicBool,
}

#[async_trait::async_trait]
impl crate::acp::antigravity_agent::AntigravityLoginStatus for FlipDefault {
    async fn login_status(
        &self,
        _antigravity_home: Option<&std::path::Path>,
    ) -> Result<Option<bool>, String> {
        if !self.flipped.swap(true, std::sync::atomic::Ordering::SeqCst) {
            let other = self.store.add("Other").unwrap();
            self.store.set_default(&other.id).unwrap();
        }
        Ok(Some(true))
    }
}

#[tokio::test]
async fn following_the_default_refuses_when_it_changes_during_the_check() {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(AntigravityAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let work = store.add("Work").unwrap();
    store
        .set_project_account("office", Some(&work.id), None)
        .unwrap();
    let service = AntigravityAgentService::with_probe(
        Arc::clone(&store),
        Arc::new(FlipDefault {
            store: Arc::clone(&store),
            flipped: std::sync::atomic::AtomicBool::new(false),
        }),
    );
    let error = service
        .set_project_account("office", None, None, AntigravitySignInCheck::Required)
        .await
        .unwrap_err();
    assert!(
        error.contains("changed while its sign-in was checked"),
        "{error}"
    );
    let snapshot = store.snapshot().unwrap();
    assert_eq!(
        snapshot.project_profiles.get("office").map(String::as_str),
        Some(work.id.as_str())
    );
}

#[test]
fn a_terminal_login_points_to_the_troupe_ui() {
    let (_root, service, _) = host(&[]);
    let error = service.run_account_cli_login("default").unwrap_err();
    assert_eq!(error, super::CLI_LOGIN_UNSUPPORTED);
    assert!(
        error.contains("Settings → Provider → Antigravity"),
        "{error}"
    );
}

/// A host whose store holds one placeholder account and one named "Work";
/// `placeholder_signed_in` sets the placeholder's login, and both show an email.
fn host_with_placeholder(
    placeholder_signed_in: bool,
) -> (tempfile::TempDir, AntigravityAgentService) {
    let root = tempfile::tempdir().unwrap();
    let store = Arc::new(AntigravityAccountStore::new(
        root.path(),
        root.path().join("shared"),
    ));
    let placeholder = store.add("New account").unwrap().id;
    let work = store.add("Work").unwrap().id;
    let signed_out: Vec<&str> = if placeholder_signed_in {
        vec![]
    } else {
        vec![placeholder.as_str()]
    };
    let probe = FixedLogins::new(&signed_out)
        .with_label(&placeholder, "me@example.com")
        .with_label(&work, "other@example.com");
    let service = AntigravityAgentService::with_probe(
        store,
        Arc::new(probe) as Arc<dyn crate::acp::antigravity_agent::AntigravityLoginStatus>,
    );
    (root, service)
}

#[tokio::test]
async fn a_signed_in_placeholder_account_takes_its_email_as_name() {
    let (_root, service) = host_with_placeholder(true);
    let snapshot = service.profile_list().await.unwrap();
    let names: Vec<&str> = snapshot.profiles.iter().map(|row| row.name.as_str()).collect();
    assert!(names.contains(&"me@example.com"), "placeholder takes the email");
    assert!(names.contains(&"Work"), "a chosen name is never replaced");
    assert!(!names.contains(&"other@example.com"));

    // The email was stored, so a second listing keeps it.
    let again = service.profile_list().await.unwrap();
    assert!(again.profiles.iter().any(|row| row.name == "me@example.com"));
}

#[tokio::test]
async fn a_signed_out_placeholder_account_keeps_its_placeholder_name() {
    let (_root, service) = host_with_placeholder(false);
    let snapshot = service.profile_list().await.unwrap();
    assert!(snapshot.profiles.iter().any(|row| row.name == "New account"));
}

#[test]
fn placeholder_names_match_only_the_generated_shapes() {
    use super::is_placeholder_name;
    assert!(is_placeholder_name("New account"));
    assert!(is_placeholder_name("New account 2"));
    assert!(!is_placeholder_name("New account x"));
    assert!(!is_placeholder_name("New accounts"));
    assert!(!is_placeholder_name("Work"));
}
