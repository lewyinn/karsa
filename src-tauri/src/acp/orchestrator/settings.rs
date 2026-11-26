//! The orchestrator's settings: host-side truth, one atomic JSON file in
//! the data dir, plus the view/input pair the WS routes read and write.

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::acp::atomic_file;
use crate::acp::orchestrator::agents::REGISTRY_PREFIX;
use crate::acp::orchestrator::profiles::SubagentProfile;

pub const FILE_NAME: &str = "subagent-settings.json";
/// 2 added `models`, 3 added `descriptions`, 4 replaced the per-agent maps
/// with `profiles`. The payload denies unknown fields, so an older host must
/// read a newer file as newer (read-only), not as corrupt.
const SCHEMA_VERSION: u32 = 4;
pub const DEFAULT_MAX_RUNNING: u32 = 4;
pub const DEFAULT_MAX_DEPTH: u8 = 2;

/// Bound validation, shared by `set_settings` and the WS route.
pub const MAX_RUNNING_BOUNDS: (u32, u32) = (1, 8);
pub const MAX_DEPTH_BOUNDS: (u8, u8) = (1, 4);
/// A model id's length bound, as `subagent_start` checks its `model`.
pub const MAX_MODEL_CHARS: usize = 512;
/// A description's length bound, so one note cannot flood the listing.
pub const MAX_DESCRIPTION_CHARS: usize = 1000;
/// A profile id's length bound. An agent's default profile, whose id is the
/// agent's listing key, is exempt (see [`validate`]).
pub const MAX_PROFILE_ID_CHARS: usize = 64;
/// The length bound of a mode id, a config option id and a config value.
pub const MAX_OPTION_CHARS: usize = 256;

/// The orchestrator settings. `profiles` are the user's sub-agent profiles
/// in the user's order. An agent no profile points at is still startable
/// through its implicit default profile (`profiles::Launchable::resolve`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestratorSettings {
    pub enabled: bool,
    pub max_running: u32,
    /// 1 = no nesting.
    pub max_depth: u8,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub profiles: Vec<SubagentProfile>,
}

impl Default for OrchestratorSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            max_running: DEFAULT_MAX_RUNNING,
            max_depth: DEFAULT_MAX_DEPTH,
            profiles: Vec::new(),
        }
    }
}

#[derive(Serialize)]
struct SettingsFile {
    schema_version: u32,
    #[serde(flatten)]
    settings: OrchestratorSettings,
}

/// The write input: a full replacement, validated and persisted atomically.
pub type SettingsInput = OrchestratorSettings;

/// Read before the payload, so a newer file whose payload no longer decodes
/// is not mistaken for a corrupt one.
#[derive(Deserialize)]
struct SchemaPeek {
    schema_version: u32,
}

/// Schemas 1 to 3: per-agent maps keyed by listing key. `agents` maps a key
/// to its allow switch (absent: allowed), `models` to its default model and
/// `descriptions` to the user's note.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LegacySettings {
    enabled: bool,
    max_running: u32,
    max_depth: u8,
    #[serde(default)]
    agents: BTreeMap<String, bool>,
    #[serde(default)]
    models: BTreeMap<String, String>,
    #[serde(default)]
    descriptions: BTreeMap<String, String>,
}

impl From<LegacySettings> for OrchestratorSettings {
    /// One default profile per key any map names, so every switch, model
    /// and note keeps applying to the agent it was saved for. A config id
    /// with no switch of its own takes its bare id's, as the move of bare
    /// switches gave it before profiles. Of keys that differ only by case,
    /// which profile ids may not, the first in key order is kept.
    fn from(mut legacy: LegacySettings) -> Self {
        let keys: BTreeSet<String> = legacy
            .agents
            .keys()
            .chain(legacy.models.keys())
            .chain(legacy.descriptions.keys())
            .cloned()
            .collect();
        let mut seen = HashSet::new();
        let mut profiles = Vec::new();
        for key in keys {
            if !seen.insert(key.to_lowercase()) {
                log::warn!(
                    "[orchestrator] sub-agent settings key {key} differs from another only by \
                     case; its switch, model and note were not migrated"
                );
                continue;
            }
            let enabled = legacy
                .agents
                .get(&key)
                .or_else(|| {
                    key.strip_prefix(REGISTRY_PREFIX)
                        .and_then(|bare| legacy.agents.get(bare))
                })
                .copied()
                .unwrap_or(true);
            profiles.push(SubagentProfile {
                enabled,
                model: legacy.models.remove(&key),
                description: legacy.descriptions.remove(&key),
                ..SubagentProfile::default_for(&key)
            });
        }
        Self {
            enabled: legacy.enabled,
            max_running: legacy.max_running,
            max_depth: legacy.max_depth,
            profiles,
        }
    }
}

/// The settings of a file at or below this build's schema. An older file
/// is migrated in memory; the first save writes it in the current schema.
fn parse(bytes: &[u8], schema_version: u32) -> Result<OrchestratorSettings, serde_json::Error> {
    if schema_version < SCHEMA_VERSION {
        let legacy = payload::<LegacySettings>(bytes)?;
        log::info!(
            "[orchestrator] settings schema {schema_version} migrated to sub-agent profiles"
        );
        return Ok(legacy.into());
    }
    payload(bytes)
}

/// A file's fields besides `schema_version`. Not `#[serde(flatten)]`, which
/// hands the payload only the fields it names, so `deny_unknown_fields`
/// would never see a field it does not know.
fn payload<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, serde_json::Error> {
    let mut fields = serde_json::from_slice::<serde_json::Map<String, serde_json::Value>>(bytes)?;
    fields.remove("schema_version");
    serde_json::from_value(serde_json::Value::Object(fields))
}

pub(crate) struct SettingsStore {
    path: Option<PathBuf>,
    /// The schema of a file written by a newer host. Its settings stay the
    /// in-memory defaults and every write is refused, so the file survives.
    newer_schema: Option<u32>,
    /// Held across read, merge, validate, persist and store, so concurrent
    /// updates never lose each other's fields. Readers take only `settings`.
    writer: Mutex<()>,
    settings: Mutex<OrchestratorSettings>,
}

impl SettingsStore {
    /// Loads `<data_dir>/subagent-settings.json`. A missing file is the
    /// defaults; a corrupt one is copied aside and the defaults load, so a
    /// corrupt file never blocks the feature. A file from a newer host loads
    /// the defaults read-only.
    pub(crate) fn open(data_dir: &Path) -> Self {
        let path = data_dir.join(FILE_NAME);
        let mut newer_schema = None;
        let settings = match std::fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice::<SchemaPeek>(&bytes) {
                Ok(peek) if peek.schema_version > SCHEMA_VERSION => {
                    log::warn!(
                        "[orchestrator] settings schema {} is newer than {}; defaults loaded \
                         and saving is off",
                        peek.schema_version,
                        SCHEMA_VERSION
                    );
                    newer_schema = Some(peek.schema_version);
                    OrchestratorSettings::default()
                }
                peek => match peek.and_then(|peek| parse(&bytes, peek.schema_version)) {
                    Ok(settings) => settings,
                    Err(error) => {
                        let backup = atomic_file::backup_corrupt(&path, &bytes);
                        log::warn!(
                            "[orchestrator] settings file is corrupt ({error}); defaults loaded \
                             (backup: {})",
                            backup.is_ok()
                        );
                        OrchestratorSettings::default()
                    }
                },
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                OrchestratorSettings::default()
            }
            Err(error) => {
                log::warn!("[orchestrator] settings file unreadable: {error}");
                OrchestratorSettings::default()
            }
        };
        Self {
            path: Some(path),
            newer_schema,
            writer: Mutex::new(()),
            settings: Mutex::new(settings),
        }
    }

    /// In-memory settings (tests).
    #[cfg(test)]
    pub(crate) fn in_memory() -> Self {
        Self {
            path: None,
            newer_schema: None,
            writer: Mutex::new(()),
            settings: Mutex::new(OrchestratorSettings::default()),
        }
    }

    pub(crate) fn get(&self) -> OrchestratorSettings {
        self.settings.lock().clone()
    }

    /// Validate and persist a full replacement.
    pub(crate) fn set(&self, input: SettingsInput) -> Result<OrchestratorSettings, String> {
        self.update(|settings| *settings = input)
    }

    /// Apply `edit` in memory, then save it when it changed anything. A
    /// failed save keeps the edit for this run. A file from a newer host is
    /// never written.
    pub(crate) fn apply_and_save(
        &self,
        edit: impl FnOnce(&mut OrchestratorSettings),
    ) -> Result<(), String> {
        let _writer = self.writer.lock();
        let mut next = self.get();
        edit(&mut next);
        if next == self.get() {
            return Ok(());
        }
        *self.settings.lock() = next.clone();
        match (&self.path, self.newer_schema) {
            (Some(path), None) => persist(path, &next),
            _ => Ok(()),
        }
    }

    /// Apply `edit` to the current settings, then validate and persist the
    /// result as one write. A refused edit leaves the settings unchanged.
    pub(crate) fn update(
        &self,
        edit: impl FnOnce(&mut OrchestratorSettings),
    ) -> Result<OrchestratorSettings, String> {
        self.try_update(|settings| {
            edit(settings);
            Ok(())
        })
    }

    /// [`update`](Self::update) with an edit that may refuse; a refusal
    /// leaves the settings unchanged.
    pub(crate) fn try_update(
        &self,
        edit: impl FnOnce(&mut OrchestratorSettings) -> Result<(), String>,
    ) -> Result<OrchestratorSettings, String> {
        let _writer = self.writer.lock();
        if let Some(found) = self.newer_schema {
            return Err(format!(
                "the sub-agent settings were saved by a newer Karsa (schema {found}, this build \
                 understands {SCHEMA_VERSION}); upgrade Karsa to change them"
            ));
        }
        let mut next = self.get();
        edit(&mut next)?;
        let next = validate(next)?;
        if let Some(path) = &self.path {
            persist(path, &next)?;
        }
        *self.settings.lock() = next.clone();
        Ok(next)
    }
}

/// Bounds every field and trims each profile's agent id and description.
/// A profile id is 1 to [`MAX_PROFILE_ID_CHARS`] characters of
/// `[A-Za-z0-9._:-]`, unique case-insensitively. An agent's default profile
/// is exempt from the character rule: its id is the agent's listing key,
/// which for a custom agent is its display name.
fn validate(mut input: OrchestratorSettings) -> Result<OrchestratorSettings, String> {
    if !(MAX_RUNNING_BOUNDS.0..=MAX_RUNNING_BOUNDS.1).contains(&input.max_running) {
        return Err(format!(
            "max_running must be between {} and {}",
            MAX_RUNNING_BOUNDS.0, MAX_RUNNING_BOUNDS.1
        ));
    }
    if !(MAX_DEPTH_BOUNDS.0..=MAX_DEPTH_BOUNDS.1).contains(&input.max_depth) {
        return Err(format!(
            "max_depth must be between {} and {}",
            MAX_DEPTH_BOUNDS.0, MAX_DEPTH_BOUNDS.1
        ));
    }
    let mut ids = HashSet::new();
    for profile in &mut input.profiles {
        validate_profile(profile)?;
        if !ids.insert(profile.id.to_lowercase()) {
            return Err(format!("two sub-agent profiles are named {}", profile.id));
        }
    }
    Ok(input)
}

fn validate_profile(profile: &mut SubagentProfile) -> Result<(), String> {
    profile.agent_id = profile.agent_id.trim().to_string();
    if profile.agent_id.is_empty()
        || profile.agent_id.chars().count() > crate::acp::subagents::MAX_ID_CHARS
    {
        return Err(format!("the sub-agent profile {} names no agent", profile.id));
    }
    let id_ok = if profile.id == profile.agent_id {
        true
    } else {
        (1..=MAX_PROFILE_ID_CHARS).contains(&profile.id.chars().count())
            && profile
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
    };
    if !id_ok {
        return Err(format!(
            "a profile id must be 1 to {MAX_PROFILE_ID_CHARS} letters, digits, '.', '_', ':' \
             or '-'"
        ));
    }
    if profile
        .model
        .as_deref()
        .is_some_and(|model| model.trim().is_empty() || model.chars().count() > MAX_MODEL_CHARS)
    {
        return Err(format!(
            "a default model must be 1 to {MAX_MODEL_CHARS} characters"
        ));
    }
    let option_ok =
        |text: &str| !text.trim().is_empty() && text.chars().count() <= MAX_OPTION_CHARS;
    if profile.mode.as_deref().is_some_and(|mode| !option_ok(mode)) {
        return Err(format!("a mode must be 1 to {MAX_OPTION_CHARS} characters"));
    }
    if profile
        .config_options
        .iter()
        .any(|(id, value)| !option_ok(id) || !option_ok(value))
    {
        return Err(format!(
            "a config option id and value must be 1 to {MAX_OPTION_CHARS} characters"
        ));
    }
    if let Some(description) = &mut profile.description {
        *description = description.trim().to_string();
        if description.is_empty() || description.chars().count() > MAX_DESCRIPTION_CHARS {
            return Err(format!(
                "a description must be 1 to {MAX_DESCRIPTION_CHARS} characters"
            ));
        }
    }
    Ok(())
}

fn persist(path: &Path, settings: &OrchestratorSettings) -> Result<(), String> {
    let file = SettingsFile {
        schema_version: SCHEMA_VERSION,
        settings: settings.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&file)
        .map_err(|error| format!("settings could not be saved: {error}"))?;
    match atomic_file::replace_private(path, &bytes) {
        Ok(()) => log::info!("[orchestrator] settings saved"),
        // The rename landed and only the directory sync failed: the file
        // holds the new settings, so memory must too.
        Err(error) if std::fs::read(path).is_ok_and(|on_disk| on_disk == bytes) => {
            log::warn!("[orchestrator] settings saved, durability unconfirmed: {error}");
        }
        Err(error) => {
            log::warn!("[orchestrator] settings could not be saved: {error}");
            return Err(format!("settings could not be saved: {error}"));
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "settings_tests.rs"]
mod settings_tests;
