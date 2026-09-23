use super::{
    auth::{hash_secret, request_credential, secret_equal},
    error::{ErrorKind, GatewayError},
    util::now_ms,
};
use crate::{config::Config, db::Db};
use axum::http::HeaderMap;

#[derive(Clone, Debug)]
pub(super) struct Identity {
    pub key_id: String,
    pub name: String,
    pub managed: bool,
    pub allowed_models: Vec<String>,
}

pub(super) fn authenticate(
    config: &Config,
    db: &Db,
    headers: &HeaderMap,
) -> Result<Option<Identity>, GatewayError> {
    let credential = request_credential(headers);
    if config.proxy_api_key.is_empty() && db.count_api_keys().map_err(GatewayError::database)? == 0
    {
        return Ok(Some(Identity {
            key_id: "anonymous".into(),
            name: "匿名访问".into(),
            managed: false,
            allowed_models: Vec::new(),
        }));
    }
    if !credential.is_empty() && secret_equal(&credential, &config.proxy_api_key) {
        return Ok(Some(Identity {
            key_id: "environment".into(),
            name: "环境变量 API Key".into(),
            managed: false,
            allowed_models: Vec::new(),
        }));
    }
    if credential.is_empty() {
        return Ok(None);
    }
    let hash = hash_secret(&credential);
    let Some(key) = db
        .find_api_key_by_hash(&hash)
        .map_err(GatewayError::database)?
    else {
        return Ok(None);
    };
    if !key.enabled
        || key.revoked_at.is_some()
        || key.expires_at.is_some_and(|expires| expires <= now_ms())
    {
        return Ok(None);
    }
    Ok(Some(Identity {
        key_id: key.id,
        name: key.name,
        managed: true,
        allowed_models: key.allowed_models,
    }))
}

pub(super) fn authorize_model(identity: &Identity, model: &str) -> Result<(), GatewayError> {
    if identity.allowed_models.is_empty()
        || identity
            .allowed_models
            .iter()
            .any(|item| item == "*" || item == model)
    {
        return Ok(());
    }
    Err(GatewayError::new(
        ErrorKind::Forbidden,
        format!("API Key {} 无权访问模型 {}", identity.name, model),
    ))
}
