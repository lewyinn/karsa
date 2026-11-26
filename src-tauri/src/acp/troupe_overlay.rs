//! Karsa's own ACP registry overlay (`troupe.json`, published from the
//! `troupe-acp-registry` repository).
//!
//! The official ACP registry stays the source of agents, versions and launch
//! commands. This overlay only adds presentation (display names, logos, brand
//! colours, hidden flags) and agents the official registry does not list.
//! Presentation from any copy applies by default. Agents carry launch
//! commands, so only the bundled copy's agents join the catalog by default; a
//! network or cached copy's agents join once the user opts in to the CDN
//! registry ([`TroupeOverlayService::launchable_agents`]).
//! The fetch is on by default and never blocks a caller that does not ask to
//! wait: the catalog reads the overlay it already holds and refreshes it in
//! the background.
//!
//! Precedence: a fresh network copy, then the on-disk cache
//! (`<catalog root>/troupe-overlay-cache.json`), then the copy built into this
//! binary (`src/renderer/assets/agent-icons/acp/troupe.json`). A document with
//! an unknown `schemaVersion` is ignored and the overlay already held stays.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::acp_registry_snapshot::{
    fetch_capped_registry_body, is_safe_agent_id, sanitize_distribution, AcpRegistrySnapshotAgent,
};

/// Where the published overlay lives. `TROUPE_ACP_OVERLAY_URL` replaces it
/// (a local server in tests or a staging copy).
pub const DEFAULT_OVERLAY_URL: &str =
    "https://gnoviawan.github.io/troupe-acp-registry/v1/troupe.json";
const OVERLAY_URL_ENV: &str = "TROUPE_ACP_OVERLAY_URL";

const BUNDLED_OVERLAY_JSON: &str =
    include_str!("../../../src/renderer/assets/agent-icons/acp/troupe.json");

const SCHEMA_VERSION: u64 = 1;
const CACHE_FILENAME: &str = "troupe-overlay-cache.json";
/// Same limit as the registry repository's build check.
pub const MAX_ICON_BYTES: usize = 64 * 1024;
const MAX_NAME_CHARS: usize = 64;
/// A held network or cache copy younger than this is served without a fetch.
const CACHE_TTL: Duration = Duration::from_secs(60 * 60);
/// After a failed fetch, no new attempt for this long, so an offline host
/// does not retry on every catalog resolution.
const RETRY_AFTER_FAILURE: Duration = Duration::from_secs(15 * 60);
/// A cached `fetchedAt` further in the future than this counts as expired.
const MAX_CLOCK_SKEW: Duration = Duration::from_secs(60 * 60);

/// Two gradient stops per appearance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrandGradient {
    pub light: [String; 2],
    pub dark: [String; 2],
}

/// The colour a single-colour (`currentColor`) logo is drawn in, per theme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBrandColor {
    pub light: String,
    pub dark: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gradient: Option<AgentBrandGradient>,
}

/// One validated `overrides[]` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOverride {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub hidden: bool,
    /// Raw SVG. The renderer sanitizes it before it renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brand_color: Option<AgentBrandColor>,
}

/// A validated overlay document.
#[derive(Debug, Clone, Default)]
pub struct TroupeOverlay {
    pub overrides: Vec<AgentOverride>,
    pub agents: Vec<AcpRegistrySnapshotAgent>,
}

/// Where the overlay in use came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum OverlaySource {
    Bundled,
    Cache,
    Network,
}

/// The `get_acp_agent_overlay` reply: what the renderer needs to draw agents.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentOverlayPresentation {
    pub overrides: Vec<AgentOverride>,
    pub source: OverlaySource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fetched_at: Option<String>,
}

#[derive(Debug)]
pub enum OverlayError {
    Json(serde_json::Error),
    UnsupportedSchema(Option<u64>),
}

impl std::fmt::Display for OverlayError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(error) => write!(f, "overlay is not JSON: {error}"),
            Self::UnsupportedSchema(Some(version)) => {
                write!(f, "overlay schemaVersion {version} is not supported")
            }
            Self::UnsupportedSchema(None) => write!(f, "overlay has no schemaVersion"),
        }
    }
}

fn warn(message: &str) {
    log::warn!("[acp-overlay] {message}");
    tracing::warn!("[acp-overlay] {message}");
}

fn info(message: &str) {
    log::info!("[acp-overlay] {message}");
    tracing::info!("[acp-overlay] {message}");
}

fn is_hex_color(value: &str) -> bool {
    value
        .strip_prefix('#')
        .is_some_and(|hex| hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()))
}

fn parse_stops(value: Option<&Value>) -> Option<[String; 2]> {
    match value?.as_array()?.as_slice() {
        [from, to] => {
            let (from, to) = (from.as_str()?, to.as_str()?);
            (is_hex_color(from) && is_hex_color(to)).then(|| [from.to_string(), to.to_string()])
        }
        _ => None,
    }
}

fn parse_brand_color(value: &Value) -> Option<AgentBrandColor> {
    let light = value.get("light")?.as_str()?;
    let dark = value.get("dark")?.as_str()?;
    if !is_hex_color(light) || !is_hex_color(dark) {
        return None;
    }
    let gradient = match value.get("gradient") {
        None => None,
        Some(gradient) => Some(AgentBrandGradient {
            light: parse_stops(gradient.get("light"))?,
            dark: parse_stops(gradient.get("dark"))?,
        }),
    };
    Some(AgentBrandColor {
        light: light.to_string(),
        dark: dark.to_string(),
        gradient,
    })
}

/// Why an overlay icon is refused, or `None` when it may ship to the
/// renderer: the size cap, an `<svg>` root with a `viewBox`, and no markup
/// that could restyle the app or reach the network once inlined. The renderer
/// sanitizes again before it draws.
pub fn icon_rejection(svg: &str) -> Option<&'static str> {
    if svg.len() > MAX_ICON_BYTES {
        return Some("over the size cap");
    }
    let lower = svg.to_ascii_lowercase();
    let Some(start) = lower.find("<svg") else {
        return Some("no <svg> root");
    };
    let Some(end) = lower[start..].find('>') else {
        return Some("no <svg> root");
    };
    if !lower[start..start + end].contains("viewbox") {
        return Some("no viewBox on the <svg> root");
    }
    for (tag, reason) in [
        ("<style", "a <style> element"),
        ("<image", "an <image> element"),
        ("<foreignobject", "a <foreignObject> element"),
        ("<script", "a <script> element"),
    ] {
        if lower.contains(tag) {
            return Some(reason);
        }
    }
    if has_anchor_tag(&lower) {
        return Some("an <a> element");
    }
    if has_event_handler(&lower) {
        return Some("an on* event handler");
    }
    if has_external_href(&lower) {
        return Some("an href that is not a #fragment");
    }
    if has_external_url(&lower) {
        return Some("a url() that is not a #fragment");
    }
    None
}

fn is_tag_name_end(byte: Option<&u8>) -> bool {
    byte.is_none_or(|byte| byte.is_ascii_whitespace() || *byte == b'>' || *byte == b'/')
}

fn has_anchor_tag(lower: &str) -> bool {
    lower
        .match_indices("<a")
        .any(|(at, _)| is_tag_name_end(lower.as_bytes().get(at + 2)))
}

/// An attribute named `on<letters>` followed by `=`.
fn has_event_handler(lower: &str) -> bool {
    let bytes = lower.as_bytes();
    lower.match_indices("on").any(|(at, _)| {
        let separated = at > 0 && (bytes[at - 1].is_ascii_whitespace() || bytes[at - 1] == b'/');
        if !separated {
            return false;
        }
        let rest = &bytes[at + 2..];
        let letters = rest
            .iter()
            .take_while(|byte| byte.is_ascii_alphabetic())
            .count();
        letters > 0
            && rest[letters..]
                .iter()
                .find(|byte| !byte.is_ascii_whitespace())
                .is_some_and(|byte| *byte == b'=')
    })
}

/// The first character of a value after skipping whitespace and quotes.
fn value_start(rest: &str) -> Option<char> {
    rest.chars()
        .find(|c| !c.is_ascii_whitespace() && *c != '"' && *c != '\'')
}

/// `href=` / `xlink:href=` whose value does not start with `#`.
fn has_external_href(lower: &str) -> bool {
    lower.match_indices("href").any(|(at, _)| {
        let rest = lower[at + 4..].trim_start();
        rest.strip_prefix('=')
            .is_some_and(|value| value_start(value) != Some('#'))
    })
}

/// `url(` whose argument does not start with `#`.
fn has_external_url(lower: &str) -> bool {
    lower
        .match_indices("url(")
        .any(|(at, _)| value_start(&lower[at + 4..]) != Some('#'))
}

fn parse_override(value: &Value) -> Option<AgentOverride> {
    let id = value.get("id").and_then(Value::as_str)?;
    if !is_safe_agent_id(id) {
        warn(&format!("override dropped: unsafe id {id:?}"));
        return None;
    }
    let name = value
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty() && name.chars().count() <= MAX_NAME_CHARS)
        .map(str::to_string);
    let icon = match value.get("icon").and_then(Value::as_str) {
        Some(svg) => match icon_rejection(svg) {
            None => Some(svg.to_string()),
            Some(reason) => {
                warn(&format!("override {id}: icon dropped ({reason})"));
                None
            }
        },
        None => None,
    };
    let brand_color = match value.get("brandColor") {
        Some(brand) => {
            let parsed = parse_brand_color(brand);
            if parsed.is_none() {
                warn(&format!(
                    "override {id}: brandColor dropped (needs #RRGGBB values)"
                ));
            }
            parsed
        }
        None => None,
    };
    Some(AgentOverride {
        id: id.to_string(),
        name,
        hidden: value
            .get("hidden")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        icon,
        brand_color,
    })
}

fn parse_agent(value: &Value) -> Option<AcpRegistrySnapshotAgent> {
    let id = value.get("id").and_then(Value::as_str)?;
    if !is_safe_agent_id(id) {
        warn(&format!("agent dropped: unsafe id {id:?}"));
        return None;
    }
    let Some(distribution) = value.get("distribution").and_then(sanitize_distribution) else {
        warn(&format!("agent {id} dropped: no distribution object"));
        return None;
    };
    let text = |field: &str| {
        value
            .get(field)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let name = text("name");
    Some(AcpRegistrySnapshotAgent {
        id: id.to_string(),
        name: if name.trim().is_empty() {
            id.to_string()
        } else {
            name
        },
        version: text("version"),
        description: text("description"),
        distribution,
    })
}

/// Validate a parsed overlay document. Bad entries are dropped one by one; a
/// missing or unknown `schemaVersion` rejects the whole document. A repeated
/// id keeps its first entry.
pub fn parse_overlay(document: &Value) -> Result<TroupeOverlay, OverlayError> {
    let version = document.get("schemaVersion").and_then(Value::as_u64);
    if version != Some(SCHEMA_VERSION) {
        return Err(OverlayError::UnsupportedSchema(version));
    }
    let entries = |field: &str| {
        document
            .get(field)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    let mut seen = std::collections::HashSet::new();
    let overrides = entries("overrides")
        .iter()
        .filter_map(parse_override)
        .filter(|entry| seen.insert(entry.id.clone()))
        .collect();
    let mut seen = std::collections::HashSet::new();
    let agents = entries("agents")
        .iter()
        .filter_map(parse_agent)
        .filter(|agent| seen.insert(agent.id.clone()))
        .collect();
    Ok(TroupeOverlay { overrides, agents })
}

fn parse_overlay_bytes(body: &[u8]) -> Result<(Value, TroupeOverlay), OverlayError> {
    let document: Value = serde_json::from_slice(body).map_err(OverlayError::Json)?;
    let overlay = parse_overlay(&document)?;
    Ok((document, overlay))
}

/// The copy built into this binary. It is validated like a remote one; a
/// broken build copy degrades to an empty overlay.
pub fn bundled_overlay() -> TroupeOverlay {
    match parse_overlay_bytes(BUNDLED_OVERLAY_JSON.as_bytes()) {
        Ok((_, overlay)) => overlay,
        Err(error) => {
            warn(&format!("bundled overlay unusable: {error}"));
            TroupeOverlay::default()
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedOverlay {
    fetched_at: String,
    document: Value,
}

/// The overlay held in memory.
#[derive(Debug, Clone)]
pub struct ResolvedOverlay {
    pub overlay: Arc<TroupeOverlay>,
    pub source: OverlaySource,
    pub fetched_at: Option<chrono::DateTime<chrono::Utc>>,
}

impl ResolvedOverlay {
    fn is_fresh(&self, now: chrono::DateTime<chrono::Utc>) -> bool {
        let Some(fetched) = self.fetched_at else {
            return false;
        };
        let age = now.signed_duration_since(fetched);
        let ttl = chrono::Duration::from_std(CACHE_TTL).unwrap_or(chrono::Duration::MAX);
        let skew = chrono::Duration::from_std(MAX_CLOCK_SKEW).unwrap_or(chrono::Duration::MAX);
        age < ttl && -age <= skew
    }

    pub fn presentation(&self) -> AgentOverlayPresentation {
        AgentOverlayPresentation {
            overrides: self.overlay.overrides.clone(),
            source: self.source,
            fetched_at: self.fetched_at.map(|at| at.to_rfc3339()),
        }
    }
}

fn read_cache(path: &Path) -> Option<ResolvedOverlay> {
    let bytes = std::fs::read(path).ok()?;
    let cached: CachedOverlay = match serde_json::from_slice(&bytes) {
        Ok(cached) => cached,
        Err(error) => {
            warn(&format!(
                "cache unreadable, using the bundled overlay: {error}"
            ));
            return None;
        }
    };
    let overlay = match parse_overlay(&cached.document) {
        Ok(overlay) => overlay,
        Err(error) => {
            warn(&format!("cache ignored: {error}"));
            return None;
        }
    };
    let fetched_at = chrono::DateTime::parse_from_rfc3339(&cached.fetched_at)
        .ok()
        .map(|at| at.with_timezone(&chrono::Utc));
    Some(ResolvedOverlay {
        overlay: Arc::new(overlay),
        source: OverlaySource::Cache,
        fetched_at,
    })
}

fn write_cache(path: &Path, document: Value, fetched_at: &str) -> std::io::Result<()> {
    let cached = CachedOverlay {
        fetched_at: fetched_at.to_string(),
        document,
    };
    let bytes = serde_json::to_vec(&cached).map_err(std::io::Error::other)?;
    crate::acp::atomic_file::replace(path, &bytes)
}

/// Fetches the raw overlay body. Injected so tests never touch the network.
pub type OverlayFetch = Arc<dyn Fn() -> BoxFuture<'static, Result<Vec<u8>, String>> + Send + Sync>;

fn overlay_url() -> String {
    std::env::var(OVERLAY_URL_ENV)
        .ok()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_OVERLAY_URL.to_string())
}

fn production_fetch() -> OverlayFetch {
    Arc::new(|| {
        Box::pin(async {
            if cfg!(test) {
                return Err("overlay network fetch is off under test".to_string());
            }
            fetch_capped_registry_body(&overlay_url()).await
        })
    })
}

/// Holds the overlay in use and refreshes it from the network.
pub struct TroupeOverlayService {
    cache_path: PathBuf,
    /// The copy built into this binary, kept for its trusted agents.
    bundled: Arc<TroupeOverlay>,
    fetch: OverlayFetch,
    current: RwLock<ResolvedOverlay>,
    failed_at: Mutex<Option<Instant>>,
    refresh: tokio::sync::Mutex<()>,
}

impl TroupeOverlayService {
    /// Serve the cache under `catalog_root` when it is valid, else the
    /// bundled copy. No network here.
    pub fn open(catalog_root: &Path) -> Self {
        Self::with_fetch(catalog_root, production_fetch())
    }

    pub fn with_fetch(catalog_root: &Path, fetch: OverlayFetch) -> Self {
        let cache_path = catalog_root.join(CACHE_FILENAME);
        let bundled = Arc::new(bundled_overlay());
        let current = read_cache(&cache_path).unwrap_or_else(|| ResolvedOverlay {
            overlay: Arc::clone(&bundled),
            source: OverlaySource::Bundled,
            fetched_at: None,
        });
        info(&format!(
            "ready source={:?} overrides={} agents={}",
            current.source,
            current.overlay.overrides.len(),
            current.overlay.agents.len()
        ));
        Self {
            cache_path,
            bundled,
            fetch,
            current: RwLock::new(current),
            failed_at: Mutex::new(None),
            refresh: tokio::sync::Mutex::new(()),
        }
    }

    /// The overlay in use. No I/O.
    pub fn current(&self) -> ResolvedOverlay {
        self.current.read().clone()
    }

    /// The overlay agents the catalog may list. The bundled copy ships in
    /// this binary and is trusted, so its agents always join. A network or
    /// cached copy could add launch commands, so its agents join only under
    /// the CDN registry opt-in, the same consent the registry itself needs.
    /// They come first so an opted-in newer entry wins over a bundled one.
    pub fn launchable_agents(&self, remote_opt_in: bool) -> Vec<AcpRegistrySnapshotAgent> {
        let current = self.current();
        let mut agents: Vec<AcpRegistrySnapshotAgent> = Vec::new();
        if current.source != OverlaySource::Bundled {
            if remote_opt_in {
                agents.extend(current.overlay.agents.iter().cloned());
            } else if !current.overlay.agents.is_empty() {
                log::debug!(
                    "[acp-overlay] {} remote overlay agent(s) skipped: the CDN registry opt-in is off",
                    current.overlay.agents.len()
                );
            }
        }
        let bundled: Vec<AcpRegistrySnapshotAgent> = self
            .bundled
            .agents
            .iter()
            .filter(|agent| !agents.iter().any(|remote| remote.id == agent.id))
            .cloned()
            .collect();
        agents.extend(bundled);
        agents
    }

    /// Whether a refresh would fetch: the held copy is past its TTL and no
    /// fetch failed in the last [`RETRY_AFTER_FAILURE`].
    pub fn wants_refresh(&self) -> bool {
        if self.current.read().is_fresh(chrono::Utc::now()) {
            return false;
        }
        !matches!(*self.failed_at.lock(), Some(at) if at.elapsed() < RETRY_AFTER_FAILURE)
    }

    /// Fetch a new copy when [`Self::wants_refresh`]. Concurrent callers share
    /// one fetch. Returns `true` when a new network copy is now in use.
    pub async fn refresh_if_stale(&self) -> bool {
        let _single_flight = self.refresh.lock().await;
        if !self.wants_refresh() {
            return false;
        }
        let parsed = match (self.fetch)().await {
            Ok(body) => parse_overlay_bytes(&body).map_err(|error| error.to_string()),
            Err(error) => Err(error),
        };
        let (document, overlay) = match parsed {
            Ok(parsed) => parsed,
            Err(error) => {
                *self.failed_at.lock() = Some(Instant::now());
                let held = self.current.read().source;
                warn(&format!(
                    "refresh failed, keeping the {held:?} overlay: {error}"
                ));
                return false;
            }
        };
        let fetched_at = chrono::Utc::now();
        if let Err(error) = write_cache(&self.cache_path, document, &fetched_at.to_rfc3339()) {
            warn(&format!("cache write failed: {error}"));
        }
        info(&format!(
            "refreshed overrides={} agents={}",
            overlay.overrides.len(),
            overlay.agents.len()
        ));
        *self.failed_at.lock() = None;
        *self.current.write() = ResolvedOverlay {
            overlay: Arc::new(overlay),
            source: OverlaySource::Network,
            fetched_at: Some(fetched_at),
        };
        true
    }
}

#[cfg(test)]
mod tests;
