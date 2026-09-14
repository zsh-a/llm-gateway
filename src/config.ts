export type ReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export interface GatewayConfig {
  port: number;
  bindHost: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  apiKey: string;
  corsOrigin: string;
  runtimeDir: string;
  authCacheDir: string;
  modelDiscoveryEnabled: boolean;
  modelAllowlist: string[];
  modelCacheTtlMs: number;
  modelCacheDir: string;
  defaultModel: string;
  metricsMaxRecords: number;
  channelsFile: string;
  apiKeysFile: string;
  metricsFile: string;
  adminKey: string;
}

const VALID_EFFORTS: ReasoningEffort[] = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

const EFFORT_ALIASES: { [key: string]: ReasoningEffort } = {
  minimal: "low",
  ultra: "max",
  "无": "none",
  "低": "low",
  "中": "medium",
  "高": "high",
  "超高": "xhigh",
  "极高": "max",
  "最大": "max"
};

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function listEnv(name: string, fallback: string[]): string[] {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function normalizeEffort(
  value: unknown,
  fallback: ReasoningEffort = "medium"
): ReasoningEffort {
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (VALID_EFFORTS.includes(normalized as ReasoningEffort)) {
    return normalized as ReasoningEffort;
  }

  return EFFORT_ALIASES[normalized] ?? EFFORT_ALIASES[value.trim()] ?? fallback;
}

export function loadConfig(): GatewayConfig {
  const runtimeDir = env("RUNTIME_DIR", `${process.cwd()}/.runtime`);
  return {
    port: positiveInt("PORT", 3000),
    bindHost: env("BIND_HOST", "127.0.0.1"),
    requestTimeoutMs: positiveInt("REQUEST_TIMEOUT_MS", 180000),
    maxBodyBytes: positiveInt("MAX_BODY_BYTES", 1024 * 1024),
    apiKey: process.env.PROXY_API_KEY ?? "",
    corsOrigin: env("CORS_ORIGIN", "*"),
    runtimeDir,
    authCacheDir: env("AUTH_CACHE_DIR", `${runtimeDir}/auth`),
    modelDiscoveryEnabled: !["0", "false", "no", "off"].includes(
      env("MODEL_DISCOVERY", "true").trim().toLowerCase()
    ),
    modelAllowlist: listEnv("MODEL_ALLOWLIST", []),
    modelCacheTtlMs: positiveInt("MODEL_CACHE_TTL_MS", 5 * 60 * 1000),
    modelCacheDir: env("MODEL_CACHE_DIR", `${runtimeDir}/models`),
    defaultModel: env("DEFAULT_MODEL", ""),
    metricsMaxRecords: positiveInt("METRICS_MAX_RECORDS", 2000),
    channelsFile: env("CHANNELS_FILE", `${runtimeDir}/channels.json`),
    apiKeysFile: env("API_KEYS_FILE", `${runtimeDir}/api-keys.json`),
    metricsFile: env("METRICS_FILE", `${runtimeDir}/metrics.json`),
    adminKey: process.env.PROXY_ADMIN_KEY ?? ""
  };
}
