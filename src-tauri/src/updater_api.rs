//! Desktop-side channel manifest fetch for the nightly updater path.
//!
//! The renderer's `fetchChannelManifest` previously did a `fetch()` to
//! `https://github.com/.../releases/download/...`, which is blocked by CSP
//! (`connect-src` allows only `https://api.github.com`) AND CORS (GitHub
//! release-download assets return no `Access-Control-Allow-Origin`). This
//! module performs the same fetch server-side via reqwest — where CSP/CORS do
//! not apply — and returns the parsed manifest JSON as `IpcResult<Value>`.
//!
//! URL source of truth: [`server_update::UpdateChannel::manifest_url`] —
//! reused (not duplicated) so the desktop command, the standalone server, and
//! the renderer error messages never drift.

use crate::commands::IpcResult;
use crate::server_update::UpdateChannel;

/// Fetch + parse the per-channel manifest.
///
/// Validates `channel` via [`UpdateChannel::parse`] (the single source of
/// truth for the accepted values + URLs), then GETs the manifest with a
/// `User-Agent` + 120s timeout. Returns the parsed manifest JSON, or an
/// `Err(String)` describing the failure (unknown channel, network error,
/// non-2xx, or non-object body).
///
/// No live network is exercised for an unknown channel — the parse fails first.
pub async fn fetch_channel_manifest(channel: &str) -> Result<serde_json::Value, String> {
    let _parsed = UpdateChannel::parse(channel)
        .ok_or_else(|| format!("unknown update channel: {channel}"))?;
    log::info!(
        "[updater] auto-updater is disabled in custom Karsa builds; skipping manifest fetch (channel={channel})"
    );
    Err("auto-updates are disabled in custom Karsa builds".to_string())
}

/// Desktop command: fetch the per-channel update manifest server-side (where
/// CSP/CORS do not apply) and return it as `IpcResult<Value>`. The renderer
/// facade `fetchChannelManifest` invokes this instead of a raw `fetch()` to
/// `github.com`.
///
/// Error codes:
/// - `INVALID_UPDATE_CHANNEL` — `channel` is not `stable`/`nightly`
///   (no network call made).
/// - `NETWORK_ERROR` — reqwest failed to send or receive (DNS, TLS, timeout,
///   connection reset).
/// - `UPDATE_CHECK_FAILED` — the manifest endpoint returned a non-2xx status
///   (e.g. 404 before the channel's first release).
/// - `INVALID_UPDATE_INFO` — the response body is not a JSON object.
#[tauri::command]
pub async fn updater_fetch_channel_manifest(
    channel: String,
) -> Result<IpcResult<serde_json::Value>, String> {
    match fetch_channel_manifest(&channel).await {
        Ok(value) => Ok(IpcResult::success(value)),
        Err(message) => {
            let code = if message.starts_with("unknown update channel") {
                "INVALID_UPDATE_CHANNEL"
            } else if message.contains("network error") {
                "NETWORK_ERROR"
            } else if message.contains("returned HTTP") {
                "UPDATE_CHECK_FAILED"
            } else {
                "INVALID_UPDATE_INFO"
            };
            Ok(IpcResult::error(message, code))
        }
    }
}

/// Manifest URL for channels that update in-app through the signed updater
/// flow. Only Nightly: Stable keeps the build-time `plugins.updater.endpoints`
/// (JS `check()`). The renderer's `checkForUpdates` routes only Nightly here.
pub fn signed_channel_endpoint(channel: UpdateChannel) -> Option<&'static str> {
    match channel {
        UpdateChannel::Nightly => Some(channel.manifest_url()),
        UpdateChannel::Stable => None,
    }
}

/// Validate a renderer-supplied channel for the signed check. No network.
pub fn resolve_signed_channel(channel: &str) -> Result<UpdateChannel, String> {
    let parsed = UpdateChannel::parse(channel)
        .ok_or_else(|| format!("unknown update channel: {channel}"))?;
    if signed_channel_endpoint(parsed).is_none() {
        return Err(format!(
            "update channel {channel} does not support in-app updates through updater_check_channel"
        ));
    }
    Ok(parsed)
}

/// Version gate for the signed channel check.
///
/// Nightly builds are plain `X.Y.N`, where `X.Y.0` is the stable release they
/// follow and N counts the dev commits since it, so SemVer order is build
/// order. A stable install switching to Nightly is offered the next nightly
/// of its own minor, and a nightly install is offered the next stable minor
/// once it ships.
#[allow(dead_code)]
pub fn accepts_channel_update(
    channel: UpdateChannel,
    current: &semver::Version,
    remote: &semver::Version,
) -> bool {
    match channel {
        UpdateChannel::Nightly => remote > current,
        UpdateChannel::Stable => false,
    }
}

/// Mirrors the updater plugin's `check` command response so the renderer can
/// wrap it in the plugin's JS `Update` class (`new Update(metadata)`).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedUpdateMetadata {
    rid: tauri::ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

/// Desktop command: signed in-app update check for a non-stable channel.
///
/// Runs the updater plugin against the channel manifest from
/// [`signed_channel_endpoint`], inheriting the configured pubkey, so the
/// download is signature-verified exactly like Stable. Returns `None` when no
/// acceptable newer build exists. Errors (unsupported channel, unreachable or
/// invalid manifest, no entry for this platform) make the renderer fall back
/// to the manual release-page flow.
#[tauri::command]
pub async fn updater_check_channel<R: tauri::Runtime>(
    webview: tauri::Webview<R>,
    channel: String,
) -> Result<Option<SignedUpdateMetadata>, String> {
    let result = check_signed_channel(&webview, &channel).await;
    if let Err(message) = &result {
        log::warn!(
            "[updater] signed channel check failed channel={channel}, renderer falls back to manual download: {message}"
        );
    }
    result
}

#[allow(clippy::unused_async)]
async fn check_signed_channel<R: tauri::Runtime>(
    _webview: &tauri::Webview<R>,
    channel: &str,
) -> Result<Option<SignedUpdateMetadata>, String> {
    let _parsed = resolve_signed_channel(channel)?;
    log::info!(
        "[updater] auto-updater is disabled in custom Karsa builds; skipping signed channel check (channel={channel})"
    );
    Ok(None)
}

#[cfg(test)]
mod tests;
