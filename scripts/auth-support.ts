import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AuthHeaders {
  [key: string]: string;
}

export interface AuthProvider {
  id: string;
  name: string;
  authMethods: string[];
  authHosts: string[];
  authPaths: string[];
  captureHeaders: string[];
  clientCandidates: string[];
}

export interface AuthConfig {
  runtimeDir: string;
  authCacheDir: string;
  channelsFile: string;
}

interface StoredAuth {
  version: 1;
  headers: AuthHeaders;
  capturedAt: number;
}

interface ChannelRecord {
  id?: unknown;
  providerId?: unknown;
  authRef?: unknown;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value.trim() === "" ? fallback : value;
}

function macApplicationBinaries(application: string, executables: string[]): string[] {
  if (process.platform !== "darwin") return [];
  const roots = ["/Applications", process.env.HOME ? join(process.env.HOME, "Applications") : ""]
    .filter(Boolean);
  return roots.flatMap((root) => executables.map((executable) => (
    join(root, `${application}.app`, "Contents", "MacOS", executable)
  )));
}

export function loadAuthConfig(): AuthConfig {
  const runtimeDir = env("RUNTIME_DIR", join(process.cwd(), ".runtime"));
  return {
    runtimeDir,
    authCacheDir: env("AUTH_CACHE_DIR", join(runtimeDir, "auth")),
    channelsFile: env("CHANNELS_FILE", join(runtimeDir, "channels.json"))
  };
}

export const providers: AuthProvider[] = [
  {
    id: "mimo",
    name: "MiMo",
    authMethods: ["POST"],
    authHosts: ["mimo-server-cn.xiaomimimo.com"],
    authPaths: ["/api/route/chat/completions"],
    captureHeaders: ["cookie", "authorization", "x-*"],
    clientCandidates: macApplicationBinaries("Xiaomi MiMo", ["Xiaomi MiMo", "Electron"])
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    authMethods: ["GET", "POST"],
    authHosts: ["copilot.tencent.com"],
    authPaths: ["/v3/config", "/v2/report", "/v2/chat/completions"],
    captureHeaders: ["cookie", "authorization", "x-*"],
    clientCandidates: macApplicationBinaries("WorkBuddy", ["Electron", "WorkBuddy"])
  }
];

export function getProvider(id: string): AuthProvider | undefined {
  return providers.find((provider) => provider.id === id);
}

export function getProviders(): AuthProvider[] {
  return providers.map((provider) => ({ ...provider, clientCandidates: [...provider.clientCandidates] }));
}

function headerEntries(value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) {
    return value.flatMap((item) => (
      Array.isArray(item) && item.length >= 2 ? [[String(item[0]), String(item[1])]] : []
    ));
  }
  return Object.entries(asRecord(value))
    .filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => [key, String(item)]);
}

function isCredentialHeader(key: string): boolean {
  return key === "x-user-id" || key === "x-api-key" || key.includes("auth") || key.endsWith("-token");
}

export function credentialHeaders(input: unknown): AuthHeaders | null {
  const headers: AuthHeaders = {};
  let hasCredential = false;
  for (const [key, itemValue] of headerEntries(input)) {
    const lowerKey = key.toLowerCase();
    if (!itemValue.trim()) continue;
    if (lowerKey === "cookie") {
      headers.cookie = itemValue;
      hasCredential = true;
      continue;
    }
    if (lowerKey === "authorization" || lowerKey.startsWith("x-")) {
      headers[key] = itemValue;
      if (lowerKey === "authorization" || isCredentialHeader(lowerKey)) hasCredential = true;
    }
  }
  if (!hasCredential) return null;
  headers["content-type"] = "application/json";
  headers["accept-encoding"] = "identity";
  return headers;
}

function cacheFile(cacheDir: string, providerId: string): string {
  return join(cacheDir, `${providerId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export class AuthStore {
  constructor(private readonly cacheDir: string) {}

  get(providerId: string): AuthHeaders | null {
    const value = asRecord(readJson(cacheFile(this.cacheDir, providerId)));
    if (Number(value.version) !== 1) return null;
    return credentialHeaders(value.headers);
  }

  save(providerId: string, headers: AuthHeaders): void {
    const normalized = credentialHeaders(headers);
    if (!normalized) throw new Error(`Provider ${providerId} 未提供有效认证头`);
    mkdirSync(this.cacheDir, { recursive: true });
    const file = cacheFile(this.cacheDir, providerId);
    const temporary = `${file}.${process.pid}.tmp`;
    const stored: StoredAuth = { version: 1, headers: normalized, capturedAt: Date.now() };
    writeFileSync(temporary, JSON.stringify(stored, null, 2) + "\n", { mode: 0o600 });
    renameSync(temporary, file);
  }
}

export function channelAuthRef(file: string, channelId: string, providerId: string): string {
  if (!existsSync(file)) return providerId;
  const value = asRecord(readJson(file));
  const channels = Array.isArray(value.channels) ? value.channels : [];
  const channel = channels
    .map((item) => asRecord(item) as ChannelRecord)
    .find((item) => item.id === channelId);
  if (!channel || channel.providerId !== providerId) {
    throw new Error(`未知或不属于 Provider ${providerId} 的 Channel: ${channelId}`);
  }
  return typeof channel.authRef === "string" && channel.authRef.trim()
    ? channel.authRef
    : providerId;
}

export function defaultCaCertFile(): string {
  return join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
}
