//! The Antigravity login probe. Antigravity has no `login status` command, so
//! a home is signed in when one of its Google token files exists and is not
//! empty. The built-in Account on macOS may keep its login in the keychain
//! instead; that entry is looked up without reading the secret. Nothing here
//! logs a path, a token or an account id.

use std::path::{Path, PathBuf};
use std::time::Duration;

use super::AntigravityLoginStatus;
use crate::acp::antigravity_accounts::AntigravityAccountStore;

/// The agent's own directory under a home.
const AGENT_DIR: &str = crate::acp::antigravity_accounts::links::AGENT_DIR;
/// The consumer Google login.
pub(crate) const TOKEN_FILE: &str = "acp_token.json";
/// The Gemini Enterprise login.
pub(crate) const BUSINESS_TOKEN_FILE: &str = "acp_business_token.json";
/// Keychain service and accounts of the agent's macOS login.
const KEYCHAIN_SERVICE: &str = "gemini";
const KEYCHAIN_ACCOUNTS: [&str; 2] = ["antigravity-acp", "antigravity-acp-business"];
const KEYCHAIN_TIMEOUT: Duration = Duration::from_secs(10);

/// The two token files of `home`, consumer first.
pub(crate) fn token_files(home: &Path) -> [PathBuf; 2] {
    let dir = home.join(AGENT_DIR);
    [dir.join(TOKEN_FILE), dir.join(BUSINESS_TOKEN_FILE)]
}

pub(crate) fn token_file_login(home: &Path) -> Option<bool> {
    let mut unreadable = false;
    for path in token_files(home) {
        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() && meta.len() > 0 => return Some(true),
            Ok(meta) if meta.is_file() => {}
            Ok(_) => {
                log::warn!("[antigravity-accounts] a login file is not a file");
                unreadable = true;
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                log::warn!(
                    "[antigravity-accounts] could not check a login file: {:?}",
                    error.kind()
                );
                unreadable = true;
            }
        }
    }
    if unreadable {
        None
    } else {
        Some(false)
    }
}

/// Whether the agent's macOS keychain entry exists. `security` without `-w`
/// neither prints the secret nor prompts. `None` when it could not run.
#[cfg(target_os = "macos")]
pub(crate) async fn keychain_login() -> Option<bool> {
    let mut failed = false;
    for account in KEYCHAIN_ACCOUNTS {
        let mut command = tokio::process::Command::new("/usr/bin/security");
        command
            .args([
                "find-generic-password",
                "-s",
                KEYCHAIN_SERVICE,
                "-a",
                account,
            ])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true);
        match tokio::time::timeout(KEYCHAIN_TIMEOUT, command.status()).await {
            Ok(Ok(status)) if status.success() => return Some(true),
            Ok(Ok(_)) => {}
            Ok(Err(error)) => {
                log::warn!(
                    "[antigravity-accounts] keychain lookup could not start: {:?}",
                    error.kind()
                );
                failed = true;
            }
            Err(_) => {
                log::warn!("[antigravity-accounts] keychain lookup timed out");
                failed = true;
            }
        }
    }
    if failed {
        None
    } else {
        Some(false)
    }
}

#[cfg(not(target_os = "macos"))]
#[allow(clippy::unused_async)]
pub(crate) async fn keychain_login() -> Option<bool> {
    let _ = (KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNTS, KEYCHAIN_TIMEOUT);
    Some(false)
}

pub(super) struct SystemAntigravityLoginProbe;

#[async_trait::async_trait]
impl AntigravityLoginStatus for SystemAntigravityLoginProbe {
    async fn login_status(&self, home: Option<&Path>) -> Result<Option<bool>, String> {
        let Some(dir) = home
            .map(Path::to_path_buf)
            .or_else(AntigravityAccountStore::host_shared_dir)
        else {
            return Ok(None);
        };
        let from_file = token_file_login(&dir);
        if home.is_none() && from_file == Some(false) {
            // The built-in Account runs without the file-storage flag, so on
            // macOS its login is in the keychain.
            return Ok(keychain_login().await);
        }
        Ok(from_file)
    }

    /// Delete the token files of a non-host home. The host home (`None`) is
    /// never signed out here.
    async fn logout(&self, home: Option<&Path>) -> Result<(), String> {
        let Some(dir) = home else {
            return Ok(());
        };
        let mut failed = false;
        for path in token_files(dir) {
            match std::fs::remove_file(&path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => {
                    log::warn!(
                        "[antigravity-accounts] could not delete a login file: {:?}",
                        error.kind()
                    );
                    failed = true;
                }
            }
        }
        if failed {
            Err("Antigravity sign-out did not finish".to_string())
        } else {
            log::info!("[antigravity-accounts] login files deleted");
            Ok(())
        }
    }

    fn detected_profile_label(&self, home: Option<&Path>) -> Option<String> {
        let dir = home
            .map(Path::to_path_buf)
            .or_else(AntigravityAccountStore::host_shared_dir)?;
        read_google_active_label(&dir)
    }
}

/// Read the active Google email from `<home>/google_accounts.json` (`active`
/// field only — never reads or logs tokens).
pub(crate) fn read_google_active_label(home: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(home.join("google_accounts.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let active = value.get("active")?.as_str()?.trim();
    if active.is_empty() || !active.contains('@') {
        return None;
    }
    Some(active.to_string())
}

#[cfg(test)]
#[path = "login_tests.rs"]
mod tests;
