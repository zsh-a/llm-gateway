export type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AuthMode = "auto" | "cookie" | "mitm";

export interface AppConfig {
  port: number;
  bindHost: string;
  mitmUrl: string;
  mitmAuth: string;
  mitmCommand: string;
  mitmProxyHost: string;
  mitmProxyPort: number;
  mitmWebHost: string;
  mitmWebPort: number;
  mitmWebPassword: string;
  cookieFile: string;
  upstreamUrl: string;
  cdpJsonUrl: string;
  requestTimeoutMs: number;
  maxBodyBytes: number;
  apiKey: string;
  corsOrigin: string;
  authMode: AuthMode;
  authCacheTtlMs: number;
  authCacheFile: string;
  modelDiscoveryEnabled: boolean;
  modelListUrl: string;
  modelApiKey: string;
  modelCacheTtlMs: number;
  modelCacheFile: string;
  authHosts: string[];
  authPaths: string[];
  captureHeaders: string[];
  runtimeLogDir: string;
  clientBinary: string;
  clientArgs: string[];
  clientProxyBypass: string;
}

export const DEFAULT_MODEL = "mimo-x-pro-preview";

export const FALLBACK_MODEL_IDS = [
  "mimo-x-pro-preview",
  "mimo-pro",
  "mimo-flash"
];

const VALID_EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

const EFFORT_ALIASES: { [key: string]: ReasoningEffort } = {
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

function authModeEnv(): AuthMode {
  const value = process.env.MIMO_AUTH_MODE?.trim().toLowerCase();
  return value === "cookie" || value === "mitm" || value === "auto"
    ? value
    : "auto";
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function jsonStringArrayEnv(name: string): string[] {
  const value = process.env[name];
  if (!value || !value.trim()) return [];

  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function upstreamHostname(upstreamUrl: string): string {
  try {
    return new URL(upstreamUrl).hostname;
  } catch {
    return "mimo-server-cn.xiaomimimo.com";
  }
}

function defaultModelListUrl(upstreamUrl: string): string {
  try {
    const url = new URL(upstreamUrl);
    const internalSuffix = "/route/chat/completions";
    if (url.pathname.endsWith(internalSuffix)) {
      url.pathname = `${url.pathname.slice(0, -internalSuffix.length)}/model/list`;
      url.search = "";
      return url.toString();
    }

    const openAiMatch = url.pathname.match(/^(.*)\/chat\/completions\/?$/);
    if (openAiMatch) {
      url.pathname = `${openAiMatch[1]}/models`;
      url.search = "";
      return url.toString();
    }
  } catch {
    // Fall through to the Desktop-compatible default.
  }

  return "https://mimo-server-cn.xiaomimimo.com/api/model/list";
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

  return EFFORT_ALIASES[value.trim()] ?? fallback;
}

export function loadConfig(): AppConfig {
  const mitmWebHost = env("MITM_WEB_HOST", "127.0.0.1");
  const mitmWebPort = positiveInt("MITM_WEB_PORT", 8081);
  const mitmWebPassword = env("MITM_WEB_PASSWORD", "123456");
  const runtimeLogDir = env("RUNTIME_LOG_DIR", `${process.cwd()}/.runtime`);
  const upstreamUrl = env(
    "MIMO_UPSTREAM_URL",
    "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions"
  );

  return {
    port: positiveInt("PORT", 3000),
    bindHost: env("BIND_HOST", "127.0.0.1"),
    mitmUrl: env("MITM_URL", `http://${mitmWebHost}:${mitmWebPort}/flows`),
    mitmAuth: env("MITM_AUTH", `Bearer ${mitmWebPassword}`),
    mitmCommand: env("MITM_COMMAND", "mitmweb"),
    mitmProxyHost: env("MITM_PROXY_HOST", "127.0.0.1"),
    mitmProxyPort: positiveInt("MITM_PROXY_PORT", 8080),
    mitmWebHost,
    mitmWebPort,
    mitmWebPassword,
    cookieFile: env("MIMO_COOKIE_FILE", `${process.cwd()}/cookie.txt`),
    upstreamUrl,
    cdpJsonUrl: env("CDP_JSON_URL", "http://127.0.0.1:9222/json"),
    requestTimeoutMs: positiveInt("REQUEST_TIMEOUT_MS", 180000),
    maxBodyBytes: positiveInt("MAX_BODY_BYTES", 1024 * 1024),
    apiKey: process.env.MIMO_PROXY_API_KEY ?? "",
    corsOrigin: env("CORS_ORIGIN", "*"),
    authMode: authModeEnv(),
    authCacheTtlMs: positiveInt("AUTH_CACHE_TTL_MS", 5 * 60 * 1000),
    authCacheFile: env(
      "MIMO_AUTH_CACHE_FILE",
      `${runtimeLogDir}/auth.json`
    ),
    modelDiscoveryEnabled: booleanEnv("MIMO_MODEL_DISCOVERY", true),
    modelListUrl: env(
      "MIMO_MODEL_LIST_URL",
      defaultModelListUrl(upstreamUrl)
    ),
    modelApiKey: process.env.MIMO_MODEL_API_KEY ?? "",
    modelCacheTtlMs: positiveInt("MODEL_CACHE_TTL_MS", 5 * 60 * 1000),
    modelCacheFile: env(
      "MIMO_MODEL_CACHE_FILE",
      `${runtimeLogDir}/models.json`
    ),
    authHosts: listEnv("MIMO_AUTH_HOSTS", [upstreamHostname(upstreamUrl)]),
    authPaths: listEnv("MIMO_AUTH_PATHS", ["/api/route/chat/completions"]),
    captureHeaders: listEnv("MIMO_CAPTURE_HEADERS", [
      "cookie",
      "authorization",
      "x-*"
    ]),
    runtimeLogDir,
    clientBinary: env(
      "MIMO_CLIENT_BIN",
      process.platform === "darwin"
        ? "/Applications/Xiaomi MiMo.app/Contents/MacOS/Xiaomi MiMo"
        : ""
    ),
    clientArgs: jsonStringArrayEnv("MIMO_CLIENT_ARGS_JSON"),
    clientProxyBypass: env(
      "MIMO_CLIENT_PROXY_BYPASS",
      "<local>;127.0.0.1;localhost"
    )
  };
}
