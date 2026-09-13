import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import type { AppConfig } from "./config.js";

export interface AuthHeaders {
  [key: string]: string;
}

export type AuthSource = "environment" | "file" | "cache" | "mitmproxy";

export interface AuthSnapshot {
  headers: AuthHeaders;
  source: AuthSource;
  capturedAt: number;
}

export interface AuthStatus {
  ready: boolean;
  source: AuthSource | null;
  cached: boolean;
  checkedAt: number | null;
  providers: { [key: string]: "ready" | "missing" | "error" };
}

interface AuthProvider {
  readonly name: string;
  load(): Promise<AuthSnapshot | null>;
}

interface FlowRequest {
  method?: unknown;
  host?: unknown;
  pretty_host?: unknown;
  path?: unknown;
  url?: unknown;
  headers?: unknown;
}

interface StoredAuth {
  version: 1;
  headers: AuthHeaders;
  capturedAt: number;
}

function asRecord(value: unknown): { [key: string]: unknown } {
  return value !== null && typeof value === "object"
    ? value as { [key: string]: unknown }
    : {};
}

function headerEntries(value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) {
    const entries: Array<[string, string]> = [];
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        entries.push([String(item[0]), String(item[1])]);
      }
    }
    return entries;
  }

  const record = asRecord(value);
  const entries: Array<[string, string]> = [];
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (item !== undefined && item !== null) {
      entries.push([key, String(item)]);
    }
  }
  return entries;
}

function headersForCookie(cookie: string): AuthHeaders {
  return {
    cookie,
    "content-type": "application/json",
    "accept-encoding": "identity"
  };
}

function credentialHeaders(input: unknown): AuthHeaders | null {
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
      hasCredential = true;
    }
  }

  if (!hasCredential) return null;
  headers["content-type"] = "application/json";
  headers["accept-encoding"] = "identity";
  return headers;
}

function snapshot(
  headers: AuthHeaders,
  source: AuthSource
): AuthSnapshot {
  return { headers, source, capturedAt: Date.now() };
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

function hostFromRequest(request: FlowRequest): string {
  const direct = request.host ?? request.pretty_host;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().toLowerCase().split(":")[0];
  }

  if (typeof request.url === "string") {
    try {
      return new URL(request.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }

  return "";
}

function pathFromRequest(request: FlowRequest): string {
  const path = typeof request.path === "string" ? request.path : "";
  if (path) return path.split("?", 1)[0];

  if (typeof request.url === "string") {
    try {
      return new URL(request.url).pathname;
    } catch {
      return "";
    }
  }

  return "";
}

function matchesHost(host: string, configuredHosts: string[]): boolean {
  if (configuredHosts.length === 0) return true;
  return configuredHosts.some((pattern) => {
    const normalized = pattern.toLowerCase();
    return wildcardMatch(host, normalized) || host.endsWith(`.${normalized}`);
  });
}

function matchesPath(path: string, configuredPaths: string[]): boolean {
  if (configuredPaths.length === 0) return true;
  return configuredPaths.some((pattern) => wildcardMatch(path, pattern));
}

function isCapturedHeader(name: string, configured: string[]): boolean {
  const lowerName = name.toLowerCase();
  return configured.some((pattern) => wildcardMatch(lowerName, pattern.toLowerCase()));
}

function headersForFlow(
  request: FlowRequest,
  configuredHeaders: string[]
): AuthHeaders | null {
  const headers: AuthHeaders = {};
  const cookies: string[] = [];
  let hasCredential = false;

  for (const [key, value] of headerEntries(request.headers)) {
    const lowerKey = key.toLowerCase();
    if (!isCapturedHeader(lowerKey, configuredHeaders)) continue;

    if (lowerKey === "cookie") {
      cookies.push(value);
      hasCredential = true;
    } else {
      headers[key] = value;
      if (lowerKey === "authorization" || lowerKey.startsWith("x-")) {
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) return null;
  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  headers["content-type"] = "application/json";
  headers["accept-encoding"] = "identity";
  return headers;
}

class EnvironmentProvider implements AuthProvider {
  readonly name = "environment";

  async load(): Promise<AuthSnapshot | null> {
    const cookie = process.env.MIMO_COOKIE?.trim();
    return cookie ? snapshot(headersForCookie(cookie), "environment") : null;
  }
}

class CookieFileProvider implements AuthProvider {
  readonly name = "file";

  constructor(private readonly file: string) {}

  async load(): Promise<AuthSnapshot | null> {
    try {
      if (!existsSync(this.file)) return null;
      const cookie = readFileSync(this.file, "utf8").trim();
      return cookie ? snapshot(headersForCookie(cookie), "file") : null;
    } catch {
      return null;
    }
  }
}

class PersistentCacheProvider implements AuthProvider {
  readonly name = "cache";

  constructor(private readonly file: string) {}

  async load(): Promise<AuthSnapshot | null> {
    try {
      if (!existsSync(this.file)) return null;
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const record = asRecord(value);
      if (Number(record.version) !== 1) return null;

      const headers = credentialHeaders(record.headers);
      return headers ? snapshot(headers, "cache") : null;
    } catch {
      return null;
    }
  }
}

function persistAuth(file: string, auth: AuthSnapshot): void {
  const headers = credentialHeaders(auth.headers);
  if (!headers) return;

  const stored: StoredAuth = {
    version: 1,
    headers,
    capturedAt: auth.capturedAt
  };

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(stored)}\n`);
    chmodSync(file, 0o600);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`无法保存认证缓存 ${file}: ${message}`);
  }
}

function clearPersistedAuth(file: string): void {
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch {
    // A stale cache should never prevent a new authentication attempt.
  }
}

class MitmFlowProvider implements AuthProvider {
  readonly name = "mitmproxy";

  constructor(private readonly config: AppConfig) {}

  async load(): Promise<AuthSnapshot | null> {
    try {
      const response = await fetch(this.config.mitmUrl, {
        headers: { Authorization: this.config.mitmAuth }
      });
      if (!response.ok) return null;

      const flows: unknown = await response.json();
      if (!Array.isArray(flows)) return null;

      for (let index = flows.length - 1; index >= 0; index -= 1) {
        const flow = asRecord(flows[index]);
        const request = asRecord(flow.request) as FlowRequest;
        const responseInfo = asRecord(flow.response);
        const statusCode = Number(responseInfo.status_code);
        const method = String(request.method ?? "").toUpperCase();
        if (
          (method === "" || method === "POST") &&
          statusCode === 200 &&
          matchesHost(hostFromRequest(request), this.config.authHosts) &&
          matchesPath(pathFromRequest(request), this.config.authPaths)
        ) {
          const headers = headersForFlow(request, this.config.captureHeaders);
          if (headers) return snapshot(headers, "mitmproxy");
        }
      }
    } catch {
      return null;
    }

    return null;
  }
}

export class AuthManager {
  private readonly providers: AuthProvider[];
  private cached: AuthSnapshot | null;
  private loading: Promise<AuthSnapshot | null> | null;
  private checkedAt: number | null;
  private providerStates: { [key: string]: "ready" | "missing" | "error" };

  constructor(private readonly config: AppConfig) {
    const environment = new EnvironmentProvider();
    const file = new CookieFileProvider(config.cookieFile);
    const cache = new PersistentCacheProvider(config.authCacheFile);
    const mitmproxy = new MitmFlowProvider(config);

    this.providers = config.authMode === "cookie"
      ? [environment, file, cache]
      : config.authMode === "mitm"
        ? [cache, mitmproxy]
        : [environment, file, cache, mitmproxy];
    this.cached = null;
    this.loading = null;
    this.checkedAt = null;
    this.providerStates = {};
  }

  async get(): Promise<AuthHeaders | null> {
    const now = Date.now();
    if (
      this.cached &&
      now - this.cached.capturedAt < this.config.authCacheTtlMs
    ) {
      return this.cached.headers;
    }

    if (this.loading) {
      const current = await this.loading;
      return current?.headers ?? null;
    }

    this.loading = this.loadProviders();
    try {
      const current = await this.loading;
      this.cached = current;
      return current?.headers ?? null;
    } finally {
      this.loading = null;
    }
  }

  invalidate(): void {
    const source = this.cached?.source;
    this.cached = null;
    if (source === "cache" || source === "mitmproxy") {
      clearPersistedAuth(this.config.authCacheFile);
    }
  }

  async status(): Promise<AuthStatus> {
    const headers = await this.get();
    return {
      ready: headers !== null,
      source: this.cached?.source ?? null,
      cached: this.cached !== null,
      checkedAt: this.checkedAt,
      providers: { ...this.providerStates }
    };
  }

  private async loadProviders(): Promise<AuthSnapshot | null> {
    this.checkedAt = Date.now();
    this.providerStates = {};

    for (const provider of this.providers) {
      try {
        const current = await provider.load();
        this.providerStates[provider.name] = current ? "ready" : "missing";
        if (current) {
          if (current.source === "mitmproxy") {
            persistAuth(this.config.authCacheFile, current);
          }
          return current;
        }
      } catch {
        this.providerStates[provider.name] = "error";
      }
    }

    return null;
  }
}

let defaultManager: AuthManager | null = null;
let defaultConfig: AppConfig | null = null;

function managerFor(config: AppConfig): AuthManager {
  if (!defaultManager || defaultConfig !== config) {
    defaultConfig = config;
    defaultManager = new AuthManager(config);
  }
  return defaultManager;
}

export async function getAuth(config: AppConfig): Promise<AuthHeaders | null> {
  return managerFor(config).get();
}

export async function getAuthStatus(config: AppConfig): Promise<AuthStatus> {
  return managerFor(config).status();
}

export function invalidateAuth(config: AppConfig): void {
  managerFor(config).invalidate();
}
