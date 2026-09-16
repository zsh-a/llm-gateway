export type ReasoningEffort =
  | "none"
  | "minimal"
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
  modelDiscoveryTimeoutMs: number;
  modelAllowlist: string[];
  modelCacheTtlMs: number;
  modelCacheDir: string;
  modelFiles?: { [providerId: string]: string };
  defaultModel: string;
  responseStoreMaxEntries: number;
  responseStoreTtlMs: number;
  responseStoreMaxBytes: number;
  metricsMaxRecords: number;
  channelsFile: string;
  apiKeysFile: string;
  metricsFile: string;
  adminKey: string;
}

const VALID_EFFORTS: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

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

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" ||
    normalized === "::1" || normalized === "[::1]";
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

  return fallback;
}

export function loadConfig(): GatewayConfig {
  const runtimeDir = env("RUNTIME_DIR", `${process.cwd()}/.runtime`);
  const config: GatewayConfig = {
    port: positiveInt("PORT", 3000),
    bindHost: env("BIND_HOST", "127.0.0.1"),
    requestTimeoutMs: positiveInt("REQUEST_TIMEOUT_MS", 180000),
    maxBodyBytes: positiveInt("MAX_BODY_BYTES", 1024 * 1024),
    apiKey: process.env.PROXY_API_KEY ?? "",
    // The embedded UI is same-origin. Cross-origin browser access must be an
    // explicit deployment choice instead of the default.
    corsOrigin: env("CORS_ORIGIN", ""),
    runtimeDir,
    authCacheDir: env("AUTH_CACHE_DIR", `${runtimeDir}/auth`),
    modelDiscoveryEnabled: !["0", "false", "no", "off"].includes(
      env("MODEL_DISCOVERY", "true").trim().toLowerCase()
    ),
    modelDiscoveryTimeoutMs: positiveInt("MODEL_DISCOVERY_TIMEOUT_MS", 30_000),
    modelAllowlist: listEnv("MODEL_ALLOWLIST", []),
    modelCacheTtlMs: positiveInt("MODEL_CACHE_TTL_MS", 5 * 60 * 1000),
    modelCacheDir: env("MODEL_CACHE_DIR", `${runtimeDir}/models`),
    modelFiles: {
      workbuddy: env(
        "WORKBUDDY_MODEL_FILE",
        process.platform === "darwin"
          ? "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json"
          : ""
      )
    },
    defaultModel: env("DEFAULT_MODEL", ""),
    responseStoreMaxEntries: positiveInt("RESPONSE_STORE_MAX_ENTRIES", 128),
    responseStoreTtlMs: positiveInt("RESPONSE_STORE_TTL_MS", 60 * 60 * 1000),
    responseStoreMaxBytes: positiveInt("RESPONSE_STORE_MAX_BYTES", 8 * 1024 * 1024),
    metricsMaxRecords: positiveInt("METRICS_MAX_RECORDS", 2000),
    channelsFile: env("CHANNELS_FILE", `${runtimeDir}/channels.json`),
    apiKeysFile: env("API_KEYS_FILE", `${runtimeDir}/api-keys.json`),
    metricsFile: env("METRICS_FILE", `${runtimeDir}/metrics.json`),
    adminKey: process.env.PROXY_ADMIN_KEY ?? ""
  };

  // Desktop mode resolves configuration in the parent process. Reusing that
  // snapshot keeps the child from silently switching runtime directories when
  // its environment or working directory differs.
  const resolved = process.env.LLM_GATEWAY_RESOLVED_CONFIG;
  if (!resolved) return config;
  try {
    const value: unknown = JSON.parse(resolved);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return { ...config, ...value as Partial<GatewayConfig> };
    }
  } catch {
    // Fall back to normal environment parsing if the snapshot is malformed.
  }
  return config;
}
