import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { join } from "node:path";

import { asRecord } from "./json.js";

export interface AuthHeaders {
  [key: string]: string;
}

export type AuthSource = "cache";

export interface AuthSnapshot {
  headers: AuthHeaders;
  source: AuthSource;
  capturedAt: number;
}

export interface AuthStatus {
  ready: boolean;
  providers: {
    [key: string]: {
      ready: boolean;
      source: AuthSource | null;
      capturedAt: number | null;
    };
  };
}

interface StoredAuth {
  version: 1;
  headers: AuthHeaders;
  capturedAt: number;
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

function isCredentialHeader(key: string): boolean {
  return key === "x-user-id" ||
    key === "x-api-key" ||
    key.includes("auth") ||
    key.endsWith("-token");
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
      if (lowerKey === "authorization" || isCredentialHeader(lowerKey)) {
        hasCredential = true;
      }
    }
  }

  if (!hasCredential) return null;
  headers["content-type"] = "application/json";
  headers["accept-encoding"] = "identity";
  return headers;
}

function cacheFile(cacheDir: string, providerId: string): string {
  const safeProviderId = providerId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(cacheDir, `${safeProviderId}.json`);
}

function readSnapshot(file: string): AuthSnapshot | null {
  try {
    if (!existsSync(file)) return null;
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const record = asRecord(value);
    if (Number(record.version) !== 1) return null;

    const headers = credentialHeaders(record.headers);
    const capturedAt = Number(record.capturedAt);
    if (!headers || !Number.isFinite(capturedAt)) return null;
    return { headers, source: "cache", capturedAt };
  } catch {
    return null;
  }
}

export class AuthStore {
  constructor(private readonly cacheDir: string) {}

  get(providerId: string): AuthSnapshot | null {
    return readSnapshot(cacheFile(this.cacheDir, providerId));
  }

  save(providerId: string, headers: AuthHeaders): void {
    const normalized = credentialHeaders(headers);
    if (!normalized) {
      throw new Error(`Provider ${providerId} 未提供有效认证头`);
    }

    const file = cacheFile(this.cacheDir, providerId);
    const stored: StoredAuth = {
      version: 1,
      headers: normalized,
      capturedAt: Date.now()
    };
    mkdirSync(this.cacheDir, { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
      chmodSync(file, 0o600);
    } finally {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // A best-effort cleanup must not hide the original write error.
      }
    }
  }

  invalidate(providerId: string): void {
    try {
      const file = cacheFile(this.cacheDir, providerId);
      if (existsSync(file)) unlinkSync(file);
    } catch {
      // A stale cache must not prevent the next authentication attempt.
    }
  }

  status(providerIds: string[]): AuthStatus {
    const providers: AuthStatus["providers"] = {};
    let ready = false;

    for (const providerId of providerIds) {
      const snapshot = this.get(providerId);
      providers[providerId] = {
        ready: snapshot !== null,
        source: snapshot?.source ?? null,
        capturedAt: snapshot?.capturedAt ?? null
      };
      if (snapshot) ready = true;
    }

    return { ready, providers };
  }
}
