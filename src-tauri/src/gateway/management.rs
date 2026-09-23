//! Shared management operations. HTTP and desktop IPC only adapt authorization and transport.
use super::{
    AppState,
    auth::hash_secret,
    error::{ErrorKind, GatewayError},
    metrics::{self, MetricQuery, MetricScope, MetricView},
    util::{now_ms, string_array},
};
use crate::db::{ApiKeyRecord, ChannelRecord, Db};
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
pub(crate) enum ManagementRequest {
    ListChannels {},
    SaveChannel {
        body: Value,
    },
    DeleteChannel {
        id: String,
    },
    ListKeys {},
    CreateKey {
        body: Value,
    },
    UpdateKey {
        id: String,
        body: Value,
    },
    RevokeKey {
        id: String,
    },
    Models {},
    Metrics {
        query: MetricQuery,
        view: MetricView,
    },
}

pub(crate) async fn execute(
    state: &AppState,
    request: ManagementRequest,
) -> Result<Value, GatewayError> {
    match request {
        ManagementRequest::ListChannels {} => list_channels(state),
        ManagementRequest::SaveChannel { body } => save_channel(state, body),
        ManagementRequest::DeleteChannel { id } => delete_channel(state, id),
        ManagementRequest::ListKeys {} => list_keys(state),
        ManagementRequest::CreateKey { body } => create_key(state, body),
        ManagementRequest::UpdateKey { id, body } => update_key(state, id, body),
        ManagementRequest::RevokeKey { id } => revoke_key(state, id),
        ManagementRequest::Models {} => Ok(json!({"object":"list", "data":state.models().await})),
        ManagementRequest::Metrics { query, view } => {
            metrics::query_metrics(state, &query, MetricScope::Admin, view)
        }
    }
}

#[derive(Serialize)]
pub(crate) struct ManagementResponse {
    status: u16,
    body: Value,
}

pub(crate) async fn request(state: &AppState, request: ManagementRequest) -> ManagementResponse {
    let body = match &request {
        ManagementRequest::SaveChannel { body }
        | ManagementRequest::CreateKey { body }
        | ManagementRequest::UpdateKey { body, .. } => Some(body),
        _ => None,
    };
    if body.is_some_and(|body| body.to_string().len() > state.config.max_body_bytes) {
        return ManagementResponse {
            status: 413,
            body: json!({"error":{"message":"管理请求过大","type":"invalid_request_error"}}),
        };
    }
    match execute(state, request).await {
        Ok(body) => ManagementResponse { status: 200, body },
        Err(error) => ManagementResponse {
            status: error.status(),
            body: error.payload(),
        },
    }
}

fn list_channels(state: &AppState) -> Result<Value, GatewayError> {
    match state.db.list_channels() {
        Ok(data) => Ok(json!({ "object": "llm-gateway.channels", "data": data })),
        Err(error) => Err(GatewayError::database(error)),
    }
}

fn save_channel(state: &AppState, value: Value) -> Result<Value, GatewayError> {
    let Some(object) = value.as_object() else {
        return Err(GatewayError::new(
            ErrorKind::InvalidRequest,
            "渠道配置必须是 JSON 对象",
        ));
    };
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    let provider = object
        .get("providerId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim();
    if id.is_empty() || !["mimo", "workbuddy"].contains(&provider) {
        return Err(GatewayError::new(
            ErrorKind::InvalidRequest,
            "渠道需要有效的 id 和 providerId",
        ));
    }
    let channel = ChannelRecord {
        id: id.into(),
        name: object
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .into(),
        provider_id: provider.into(),
        auth_ref: object
            .get("authRef")
            .and_then(Value::as_str)
            .unwrap_or(provider)
            .into(),
        upstream_url: object
            .get("upstreamUrl")
            .and_then(Value::as_str)
            .map(str::to_string),
        enabled: object
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        priority: object.get("priority").and_then(Value::as_i64).unwrap_or(0),
        weight: object
            .get("weight")
            .and_then(Value::as_i64)
            .unwrap_or(1)
            .max(1),
        model_mappings: object
            .get("modelMappings")
            .cloned()
            .unwrap_or_else(|| json!({})),
    };
    match state.db.upsert_channel(&channel) {
        Ok(()) => Ok(json!({ "object": "llm-gateway.channel", "data": channel })),
        Err(error) => Err(GatewayError::database(error)),
    }
}

fn delete_channel(state: &AppState, id: String) -> Result<Value, GatewayError> {
    match state.db.delete_channel(&id) {
        Ok(true) => Ok(json!({ "object": "llm-gateway.channel.deleted", "id": id })),
        Ok(false) => Err(GatewayError::new(ErrorKind::NotFound, "渠道不存在")),
        Err(error) => Err(GatewayError::database(error)),
    }
}

fn list_keys(state: &AppState) -> Result<Value, GatewayError> {
    match state.db.list_api_keys() {
        Ok(keys) => Ok(
            json!({ "object": "llm-gateway.api_keys", "data": keys.into_iter().map(public_key).collect::<Vec<_>>() }),
        ),
        Err(error) => Err(GatewayError::database(error)),
    }
}

fn create_key(state: &AppState, value: Value) -> Result<Value, GatewayError> {
    let object = value.as_object().cloned().unwrap_or_default();
    let name = object
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("未命名 Key")
        .trim();
    let secret = format!(
        "sk-gw-{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(rand::random::<[u8; 24]>())
    );
    let key = ApiKeyRecord {
        id: Db::new_id(),
        name: name.into(),
        prefix: secret.chars().take(10).collect(),
        hash: hash_secret(&secret),
        enabled: true,
        created_at: now_ms(),
        expires_at: object.get("expiresAt").and_then(Value::as_i64),
        allowed_models: string_array(object.get("allowedModels")),
        rpm_limit: object.get("rpmLimit").and_then(Value::as_i64),
        tpm_limit: object.get("tpmLimit").and_then(Value::as_i64),
        quota_tokens: object.get("quotaTokens").and_then(Value::as_i64),
        used_tokens: 0,
        revoked_at: None,
        last_used_at: None,
    };
    match state.db.upsert_api_key(&key) {
        Ok(()) => Ok(json!({
            "object": "llm-gateway.api_key",
            "data": public_key(key),
            "secret": secret,
            "warning": "secret 只在本次响应中返回，请立即保存"
        })),
        Err(error) => Err(GatewayError::database(error)),
    }
}

fn update_key(state: &AppState, id: String, value: Value) -> Result<Value, GatewayError> {
    let mut key = state
        .db
        .list_api_keys()
        .map_err(GatewayError::database)?
        .into_iter()
        .find(|key| key.id == id)
        .ok_or_else(|| GatewayError::new(ErrorKind::NotFound, "API Key 不存在"))?;
    if key.revoked_at.is_some() {
        return Err(GatewayError::new(
            ErrorKind::Conflict,
            "已撤销的 Key 不可恢复或修改",
        ));
    }
    if value.get("expiresAt").is_some() {
        key.expires_at = value.get("expiresAt").and_then(Value::as_i64);
    }
    if let Some(name) = value.get("name").and_then(Value::as_str) {
        key.name = name.into();
    }
    if let Some(enabled) = value.get("enabled").and_then(Value::as_bool) {
        key.enabled = enabled;
    }
    if value.get("allowedModels").is_some() {
        key.allowed_models = string_array(value.get("allowedModels"));
    }
    for (field, target) in [
        ("rpmLimit", &mut key.rpm_limit),
        ("tpmLimit", &mut key.tpm_limit),
        ("quotaTokens", &mut key.quota_tokens),
    ] {
        if value.get(field).is_some() {
            *target = value.get(field).and_then(Value::as_i64);
        }
    }
    match state.db.upsert_api_key(&key) {
        Ok(()) => Ok(json!({ "object": "llm-gateway.api_key", "data": public_key(key) })),
        Err(error) => Err(GatewayError::database(error)),
    }
}

fn revoke_key(state: &AppState, id: String) -> Result<Value, GatewayError> {
    match state.db.delete_api_key(&id) {
        Ok(true) => Ok(json!({ "object": "llm-gateway.api_key.revoked", "id": id })),
        Ok(false) => Err(GatewayError::new(ErrorKind::NotFound, "API Key 不存在")),
        Err(error) => Err(GatewayError::database(error)),
    }
}

pub(super) fn public_key(key: ApiKeyRecord) -> Value {
    json!({ "id": key.id, "name": key.name, "prefix": key.prefix, "enabled": key.enabled, "createdAt": key.created_at, "expiresAt": key.expires_at, "allowedModels": key.allowed_models, "rpmLimit": key.rpm_limit, "tpmLimit": key.tpm_limit, "quotaTokens": key.quota_tokens, "usedTokens": key.used_tokens, "revokedAt": key.revoked_at, "lastUsedAt": key.last_used_at, "remainingTokens": key.quota_tokens.map(|quota| (quota-key.used_tokens).max(0)) })
}
