//! HTTP routes for Bring-Your-Own-API connections (desktop + web parity).

use axum::extract::State;
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;

use crate::acp::custom_api::{self, TestCustomApiRequest, TestCustomApiResponse};
use crate::web::fs_api::IpcBody;
use crate::web::AppState;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveKeyRequest {
    pub config_id: String,
    pub api_key: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigIdRequest {
    pub config_id: String,
}

pub async fn save_key(
    State(state): State<AppState>,
    Json(req): Json<SaveKeyRequest>,
) -> impl IntoResponse {
    if !state.allow_remote_writes {
        return (
            StatusCode::FORBIDDEN,
            Json(IpcBody::<()>::err(
                "Server is in read-only mode",
                "READ_ONLY_SERVER",
            )),
        );
    }
    let res = tokio::task::spawn_blocking(move || {
        custom_api::save_api_key(&req.config_id, &req.api_key)
    })
    .await
    .map_err(|e| format!("save_key task failed: {e}"));
    let body = match res {
        Ok(Ok(())) => IpcBody::ok(()),
        Ok(Err(e)) | Err(e) => IpcBody::err(e, "CUSTOM_API_KEY_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

pub async fn has_key(Json(req): Json<ConfigIdRequest>) -> impl IntoResponse {
    let res = tokio::task::spawn_blocking(move || custom_api::has_api_key(&req.config_id))
        .await
        .map_err(|e| format!("has_key task failed: {e}"));
    let body = match res {
        Ok(Ok(present)) => IpcBody::<bool>::ok(present),
        Ok(Err(e)) | Err(e) => IpcBody::<bool>::err(e, "CUSTOM_API_KEY_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

pub async fn delete_key(
    State(state): State<AppState>,
    Json(req): Json<ConfigIdRequest>,
) -> impl IntoResponse {
    if !state.allow_remote_writes {
        return (
            StatusCode::FORBIDDEN,
            Json(IpcBody::<()>::err(
                "Server is in read-only mode",
                "READ_ONLY_SERVER",
            )),
        );
    }
    let res = tokio::task::spawn_blocking(move || custom_api::delete_api_key(&req.config_id))
        .await
        .map_err(|e| format!("delete_key task failed: {e}"));
    let body = match res {
        Ok(Ok(())) => IpcBody::ok(()),
        Ok(Err(e)) | Err(e) => IpcBody::err(e, "CUSTOM_API_KEY_ERROR"),
    };
    (StatusCode::OK, Json(body))
}

pub async fn test_connection(Json(req): Json<TestCustomApiRequest>) -> impl IntoResponse {
    let body = match custom_api::test_connection(req).await {
        Ok(res) => IpcBody::<TestCustomApiResponse>::ok(res),
        Err(e) => IpcBody::<TestCustomApiResponse>::err(e, "CUSTOM_API_TEST_ERROR"),
    };
    (StatusCode::OK, Json(body))
}
