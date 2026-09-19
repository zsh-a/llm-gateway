#!/usr/bin/env node

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

import {
  asRecord,
  credentialHeaders,
  loadAuthConfig,
  type AuthHeaders,
} from "./auth-support.js";

const ENVELOPE_FORMAT = 1;
const MAX_LOCAL_PAYLOAD_BYTES = 512 * 1024;
const SCRYPT_OPTIONS = {
  N: 32_768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

interface AuthRecord {
  version: 1;
  headers: AuthHeaders;
  capturedAt: number;
}

interface VaultPayload {
  version: 1;
  createdAt: number;
  providers: Record<string, AuthRecord>;
}

interface EncryptedEnvelope {
  format: 1;
  algorithm: "scrypt-aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
}

interface SyncState {
  revision: number;
  updatedAt: number;
}

interface SyncConfig {
  baseUrl: string;
  token: string;
  vaultId: string;
  authCacheDir: string;
  runtimeDir: string;
}

class SyncError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

function env(name: string): string {
  return process.env[name]?.trim() ?? "";
}

function config(): SyncConfig {
  const auth = loadAuthConfig();
  const baseUrl = env("SYNC_URL").replace(/\/+$/, "");
  const token = env("SYNC_TOKEN");
  const vaultId = env("SYNC_VAULT_ID") || "default";
  if (!baseUrl) throw new SyncError("请设置 SYNC_URL，例如 https://sync.example.com");
  if (!/^https?:\/\//i.test(baseUrl)) throw new SyncError("SYNC_URL 必须是 http 或 https 地址");
  if (!token) throw new SyncError("请设置 SYNC_TOKEN");
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(vaultId)) {
    throw new SyncError("SYNC_VAULT_ID 只能包含字母、数字、下划线和短横线");
  }
  return {
    baseUrl,
    token,
    vaultId,
    authCacheDir: auth.authCacheDir,
    runtimeDir: auth.runtimeDir,
  };
}

function endpoint(settings: SyncConfig): string {
  return `${settings.baseUrl}/v1/vault/${encodeURIComponent(settings.vaultId)}`;
}

function statePath(settings: SyncConfig): string {
  return join(settings.runtimeDir, ".sync-state.json");
}

function parseJsonFile(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

function readAuthPayload(cacheDir: string): VaultPayload {
  const providers: Record<string, AuthRecord> = {};
  if (existsSync(cacheDir)) {
    for (const file of readdirSync(cacheDir).sort()) {
      if (!file.endsWith(".json")) continue;
      const providerId = file.slice(0, -5);
      if (!/^[A-Za-z0-9_-]+$/.test(providerId)) continue;
      const value = asRecord(parseJsonFile(join(cacheDir, file)));
      const headers = credentialHeaders(value.headers);
      if (!headers) continue;
      const capturedAt = Number(value.capturedAt);
      providers[providerId] = {
        version: 1,
        headers,
        capturedAt: Number.isFinite(capturedAt) && capturedAt > 0 ? capturedAt : Date.now(),
      };
    }
  }
  if (Object.keys(providers).length === 0) {
    throw new SyncError(`未在 ${cacheDir} 找到有效认证缓存，请先运行 npm run auth`);
  }
  return { version: 1, createdAt: Date.now(), providers };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, SCRYPT_OPTIONS);
}

function encryptPayload(payload: VaultPayload, passphrase: string): EncryptedEnvelope {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(passphrase, salt), iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  if (plaintext.byteLength > MAX_LOCAL_PAYLOAD_BYTES) {
    throw new SyncError("本机认证包超过大小限制");
  }
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    format: ENVELOPE_FORMAT,
    algorithm: "scrypt-aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt: Date.now(),
  };
}

function decodeEnvelope(value: unknown): EncryptedEnvelope {
  const object = asRecord(value);
  if (
    object.format !== ENVELOPE_FORMAT
    || object.algorithm !== "scrypt-aes-256-gcm"
    || typeof object.salt !== "string"
    || typeof object.iv !== "string"
    || typeof object.tag !== "string"
    || typeof object.ciphertext !== "string"
  ) {
    throw new SyncError("远端加密保险库格式无效");
  }
  decodeBase64(object.salt, 16, 16);
  decodeBase64(object.iv, 12, 12);
  decodeBase64(object.tag, 16, 16);
  decodeBase64(object.ciphertext, undefined, MAX_LOCAL_PAYLOAD_BYTES);
  if (typeof object.createdAt !== "number" || !Number.isFinite(object.createdAt)) {
    throw new SyncError("远端加密保险库时间戳无效");
  }
  return object as unknown as EncryptedEnvelope;
}

function decodeBase64(value: string, expectedLength: number | undefined, maximumLength: number): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new SyncError("远端加密保险库编码无效");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length > maximumLength || (expectedLength !== undefined && decoded.length !== expectedLength)) {
    throw new SyncError("远端加密保险库大小无效");
  }
  return decoded;
}

function decryptPayload(value: unknown, passphrase: string): VaultPayload {
  const envelope = decodeEnvelope(value);
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      deriveKey(passphrase, Buffer.from(envelope.salt, "base64")),
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    const value = asRecord(JSON.parse(plaintext.toString("utf8")) as unknown);
    if (value.version !== 1 || !value.providers || typeof value.providers !== "object") {
      throw new Error("payload");
    }
    return value as unknown as VaultPayload;
  } catch {
    throw new SyncError("解密失败：密码错误或认证包已损坏");
  }
}

function writeAtomic(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  renameSync(temporary, file);
  chmodSync(file, 0o600);
}

function writeAuthPayload(cacheDir: string, payload: VaultPayload): string[] {
  const written: string[] = [];
  for (const [providerId, record] of Object.entries(payload.providers).sort()) {
    if (!/^[A-Za-z0-9_-]+$/.test(providerId)) continue;
    const headers = credentialHeaders(record.headers);
    if (!headers) continue;
    writeAtomic(
      join(cacheDir, `${providerId}.json`),
      JSON.stringify({ version: 1, headers, capturedAt: record.capturedAt }, null, 2) + "\n",
    );
    written.push(providerId);
  }
  if (written.length === 0) throw new SyncError("认证包中没有有效 Provider");
  return written;
}

function readState(settings: SyncConfig): SyncState | null {
  const value = asRecord(parseJsonFile(statePath(settings)));
  const revision = Number(value.revision);
  const updatedAt = Number(value.updatedAt);
  return Number.isSafeInteger(revision) && revision > 0
    ? { revision, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 }
    : null;
}

function saveState(settings: SyncConfig, state: SyncState): void {
  writeAtomic(statePath(settings), JSON.stringify(state, null, 2) + "\n");
}

async function readSecret(prompt: string): Promise<string> {
  const configured = env("SYNC_PASSPHRASE");
  if (configured) return configured;
  const input = process.stdin;
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    const reader = createInterface({ input, output: process.stderr });
    const answer = await reader.question(`${prompt}: `);
    reader.close();
    return answer.trim();
  }
  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw ?? false;
    let answer = "";
    const cleanup = (): void => {
      input.setRawMode?.(wasRaw);
      input.pause();
      input.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new SyncError("已取消"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(answer);
          return;
        }
        if (character === "\u007f") {
          answer = answer.slice(0, -1);
          continue;
        }
        answer += character;
      }
    };
    process.stderr.write(`${prompt}: `);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    input.on("data", onData);
  });
}

async function requestJson(
  settings: SyncConfig,
  init: RequestInit = {},
): Promise<{ body: unknown; response: Response }> {
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  headers.set("authorization", `Bearer ${settings.token}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  const response = await fetch(endpoint(settings), { ...init, headers });
  const raw = await response.text();
  let body: unknown = {};
  try {
    body = raw ? JSON.parse(raw) as unknown : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const error = asRecord(asRecord(body).error);
    throw new SyncError(
      typeof error.message === "string" ? error.message : `同步服务返回 HTTP ${response.status}`,
      response.status,
    );
  }
  return { body, response };
}

async function push(settings: SyncConfig, force: boolean): Promise<void> {
  const payload = readAuthPayload(settings.authCacheDir);
  const passphrase = await readSecret("同步加密密码");
  if (passphrase.length < 8) throw new SyncError("同步加密密码至少需要 8 个字符");
  const state = readState(settings);
  const headers = new Headers();
  if (state) headers.set("if-match", `"${state.revision}"`);
  if (force) headers.set("x-sync-force", "1");
  try {
    const { body } = await requestJson(settings, {
      method: "PUT",
      headers,
      body: JSON.stringify({ envelope: encryptPayload(payload, passphrase) }),
    });
    const result = asRecord(body);
    const revision = Number(result.revision);
    const updatedAt = Number(result.updatedAt);
    if (!Number.isSafeInteger(revision)) throw new SyncError("同步服务返回了无效版本号");
    saveState(settings, { revision, updatedAt });
    console.log(`已上传 ${Object.keys(payload.providers).join(", ")}，远端版本 ${revision}`);
  } catch (error) {
    if (error instanceof SyncError && (error.status === 409 || error.status === 428)) {
      throw new SyncError(`${error.message}；如确认覆盖，请追加 --force`);
    }
    throw error;
  }
}

async function pull(settings: SyncConfig, force: boolean): Promise<void> {
  const { body } = await requestJson(settings);
  const remote = asRecord(body);
  const revision = Number(remote.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new SyncError("远端版本号无效");
  const state = readState(settings);
  const local = readAuthPayloadIfPresent(settings.authCacheDir);
  if (!force && local && (!state || state.revision !== revision)) {
    throw new SyncError("本机已有未确认的认证缓存；如确认用远端覆盖，请追加 --force");
  }
  const passphrase = await readSecret("同步解密密码");
  const payload = decryptPayload(remote.envelope, passphrase);
  const providers = writeAuthPayload(settings.authCacheDir, payload);
  const updatedAt = Number(remote.updatedAt);
  saveState(settings, { revision, updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0 });
  console.log(`已下载 ${providers.join(", ")}，远端版本 ${revision}`);
}

function readAuthPayloadIfPresent(cacheDir: string): VaultPayload | null {
  try {
    return readAuthPayload(cacheDir);
  } catch {
    return null;
  }
}

async function status(settings: SyncConfig): Promise<void> {
  try {
    const { body } = await requestJson(settings);
    const remote = asRecord(body);
    console.log(JSON.stringify({
      vault: settings.vaultId,
      revision: remote.revision,
      updatedAt: remote.updatedAt,
      localRevision: readState(settings)?.revision ?? null,
    }, null, 2));
  } catch (error) {
    if (error instanceof SyncError && error.status === 404) {
      console.log(`远端保险库 ${settings.vaultId} 尚不存在`);
      return;
    }
    throw error;
  }
}

function printHelp(): void {
  console.log(`认证同步工具

用法:
  npm run sync -- push [--force]
  npm run sync -- pull [--force]
  npm run sync -- status

环境变量:
  SYNC_URL          Worker 地址，例如 https://sync.example.com
  SYNC_TOKEN        Worker 的同步 Token
  SYNC_VAULT_ID     保险库 ID，默认 default
  SYNC_PASSPHRASE   可选；不设置时安全提示输入
`);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "--help" || command === "-h") {
    printHelp();
    return;
  }
  const settings = config();
  const force = args.includes("--force");
  if (command === "push") return push(settings, force);
  if (command === "pull") return pull(settings, force);
  if (command === "status") return status(settings);
  throw new SyncError(`未知命令 ${command}，可用命令：push、pull、status`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
