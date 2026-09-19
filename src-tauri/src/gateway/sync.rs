use super::{AppState, auth};
use crate::config::Config;
use aes_gcm::{
    Aes256Gcm, Nonce,
    aead::{Aead, KeyInit},
};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use reqwest::{Client, StatusCode};
use scrypt::{Params, scrypt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const ENVELOPE_FORMAT: u8 = 1;
const ENVELOPE_ALGORITHM: &str = "scrypt-aes-256-gcm";
const MAX_PAYLOAD_BYTES: usize = 512 * 1024;
const SCRYPT_LOG_N: u8 = 15;
const SCRYPT_R: u32 = 8;
const SCRYPT_P: u32 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSyncSettings {
    pub url: String,
    pub token: String,
    pub vault_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSyncStatus {
    pub vault_id: String,
    pub exists: bool,
    pub revision: Option<i64>,
    pub updated_at: Option<i64>,
    pub local_revision: Option<i64>,
    pub local_providers: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSyncPullResult {
    pub vault_id: String,
    pub revision: i64,
    pub updated_at: i64,
    pub providers: Vec<String>,
    pub workbuddy_model_count: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteVault {
    revision: i64,
    updated_at: i64,
    envelope: RemoteEnvelope,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteEnvelope {
    format: u8,
    algorithm: String,
    salt: String,
    iv: String,
    tag: String,
    ciphertext: String,
    created_at: i64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultPayload {
    version: u8,
    #[allow(dead_code)]
    created_at: i64,
    providers: BTreeMap<String, AuthRecord>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuthRecord {
    headers: BTreeMap<String, String>,
    captured_at: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncState {
    revision: i64,
    updated_at: i64,
}

pub(crate) async fn status(
    state: &AppState,
    settings: RemoteSyncSettings,
) -> Result<RemoteSyncStatus> {
    let settings = normalize_settings(settings)?;
    let local_state = read_sync_state(&state.config);
    let local_providers = read_local_providers(&state.config.auth_cache_dir);
    let remote = fetch_remote(&state.client, &settings).await?;

    Ok(match remote {
        Some(remote) => RemoteSyncStatus {
            vault_id: settings.vault_id,
            exists: true,
            revision: Some(remote.revision),
            updated_at: Some(remote.updated_at),
            local_revision: local_state.map(|value| value.revision),
            local_providers,
        },
        None => RemoteSyncStatus {
            vault_id: settings.vault_id,
            exists: false,
            revision: None,
            updated_at: None,
            local_revision: local_state.map(|value| value.revision),
            local_providers,
        },
    })
}

pub(crate) async fn pull(
    state: &AppState,
    settings: RemoteSyncSettings,
    passphrase: String,
    force: bool,
) -> Result<RemoteSyncPullResult> {
    let settings = normalize_settings(settings)?;
    ensure!(
        passphrase.chars().count() >= 8,
        "同步加密密码至少需要 8 个字符"
    );
    let remote = fetch_remote(&state.client, &settings)
        .await?
        .ok_or_else(|| anyhow::anyhow!("远端保险库 {} 尚不存在", settings.vault_id))?;
    let local_state = read_sync_state(&state.config);
    let local_providers = read_local_providers(&state.config.auth_cache_dir);
    if !force
        && !local_providers.is_empty()
        && local_state.as_ref().map(|value| value.revision) != Some(remote.revision)
    {
        bail!("本机已有未确认的认证缓存；如确认用远端覆盖，请启用强制覆盖")
    }

    let envelope = remote.envelope.clone();
    let payload = tokio::task::spawn_blocking(move || decrypt_payload(&envelope, &passphrase))
        .await
        .context("解密远端认证包失败")??;
    let providers = write_auth_payload(&state.config, &payload)?;
    write_sync_state(
        &state.config,
        &SyncState {
            revision: remote.revision,
            updated_at: remote.updated_at,
        },
    )?;
    state.reload_auth_cache().await?;
    let workbuddy_model_count = state
        .models()
        .await
        .iter()
        .filter(|model| model.provider == "workbuddy" && model.id != "default")
        .count();

    Ok(RemoteSyncPullResult {
        vault_id: settings.vault_id,
        revision: remote.revision,
        updated_at: remote.updated_at,
        providers,
        workbuddy_model_count,
    })
}

fn normalize_settings(settings: RemoteSyncSettings) -> Result<RemoteSyncSettings> {
    let url = settings.url.trim().trim_end_matches('/').to_string();
    let token = settings.token.trim().to_string();
    let vault_id = if settings.vault_id.trim().is_empty() {
        "default".to_string()
    } else {
        settings.vault_id.trim().to_string()
    };
    let lower_url = url.to_ascii_lowercase();
    ensure!(
        lower_url.starts_with("https://") || lower_url.starts_with("http://"),
        "同步地址必须是 http 或 https 地址"
    );
    ensure!(!token.is_empty(), "请输入同步 Token");
    ensure!(
        is_valid_id(&vault_id),
        "保险库 ID 只能包含字母、数字、下划线和短横线"
    );
    Ok(RemoteSyncSettings {
        url,
        token,
        vault_id,
    })
}

async fn fetch_remote(
    client: &Client,
    settings: &RemoteSyncSettings,
) -> Result<Option<RemoteVault>> {
    let endpoint = format!("{}/v1/vault/{}", settings.url, settings.vault_id);
    let response = client
        .get(endpoint)
        .header("accept", "application/json")
        .header("authorization", format!("Bearer {}", settings.token))
        .send()
        .await
        .context("无法连接认证同步服务")?;
    let status = response.status();
    let raw = response.text().await.context("读取认证同步服务响应失败")?;
    let body = if raw.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str::<Value>(&raw).context("认证同步服务返回了无效 JSON")?
    };
    if status == StatusCode::NOT_FOUND {
        return Ok(None);
    }
    if !status.is_success() {
        bail!(remote_error(&body, status))
    }
    let remote: RemoteVault = serde_json::from_value(body).context("远端认证保险库格式无效")?;
    validate_remote(&remote)?;
    Ok(Some(remote))
}

fn remote_error(body: &Value, status: StatusCode) -> String {
    body.pointer("/error/message")
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| format!("同步服务返回 HTTP {}", status.as_u16()))
}

fn validate_remote(remote: &RemoteVault) -> Result<()> {
    ensure!(remote.revision > 0, "远端版本号无效");
    ensure!(remote.updated_at > 0, "远端更新时间无效");
    ensure!(
        remote.envelope.format == ENVELOPE_FORMAT,
        "远端加密保险库格式无效"
    );
    ensure!(
        remote.envelope.algorithm == ENVELOPE_ALGORITHM,
        "远端加密保险库算法不受支持"
    );
    ensure!(remote.envelope.created_at > 0, "远端加密保险库时间戳无效");
    let _ = decode_base64(&remote.envelope.salt, Some(16), 16)?;
    let _ = decode_base64(&remote.envelope.iv, Some(12), 12)?;
    let _ = decode_base64(&remote.envelope.tag, Some(16), 16)?;
    let _ = decode_base64(&remote.envelope.ciphertext, None, MAX_PAYLOAD_BYTES)?;
    Ok(())
}

fn decrypt_payload(envelope: &RemoteEnvelope, passphrase: &str) -> Result<VaultPayload> {
    validate_remote(&RemoteVault {
        revision: 1,
        updated_at: envelope.created_at,
        envelope: envelope.clone(),
    })?;
    let salt = decode_base64(&envelope.salt, Some(16), 16)?;
    let iv = decode_base64(&envelope.iv, Some(12), 12)?;
    let tag = decode_base64(&envelope.tag, Some(16), 16)?;
    let ciphertext = decode_base64(&envelope.ciphertext, None, MAX_PAYLOAD_BYTES)?;
    let params =
        Params::new(SCRYPT_LOG_N, SCRYPT_R, SCRYPT_P, 32).context("无法初始化认证解密参数")?;
    let mut key = [0_u8; 32];
    scrypt(passphrase.as_bytes(), &salt, &params, &mut key).context("无法派生认证解密密钥")?;
    let cipher = Aes256Gcm::new_from_slice(&key).context("无法初始化认证解密器")?;
    let nonce = Nonce::from_slice(&iv);
    let mut encrypted = ciphertext;
    encrypted.extend_from_slice(&tag);
    let plaintext = cipher
        .decrypt(nonce, encrypted.as_ref())
        .map_err(|_| anyhow::anyhow!("解密失败：密码错误或认证包已损坏"))?;
    ensure!(
        plaintext.len() <= MAX_PAYLOAD_BYTES,
        "解密后的认证包超过大小限制"
    );
    let payload: VaultPayload =
        serde_json::from_slice(&plaintext).context("解密后的认证包格式无效")?;
    ensure!(payload.version == 1, "认证包版本不受支持");
    ensure!(!payload.providers.is_empty(), "认证包中没有有效 Provider");
    Ok(payload)
}

fn write_auth_payload(config: &Config, payload: &VaultPayload) -> Result<Vec<String>> {
    config.ensure_runtime_dir()?;
    let mut written = Vec::new();
    for (provider_id, record) in &payload.providers {
        if !is_valid_id(provider_id) {
            continue;
        }
        let headers = record
            .headers
            .iter()
            .filter(|(name, value)| {
                auth::is_forwarded_header(name)
                    && axum::http::HeaderName::from_bytes(name.as_bytes()).is_ok()
                    && axum::http::HeaderValue::from_str(value).is_ok()
            })
            .map(|(name, value)| (name.clone(), value.clone()))
            .collect::<BTreeMap<_, _>>();
        if !headers
            .keys()
            .any(|name| !name.eq_ignore_ascii_case("user-agent"))
        {
            continue;
        }
        let body = json!({
            "version": 1,
            "headers": headers,
            "capturedAt": record.captured_at,
        });
        write_atomic(
            &config.auth_cache_dir.join(format!("{provider_id}.json")),
            &serde_json::to_vec_pretty(&body)?,
        )?;
        written.push(provider_id.clone());
    }
    ensure!(!written.is_empty(), "认证包中没有有效 Provider");
    written.sort();
    Ok(written)
}

fn read_local_providers(cache_dir: &Path) -> Vec<String> {
    let mut providers = fs::read_dir(cache_dir)
        .ok()
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("json"))
                .then(|| {
                    let provider = path.file_stem()?.to_str()?.to_string();
                    (is_valid_id(&provider) && auth::read_auth_headers(&path).is_some())
                        .then_some(provider)
                })
                .flatten()
        })
        .collect::<Vec<_>>();
    providers.sort();
    providers
}

fn read_sync_state(config: &Config) -> Option<SyncState> {
    let path = sync_state_path(config);
    let raw = fs::read_to_string(path).ok()?;
    let state = serde_json::from_str::<SyncState>(&raw).ok()?;
    (state.revision > 0).then_some(state)
}

fn write_sync_state(config: &Config, state: &SyncState) -> Result<()> {
    write_atomic(&sync_state_path(config), &serde_json::to_vec_pretty(state)?)
}

fn sync_state_path(config: &Config) -> PathBuf {
    config.runtime_dir.join(".sync-state.json")
}

fn write_atomic(path: &Path, content: &[u8]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, content)?;
    set_private_permissions(&temporary)?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path)?;
    }
    fs::rename(&temporary, path)?;
    set_private_permissions(path)?;
    Ok(())
}

fn set_private_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(path, permissions)?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn decode_base64(
    value: &str,
    expected_length: Option<usize>,
    maximum_length: usize,
) -> Result<Vec<u8>> {
    ensure!(!value.is_empty(), "远端加密保险库编码无效");
    let decoded = STANDARD.decode(value).context("远端加密保险库编码无效")?;
    ensure!(decoded.len() <= maximum_length, "远端加密保险库大小无效");
    if let Some(expected_length) = expected_length {
        ensure!(decoded.len() == expected_length, "远端加密保险库大小无效");
    }
    Ok(decoded)
}

fn is_valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

#[cfg(test)]
mod tests {
    use super::{RemoteEnvelope, decrypt_payload, is_valid_id};

    #[test]
    fn sync_ids_are_safe_for_paths_and_urls() {
        assert!(is_valid_id("personal-main"));
        assert!(is_valid_id("default_1"));
        assert!(!is_valid_id("../auth"));
        assert!(!is_valid_id("with space"));
        assert!(!is_valid_id(""));
    }

    #[test]
    fn decrypts_node_sync_envelope() {
        let envelope = RemoteEnvelope {
            format: 1,
            algorithm: "scrypt-aes-256-gcm".into(),
            salt: "xJCFJeSuIhwy1DKLx9SHVg==".into(),
            iv: "ZLghrFM5BxIHA+vO".into(),
            tag: "Kh2mV+ke2KoHpOfaE7p5eQ==".into(),
            ciphertext: "lpQsj4LcNb0l0T6G9G8Pf9Q4mV1X49yjfvbSCL42DTSJ3Tq4WOsmEs/0hJ1Rx3sKI7hoff77wXC9aFar9q4MKBwLDcDfOw0CgEmjz7JOFP0WsSf5RhTgRurAunKn4oVbjFRRhPNwOLJR2tP0XxY/p1Bj/d0/nTey/uFi1RlfR49E5dTPPYV1ZM76UyK1y6j9JKjfgHhy68sZiTWSQ7dwCMxK".into(),
            created_at: 1_700_000_000_000,
        };
        let payload = decrypt_payload(&envelope, "interop-pass").expect("decrypt");
        assert_eq!(payload.version, 1);
        assert!(payload.providers.contains_key("mimo"));
        assert_eq!(
            payload.providers["mimo"].headers["authorization"],
            "Bearer test"
        );
    }
}
