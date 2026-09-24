use serde::{Deserialize, Serialize};
use std::env;
use std::path::{Path, PathBuf};

const SERVICE_SETTINGS_FILE: &str = "service.json";
pub(crate) const DEFAULT_MAX_BODY_BYTES: usize = 8 * 1024 * 1024;

fn default_connect_timeout_ms() -> u64 {
    15_000
}
fn default_data_timeout_ms() -> u64 {
    180_000
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceSettings {
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub cors_origin: String,
    #[serde(default = "default_connect_timeout_ms")]
    pub connect_timeout_ms: u64,
    #[serde(default = "default_data_timeout_ms")]
    pub first_byte_timeout_ms: u64,
    #[serde(default = "default_data_timeout_ms")]
    pub idle_timeout_ms: u64,
}

impl ServiceSettings {
    pub fn base_url(&self) -> String {
        let host = match self.host.trim() {
            "0.0.0.0" => "127.0.0.1",
            "::" | "[::]" => "::1",
            host => host,
        };
        let host = if host.contains(':') && !host.starts_with('[') {
            format!("[{host}]")
        } else {
            host.to_owned()
        };
        format!("http://{host}:{}", self.port)
    }

    pub fn validate(&self) -> anyhow::Result<()> {
        let host = self.host.trim();
        anyhow::ensure!(!host.is_empty(), "服务 Host 不能为空");
        anyhow::ensure!(host.len() <= 255, "服务 Host 过长");
        anyhow::ensure!(
            !host.chars().any(char::is_whitespace) && !host.contains(['/', '\\']),
            "服务 Host 格式无效"
        );
        anyhow::ensure!(self.port > 0, "服务 Port 必须在 1-65535 范围内");
        parse_cors_origins(&self.cors_origin)?;
        for value in [
            self.connect_timeout_ms,
            self.first_byte_timeout_ms,
            self.idle_timeout_ms,
        ] {
            anyhow::ensure!(
                (1..=86_400_000).contains(&value),
                "超时时间必须大于 0 且不超过 24 小时"
            );
        }
        Ok(())
    }

    pub fn normalized(&self) -> Self {
        Self {
            host: self.host.trim().to_string(),
            port: self.port,
            cors_origin: parse_cors_origins(&self.cors_origin)
                .map(|origins| origins.join(","))
                .unwrap_or_else(|_| self.cors_origin.trim().to_owned()),
            connect_timeout_ms: self.connect_timeout_ms,
            first_byte_timeout_ms: self.first_byte_timeout_ms,
            idle_timeout_ms: self.idle_timeout_ms,
        }
    }
}

/// Empty means desktop origins only; a lone `*` explicitly allows any origin.
pub(crate) fn parse_cors_origins(value: &str) -> anyhow::Result<Vec<String>> {
    let mut origins = Vec::new();
    for value in value
        .split([',', '\n', '\r'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if value == "*" {
            origins.push(value.to_owned());
            continue;
        }
        let invalid = || {
            anyhow::anyhow!(
                "CORS 来源格式无效：请填写 http:// 或 https:// 开头的网站来源，不含路径、查询参数或账号"
            )
        };
        let url = reqwest::Url::parse(value).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "http" | "https")
            || !value
                .to_ascii_lowercase()
                .starts_with(&format!("{}://", url.scheme()))
            || value.chars().any(char::is_whitespace)
            || value.contains(['*', '\\'])
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid());
        }
        let origin = url.origin().ascii_serialization();
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    anyhow::ensure!(
        !origins.iter().any(|origin| origin == "*") || origins.len() == 1,
        "CORS 的 * 必须单独填写，不能与其他来源混用"
    );
    Ok(origins)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cors_sources_are_normalized_and_invalid_origins_are_rejected() {
        assert!(parse_cors_origins(" \n,").unwrap().is_empty());
        assert_eq!(parse_cors_origins(" * ").unwrap(), ["*"]);
        assert_eq!(
            parse_cors_origins(
                "https://CHAT.example.com:443/\nhttp://localhost:5173,https://chat.example.com"
            )
            .unwrap(),
            ["https://chat.example.com", "http://localhost:5173"]
        );
        for invalid in [
            "*,https://chat.example.com",
            "https://*.example.com",
            "null",
            "chat.example.com",
            "https:chat.example.com",
            "ftp://chat.example.com",
            "https://chat.example.com/chat",
            "https://chat.example.com?key=secret",
            "https://chat.example.com#fragment",
            "https://user:secret@chat.example.com",
            "https://chat.exam\tple.com",
        ] {
            assert!(parse_cors_origins(invalid).is_err(), "accepted {invalid}");
        }
    }

    #[test]
    fn cors_settings_persist_and_older_service_files_still_load() {
        let runtime = tempfile::tempdir().unwrap();
        let config = crate::gateway::AppState::test_state(runtime.path()).config;
        let path = runtime.path().join(SERVICE_SETTINGS_FILE);
        std::fs::write(&path, r#"{"host":"127.0.0.1","port":3000}"#).unwrap();
        let mut settings = load_service_settings(runtime.path()).unwrap();
        assert!(settings.cors_origin.is_empty());
        assert_eq!(settings.connect_timeout_ms, 15_000);
        assert_eq!(settings.first_byte_timeout_ms, 180_000);
        assert_eq!(settings.idle_timeout_ms, 180_000);
        settings.connect_timeout_ms = 5000;
        settings.first_byte_timeout_ms = 600_000;
        settings.idle_timeout_ms = 90_000;
        settings.cors_origin = "https://chat.example.com/\nhttp://localhost:5173".into();
        config.save_service_settings(&settings).unwrap();
        let saved = load_service_settings(runtime.path()).unwrap();
        assert_eq!(
            saved.cors_origin,
            "https://chat.example.com,http://localhost:5173"
        );
        assert_eq!(saved.host, "127.0.0.1");
        assert_eq!(saved.connect_timeout_ms, 5000);
        assert_eq!(saved.first_byte_timeout_ms, 600_000);
        assert_eq!(saved.idle_timeout_ms, 90_000);
        settings.cors_origin = "invalid".into();
        assert!(config.save_service_settings(&settings).is_err());
        assert_eq!(
            load_service_settings(runtime.path()).unwrap().cors_origin,
            saved.cors_origin
        );
    }

    #[test]
    fn client_addresses_are_not_wildcard_bind_addresses() {
        for (host, expected) in [
            ("0.0.0.0", "http://127.0.0.1:3000"),
            ("::", "http://[::1]:3000"),
            ("[::]", "http://[::1]:3000"),
            ("::1", "http://[::1]:3000"),
            ("[::1]", "http://[::1]:3000"),
            (" localhost ", "http://localhost:3000"),
            ("192.168.1.10", "http://192.168.1.10:3000"),
        ] {
            assert_eq!(
                ServiceSettings {
                    host: host.into(),
                    port: 3000,
                    cors_origin: String::new(),
                    connect_timeout_ms: default_connect_timeout_ms(),
                    first_byte_timeout_ms: default_data_timeout_ms(),
                    idle_timeout_ms: default_data_timeout_ms(),
                }
                .base_url(),
                expected
            );
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_host: String,
    pub port: u16,
    pub connect_timeout_ms: u64,
    pub first_byte_timeout_ms: u64,
    pub idle_timeout_ms: u64,
    pub max_body_bytes: usize,
    pub max_response_bytes: usize,
    pub proxy_api_key: String,
    pub proxy_admin_key: String,
    pub cors_origin: String,
    pub runtime_dir: PathBuf,
    pub auth_cache_dir: PathBuf,
    pub channels_file: PathBuf,
    pub api_keys_file: PathBuf,
    pub model_file: Option<PathBuf>,
    pub model_discovery: bool,
    pub model_discovery_timeout_ms: u64,
    pub default_model: String,
    pub metrics_max_records: i64,
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
}

fn env_port(name: &str) -> Option<u16> {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
}

fn load_service_settings(runtime_dir: &Path) -> Option<ServiceSettings> {
    let path = runtime_dir.join(SERVICE_SETTINGS_FILE);
    let raw = std::fs::read_to_string(path).ok()?;
    let settings = serde_json::from_str::<ServiceSettings>(&raw)
        .ok()?
        .normalized();
    if settings.validate().is_ok() {
        Some(settings)
    } else {
        None
    }
}

fn env_bool(name: &str, fallback: bool) -> bool {
    match env::var(name).ok().as_deref().map(str::to_ascii_lowercase) {
        Some(value) if ["0", "false", "no", "off"].contains(&value.as_str()) => false,
        Some(value) if ["1", "true", "yes", "on"].contains(&value.as_str()) => true,
        _ => fallback,
    }
}

impl Config {
    pub fn from_env() -> Self {
        let runtime_dir = env::var("RUNTIME_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                if cfg!(debug_assertions) {
                    std::env::current_dir()
                        .unwrap_or_else(|_| PathBuf::from("."))
                        .join(".runtime")
                } else {
                    dirs::data_local_dir()
                        .unwrap_or_else(|| PathBuf::from("."))
                        .join("LLM Gateway")
                }
            });
        let auth_cache_dir = env::var("AUTH_CACHE_DIR")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(|| runtime_dir.join("auth"));
        let model_file = env::var("WORKBUDDY_MODEL_FILE")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .map(PathBuf::from);
        let persisted_service = load_service_settings(&runtime_dir);
        let bind_host = env::var("BIND_HOST")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .or_else(|| persisted_service.as_ref().map(|value| value.host.clone()))
            .unwrap_or_else(|| "127.0.0.1".into());
        let port = env_port("PORT")
            .or_else(|| persisted_service.as_ref().map(|value| value.port))
            .unwrap_or(3000);
        let cors_origin = env::var("CORS_ORIGIN")
            .ok()
            .or_else(|| {
                persisted_service
                    .as_ref()
                    .map(|value| value.cors_origin.clone())
            })
            .unwrap_or_default();
        // Legacy REQUEST_TIMEOUT_MS now supplies data-wait limits, never a total stream lifetime.
        let data_fallback = |saved| env_u64("REQUEST_TIMEOUT_MS", saved);
        let connect_timeout_ms = env_u64(
            "UPSTREAM_CONNECT_TIMEOUT_MS",
            persisted_service
                .as_ref()
                .map_or(default_connect_timeout_ms(), |s| s.connect_timeout_ms),
        );
        let first_byte_timeout_ms = env_u64(
            "UPSTREAM_FIRST_BYTE_TIMEOUT_MS",
            data_fallback(
                persisted_service
                    .as_ref()
                    .map_or(default_data_timeout_ms(), |s| s.first_byte_timeout_ms),
            ),
        );
        let idle_timeout_ms = env_u64(
            "UPSTREAM_IDLE_TIMEOUT_MS",
            data_fallback(
                persisted_service
                    .as_ref()
                    .map_or(default_data_timeout_ms(), |s| s.idle_timeout_ms),
            ),
        );

        Self {
            bind_host,
            port,
            connect_timeout_ms,
            first_byte_timeout_ms,
            idle_timeout_ms,
            max_body_bytes: env_u64("MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES as u64) as usize,
            max_response_bytes: env_u64("MAX_RESPONSE_BYTES", DEFAULT_MAX_BODY_BYTES as u64).max(1)
                as usize,
            proxy_api_key: env::var("PROXY_API_KEY").unwrap_or_default(),
            proxy_admin_key: env::var("PROXY_ADMIN_KEY").unwrap_or_default(),
            cors_origin,
            runtime_dir: runtime_dir.clone(),
            auth_cache_dir,
            channels_file: env::var("CHANNELS_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| runtime_dir.join("channels.json")),
            api_keys_file: env::var("API_KEYS_FILE")
                .map(PathBuf::from)
                .unwrap_or_else(|_| runtime_dir.join("api-keys.json")),
            model_file,
            model_discovery: env_bool("MODEL_DISCOVERY", true),
            model_discovery_timeout_ms: env_u64("MODEL_DISCOVERY_TIMEOUT_MS", 30_000),
            default_model: env::var("DEFAULT_MODEL").unwrap_or_default(),
            metrics_max_records: env_u64("METRICS_MAX_RECORDS", 2000) as i64,
        }
    }

    pub fn database_path(&self) -> PathBuf {
        env::var("DATABASE_FILE")
            .map(PathBuf::from)
            .unwrap_or_else(|_| self.runtime_dir.join("gateway.sqlite3"))
    }

    pub fn bind_address(&self) -> String {
        if self.bind_host.contains(':') && !self.bind_host.starts_with('[') {
            format!("[{}]:{}", self.bind_host, self.port)
        } else {
            format!("{}:{}", self.bind_host, self.port)
        }
    }

    pub fn is_loopback(&self) -> bool {
        matches!(
            self.bind_host.trim().to_ascii_lowercase().as_str(),
            "localhost" | "127.0.0.1" | "::1" | "[::1]"
        )
    }

    pub fn ensure_runtime_dir(&self) -> anyhow::Result<()> {
        std::fs::create_dir_all(&self.runtime_dir)?;
        std::fs::create_dir_all(&self.auth_cache_dir)?;
        if let Some(parent) = self.database_path().parent() {
            std::fs::create_dir_all(parent)?;
        }
        Ok(())
    }

    pub fn auth_path(&self, provider: &str) -> PathBuf {
        self.auth_cache_dir.join(format!("{provider}.json"))
    }

    pub fn service_settings(&self) -> ServiceSettings {
        ServiceSettings {
            host: self.bind_host.clone(),
            port: self.port,
            cors_origin: self.cors_origin.clone(),
            connect_timeout_ms: self.connect_timeout_ms,
            first_byte_timeout_ms: self.first_byte_timeout_ms,
            idle_timeout_ms: self.idle_timeout_ms,
        }
    }

    pub fn save_service_settings(&self, settings: &ServiceSettings) -> anyhow::Result<()> {
        let settings = settings.normalized();
        settings.validate()?;
        self.ensure_runtime_dir()?;
        let path = self.runtime_dir.join(SERVICE_SETTINGS_FILE);
        let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
        std::fs::write(&temporary, serde_json::to_vec_pretty(&settings)?)?;
        #[cfg(windows)]
        if path.exists() {
            std::fs::remove_file(&path)?;
        }
        std::fs::rename(temporary, path)?;
        Ok(())
    }
}
