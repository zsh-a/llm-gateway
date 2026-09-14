import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { dirname } from "node:path";

export interface ApiKeyIdentity {
  keyId: string;
  name: string;
  source: "anonymous" | "environment" | "managed";
  allowedModels: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  quotaTokens: number | null;
  usedTokens: number;
}

export interface ApiKeyPublicRecord {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt: number;
  expiresAt: number | null;
  allowedModels: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  quotaTokens: number | null;
  usedTokens: number;
  remainingTokens: number | null;
}

interface StoredApiKey {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  enabled: boolean;
  createdAt: number;
  expiresAt: number | null;
  allowedModels: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  quotaTokens: number | null;
  usedTokens: number;
}

interface StoredKeys {
  version: 1;
  keys: StoredApiKey[];
}

interface CreateApiKeyInput {
  name?: unknown;
  expiresAt?: unknown;
  allowedModels?: unknown;
  rpmLimit?: unknown;
  tpmLimit?: unknown;
  quotaTokens?: unknown;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInt(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function timestampValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function modelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

function normalizeStoredKey(value: unknown): StoredApiKey | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { [key: string]: unknown };
  const id = stringValue(record.id);
  const hash = stringValue(record.hash);
  if (!id || !hash) return null;
  const quotaTokens = positiveInt(record.quotaTokens ?? record.quota_tokens);
  const usedTokens = positiveInt(record.usedTokens ?? record.used_tokens) ?? 0;
  const createdAt = timestampValue(record.createdAt ?? record.created_at) ?? Date.now();
  return {
    id,
    name: stringValue(record.name) || id,
    prefix: stringValue(record.prefix) || "sk-gw-",
    hash,
    enabled: record.enabled !== false,
    createdAt,
    expiresAt: timestampValue(record.expiresAt ?? record.expires_at),
    allowedModels: modelList(record.allowedModels ?? record.allowed_models),
    rpmLimit: positiveInt(record.rpmLimit ?? record.rpm_limit),
    tpmLimit: positiveInt(record.tpmLimit ?? record.tpm_limit),
    quotaTokens,
    usedTokens,
  };
}

function identityFromKey(key: StoredApiKey): ApiKeyIdentity {
  return {
    keyId: key.id,
    name: key.name,
    source: "managed",
    allowedModels: [...key.allowedModels],
    rpmLimit: key.rpmLimit,
    tpmLimit: key.tpmLimit,
    quotaTokens: key.quotaTokens,
    usedTokens: key.usedTokens
  };
}

export class ApiKeyStore {
  private keys: StoredApiKey[] | null = null;
  private readonly requestTimes = new Map<string, number[]>();
  private readonly tokenEvents = new Map<string, Array<{ at: number; tokens: number }>>();

  constructor(
    private readonly file: string,
    private readonly environmentSecret: string
  ) {}

  requiresAuthentication(): boolean {
    this.ensureLoaded();
    return Boolean(this.environmentSecret) || this.keys!.length > 0;
  }

  authenticate(secret: string): ApiKeyIdentity | null {
    this.ensureLoaded();
    if (!secret) return null;
    if (this.environmentSecret && secret === this.environmentSecret) {
      return {
        keyId: "environment",
        name: "环境变量 API Key",
        source: "environment",
        allowedModels: [],
        rpmLimit: null,
        tpmLimit: null,
        quotaTokens: null,
        usedTokens: 0
      };
    }

    const hash = hashSecret(secret);
    const now = Date.now();
    const key = this.keys!.find((item) => (
      item.enabled &&
      item.hash === hash &&
      (item.expiresAt === null || item.expiresAt > now)
    ));
    return key ? identityFromKey(key) : null;
  }

  anonymous(): ApiKeyIdentity {
    return {
      keyId: "anonymous",
      name: "匿名访问",
      source: "anonymous",
      allowedModels: [],
      rpmLimit: null,
      tpmLimit: null,
      quotaTokens: null,
      usedTokens: 0
    };
  }

  authorizeModel(identity: ApiKeyIdentity, model: string): string | null {
    if (identity.source === "anonymous" || identity.allowedModels.length === 0) {
      return null;
    }
    if (identity.allowedModels.includes("*") || identity.allowedModels.includes(model)) {
      return null;
    }
    return `API Key ${identity.name} 无权访问模型 ${model}`;
  }

  reserve(identity: ApiKeyIdentity): string | null {
    if (identity.source !== "managed") return null;
    this.ensureLoaded();
    const key = this.keys!.find((item) => item.id === identity.keyId);
    if (!key || !key.enabled) return "API Key 已被禁用";
    const now = Date.now();
    if (key.rpmLimit !== null) {
      const recent = (this.requestTimes.get(key.id) ?? [])
        .filter((timestamp) => now - timestamp < 60 * 1000);
      if (recent.length >= key.rpmLimit) {
        this.requestTimes.set(key.id, recent);
        return `API Key 已达到每分钟请求上限（${key.rpmLimit}）`;
      }
      recent.push(now);
      this.requestTimes.set(key.id, recent);
    }
    if (key.tpmLimit !== null) {
      const events = (this.tokenEvents.get(key.id) ?? [])
        .filter((event) => now - event.at < 60 * 1000);
      const used = events.reduce((sum, event) => sum + event.tokens, 0);
      this.tokenEvents.set(key.id, events);
      if (used >= key.tpmLimit) {
        return `API Key 已达到每分钟 Token 上限（${key.tpmLimit}）`;
      }
    }
    if (key.quotaTokens !== null && key.usedTokens >= key.quotaTokens) {
      return "API Key Token 配额已用尽";
    }
    return null;
  }

  recordUsage(identity: ApiKeyIdentity | undefined, usage: unknown): void {
    if (!identity || identity.source !== "managed") return;
    const record = usage !== null && typeof usage === "object"
      ? usage as { [key: string]: unknown }
      : {};
    const input = this.numberValue(record.inputTokens ?? record.input_tokens ?? record.prompt_tokens);
    const output = this.numberValue(record.outputTokens ?? record.output_tokens ?? record.completion_tokens);
    const total = this.numberValue(record.totalTokens ?? record.total_tokens) ??
      (input !== undefined && output !== undefined ? input + output : undefined);
    if (total === undefined) return;
    this.ensureLoaded();
    const key = this.keys!.find((item) => item.id === identity.keyId);
    if (!key) return;
    key.usedTokens += total;
    if (key.tpmLimit !== null) {
      const events = (this.tokenEvents.get(key.id) ?? [])
        .filter((event) => Date.now() - event.at < 60 * 1000);
      events.push({ at: Date.now(), tokens: total });
      this.tokenEvents.set(key.id, events);
    }
    this.persist();
  }

  list(): ApiKeyPublicRecord[] {
    this.ensureLoaded();
    return this.keys!.map((key) => this.publicKey(key));
  }

  create(input: CreateApiKeyInput): { record: ApiKeyPublicRecord; secret: string } {
    this.ensureLoaded();
    const now = Date.now();
    const secret = `sk-gw-${randomBytes(24).toString("base64url")}`;
    const key: StoredApiKey = {
      id: `key_${randomBytes(8).toString("hex")}`,
      name: stringValue(input.name) || "未命名 Key",
      prefix: secret.slice(0, 15),
      hash: hashSecret(secret),
      enabled: true,
      createdAt: now,
      expiresAt: timestampValue(input.expiresAt),
      allowedModels: modelList(input.allowedModels),
      rpmLimit: positiveInt(input.rpmLimit),
      tpmLimit: positiveInt(input.tpmLimit),
      quotaTokens: positiveInt(input.quotaTokens),
      usedTokens: 0
    };
    this.keys!.push(key);
    this.persist();
    return { record: this.publicKey(key), secret };
  }

  revoke(id: string): boolean {
    this.ensureLoaded();
    const key = this.keys!.find((item) => item.id === id);
    if (!key) return false;
    key.enabled = false;
    this.persist();
    return true;
  }

  update(id: string, input: CreateApiKeyInput & { enabled?: unknown }): ApiKeyPublicRecord | null {
    this.ensureLoaded();
    const key = this.keys!.find((item) => item.id === id);
    if (!key) return null;
    if (input.name !== undefined) key.name = stringValue(input.name) || key.name;
    if (input.enabled !== undefined && typeof input.enabled === "boolean") {
      key.enabled = input.enabled;
    }
    if (input.allowedModels !== undefined) key.allowedModels = modelList(input.allowedModels);
    if (input.rpmLimit !== undefined) key.rpmLimit = positiveInt(input.rpmLimit);
    if (input.tpmLimit !== undefined) key.tpmLimit = positiveInt(input.tpmLimit);
    if (input.quotaTokens !== undefined) key.quotaTokens = positiveInt(input.quotaTokens);
    if (input.expiresAt !== undefined) key.expiresAt = timestampValue(input.expiresAt);
    this.persist();
    return this.publicKey(key);
  }

  private publicKey(key: StoredApiKey): ApiKeyPublicRecord {
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      enabled: key.enabled,
      createdAt: key.createdAt,
      expiresAt: key.expiresAt,
      allowedModels: [...key.allowedModels],
      rpmLimit: key.rpmLimit,
      tpmLimit: key.tpmLimit,
      quotaTokens: key.quotaTokens,
      usedTokens: key.usedTokens,
      remainingTokens: key.quotaTokens === null
        ? null
        : Math.max(0, key.quotaTokens - key.usedTokens)
    };
  }

  private numberValue(value: unknown): number | undefined {
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) && number >= 0 ? number : undefined;
  }

  private ensureLoaded(): void {
    if (this.keys) return;
    this.keys = [];
    try {
      if (!existsSync(this.file)) return;
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const record = value !== null && typeof value === "object"
        ? value as { [key: string]: unknown }
        : {};
      if (Number(record.version) !== 1 || !Array.isArray(record.keys)) return;
      this.keys = record.keys
        .map(normalizeStoredKey)
        .filter((key): key is StoredApiKey => key !== null);
    } catch {
      this.keys = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const stored: StoredKeys = { version: 1, keys: this.keys! };
    try {
      writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
    } finally {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Best-effort cleanup after an atomic rename.
      }
    }
  }
}
