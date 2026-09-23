use super::{
    AppState,
    error::{ErrorKind, GatewayError},
    policy::{self, Identity},
};
use crate::config::Config;
use axum::http::HeaderMap;
use axum::http::header::{self, HeaderName, HeaderValue};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, RwLock},
};
use subtle::ConstantTimeEq;

#[derive(Clone, Default)]
pub(super) struct AuthCache(Arc<RwLock<HashMap<String, HeaderMap>>>);

impl AuthCache {
    pub fn load(config: &Config) -> Self {
        Self(Arc::new(RwLock::new(load_auth_cache(config))))
    }
    pub fn reload(&self, config: &Config) -> anyhow::Result<()> {
        *self
            .0
            .write()
            .map_err(|_| anyhow::anyhow!("认证缓存锁已失效"))? = load_auth_cache(config);
        Ok(())
    }
    pub fn headers(&self, auth_ref: &str) -> Option<HeaderMap> {
        self.0
            .read()
            .ok()
            .and_then(|auth| auth.get(auth_ref).cloned())
    }
    pub fn contains(&self, auth_ref: &str) -> bool {
        self.0
            .read()
            .ok()
            .is_some_and(|auth| auth.contains_key(auth_ref))
    }
    pub fn status(&self, config: &Config) -> Value {
        let providers = ["mimo", "workbuddy"].into_iter().map(|provider| {
            (provider.to_string(), json!({"ready": self.contains(provider), "capturedAt": read_auth_captured_at(&config.auth_path(provider)), "source": "cache"}))
        }).collect::<serde_json::Map<_, _>>();
        json!({"ready": providers.values().any(|value| value["ready"] == true), "providers": providers})
    }
    #[cfg(test)]
    pub fn set_headers(&self, auth_ref: &str, headers: HeaderMap) {
        self.0.write().unwrap().insert(auth_ref.into(), headers);
    }
}

fn load_auth_cache(config: &Config) -> HashMap<String, HeaderMap> {
    let mut auth = HashMap::new();
    if let Ok(entries) = std::fs::read_dir(&config.auth_cache_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Some(name) = path.file_stem().and_then(|value| value.to_str()) else {
                continue;
            };
            if let Some(headers) = read_auth_headers(&path) {
                auth.insert(name.to_string(), headers);
            }
        }
    }
    for provider in ["mimo", "workbuddy"] {
        let path = config.auth_path(provider);
        if !auth.contains_key(provider) {
            if let Some(headers) = read_auth_headers(&path) {
                auth.insert(provider.to_string(), headers);
            }
        }
    }
    auth
}

pub(super) fn read_auth_headers(path: &PathBuf) -> Option<HeaderMap> {
    let raw = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let object = value
        .get("headers")
        .and_then(Value::as_object)
        .or_else(|| value.as_object());
    let object = object?;
    let mut headers = HeaderMap::new();
    for (name, value) in object {
        if !is_forwarded_header(name) {
            continue;
        }
        let Some(value) = value
            .as_str()
            .and_then(|value| HeaderValue::from_str(value).ok())
        else {
            continue;
        };
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        headers.insert(name, value);
    }
    headers
        .keys()
        .any(|name| name != header::USER_AGENT)
        .then_some(headers)
}

pub(super) fn read_auth_captured_at(path: &PathBuf) -> Option<i64> {
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw)
        .ok()?
        .get("capturedAt")
        .and_then(Value::as_i64)
}

pub(super) fn is_forwarded_header(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    matches!(
        name.as_str(),
        "authorization" | "cookie" | "user-agent" | "x-api-key" | "x-goog-api-key"
    ) || name.starts_with("x-")
}

pub(super) fn request_credential(headers: &HeaderMap) -> String {
    if let Some(value) = headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
    {
        if let Some(value) = value
            .strip_prefix("Bearer ")
            .or_else(|| value.strip_prefix("bearer "))
        {
            return value.trim().into();
        }
    }
    headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .trim()
        .into()
}

pub(super) fn require_public_identity(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Identity, GatewayError> {
    let identity = policy::authenticate(&state.config, &state.db, headers)?.filter(|identity| {
        state.config.is_loopback() || identity.managed || identity.key_id == "environment"
    });
    identity.ok_or_else(|| GatewayError::new(ErrorKind::Unauthorized, "缺少或无效的代理 API Key"))
}

pub(super) fn require_admin(state: &AppState, headers: &HeaderMap) -> Result<(), GatewayError> {
    if state.config.proxy_admin_key.is_empty() {
        return Err(GatewayError::new(
            ErrorKind::Configuration,
            "HTTP 管理接口需要配置 PROXY_ADMIN_KEY；本机桌面可直接管理",
        ));
    }
    if !secret_equal(&request_credential(headers), &state.config.proxy_admin_key) {
        return Err(GatewayError::new(
            ErrorKind::Unauthorized,
            "缺少或无效的管理员 API Key",
        ));
    }
    Ok(())
}

pub(super) fn hash_secret(secret: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(secret.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(super) fn secret_equal(left: &str, right: &str) -> bool {
    left.as_bytes().ct_eq(right.as_bytes()).into()
}
