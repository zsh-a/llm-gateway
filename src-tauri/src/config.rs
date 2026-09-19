use std::env;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct Config {
    pub bind_host: String,
    pub port: u16,
    pub request_timeout_ms: u64,
    pub max_body_bytes: usize,
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

fn env_string(name: &str, fallback: impl Into<String>) -> String {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| fallback.into())
}

fn env_u64(name: &str, fallback: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(fallback)
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

        Self {
            bind_host: env_string("BIND_HOST", "127.0.0.1"),
            port: env_u64("PORT", 3000).min(u16::MAX as u64) as u16,
            request_timeout_ms: env_u64("REQUEST_TIMEOUT_MS", 180_000),
            max_body_bytes: env_u64("MAX_BODY_BYTES", 1024 * 1024) as usize,
            proxy_api_key: env::var("PROXY_API_KEY").unwrap_or_default(),
            proxy_admin_key: env::var("PROXY_ADMIN_KEY").unwrap_or_default(),
            cors_origin: env::var("CORS_ORIGIN").unwrap_or_default(),
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
        format!("{}:{}", self.bind_host, self.port)
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
}
