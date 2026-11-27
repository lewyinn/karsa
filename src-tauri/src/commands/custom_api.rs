//! Tauri IPC commands for Bring-Your-Own-API (custom HTTP endpoint) connections.

use crate::acp::custom_api::{
    self, TestCustomApiRequest, TestCustomApiResponse,
};

#[tauri::command]
pub async fn custom_api_save_key(config_id: String, api_key: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || custom_api::save_api_key(&config_id, &api_key))
        .await
        .map_err(|e| format!("Failed to save API key: {e}"))?
}

#[tauri::command]
pub async fn custom_api_has_key(config_id: String) -> Result<bool, String> {
    tokio::task::spawn_blocking(move || custom_api::has_api_key(&config_id))
        .await
        .map_err(|e| format!("Failed to check API key: {e}"))?
}

#[tauri::command]
pub async fn custom_api_delete_key(config_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || custom_api::delete_api_key(&config_id))
        .await
        .map_err(|e| format!("Failed to delete API key: {e}"))?
}

#[tauri::command]
pub async fn custom_api_test(
    request: TestCustomApiRequest,
) -> Result<TestCustomApiResponse, String> {
    custom_api::test_connection(request).await
}
