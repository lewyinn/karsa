use super::IpcResult;
use std::sync::Arc;
use tauri::State;

/// Payload of [`project_registry_import`].
#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegistryImportPayload {
    pub projects: Vec<crate::web::ProjectSummary>,
    #[serde(default)]
    pub default_project_id: Option<String>,
}

/// One-shot import of the renderer's old project list into the durable
/// registry (first launch after the upgrade). Allowed only while the registry
/// file says nothing was imported: ids not yet registered are added, existing
/// ids are kept (never overwritten), the default applies only when none is
/// set, and the registry is marked imported — durably, even for an empty list.
/// A repeat is an ok no-op replying `{ imported: false }`. The renderer deletes
/// its own `projects` key only after this acknowledges.
#[tauri::command]
pub async fn project_registry_import(
    payload: ProjectRegistryImportPayload,
    project_registry: State<'_, Arc<crate::web::ProjectRegistry>>,
    ws_relay: State<'_, Arc<crate::web::WsRelaySink>>,
) -> Result<IpcResult<crate::web::project_registry::ImportOutcome>, String> {
    match crate::web::project_registry::import_projects(
        project_registry.inner(),
        ws_relay.inner(),
        payload.projects,
        payload.default_project_id,
    ) {
        Ok(outcome) => Ok(IpcResult::success(outcome)),
        Err(error) => {
            log::error!("project_registry_import: {error}");
            Ok(IpcResult::error(error.message(), error.http_code()))
        }
    }
}
