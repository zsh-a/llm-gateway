import { DurableObject } from "cloudflare:workers";

const VAULT_KEY = "vault";
const MAX_ENVELOPE_BYTES = 512 * 1024;

export interface Env {
  VAULT: DurableObjectNamespace;
  SYNC_TOKEN?: string;
}

interface SyncEnvelope {
  format: 1;
  algorithm: "scrypt-aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
}

interface VaultRecord {
  revision: number;
  updatedAt: number;
  envelope: SyncEnvelope;
}

const JSON_HEADERS = {
  "cache-control": "no-store",
  "content-type": "application/json; charset=utf-8",
};

function json(body: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers(JSON_HEADERS);
  for (const [key, value] of Object.entries(extraHeaders)) headers.set(key, value);
  return new Response(JSON.stringify(body), { status, headers });
}

function errorResponse(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
  return json({ error: { code, message, ...extra } }, status);
}

function bearerToken(request: Request): string {
  const value = request.headers.get("authorization") ?? "";
  return value.replace(/^Bearer\s+/i, "").trim();
}

function authorize(request: Request, env: Env): Response | null {
  const expected = env.SYNC_TOKEN?.trim();
  if (!expected) return errorResponse(500, "configuration_error", "SYNC_TOKEN 未配置");
  if (!bearerToken(request) || bearerToken(request) !== expected) {
    return errorResponse(401, "authentication_error", "缺少或无效的同步 Token");
  }
  return null;
}

function vaultId(request: Request): string | null {
  const match = new URL(request.url).pathname.match(/^\/v1\/vault\/([A-Za-z0-9_-]{1,64})$/);
  return match?.[1] ?? null;
}

function isBase64(value: unknown, maximumBytes: number): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  if (value.length > Math.ceil(maximumBytes * 4 / 3) + 4) return false;
  return /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isEnvelope(value: unknown): value is SyncEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const envelope = value as Record<string, unknown>;
  return envelope.format === 1
    && envelope.algorithm === "scrypt-aes-256-gcm"
    && isBase64(envelope.salt, 64)
    && isBase64(envelope.iv, 32)
    && isBase64(envelope.tag, 32)
    && isBase64(envelope.ciphertext, MAX_ENVELOPE_BYTES)
    && typeof envelope.createdAt === "number"
    && Number.isFinite(envelope.createdAt);
}

function parseRevision(value: string | null): number | null {
  if (!value) return null;
  const normalized = value.trim().replace(/^W\//, "").replace(/^"|"$/g, "");
  const revision = Number(normalized);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : null;
}

export class VaultObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const current = await this.ctx.storage.get<VaultRecord>(VAULT_KEY);

    if (request.method === "GET") {
      if (!current) return errorResponse(404, "not_found", "同步保险库不存在");
      return json(
        { revision: current.revision, updatedAt: current.updatedAt, envelope: current.envelope },
        200,
        { etag: `"${current.revision}"` },
      );
    }

    if (request.method === "DELETE") {
      if (!current) return new Response(null, { status: 204 });
      const force = request.headers.get("x-sync-force") === "1";
      const expected = parseRevision(request.headers.get("if-match"));
      if (!force && expected !== current.revision) {
        return errorResponse(409, "conflict", "远端保险库已更新", { revision: current.revision });
      }
      await this.ctx.storage.delete(VAULT_KEY);
      return new Response(null, { status: 204 });
    }

    if (request.method !== "PUT") {
      return errorResponse(405, "method_not_allowed", "只支持 GET、PUT 和 DELETE");
    }

    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > MAX_ENVELOPE_BYTES) {
      return errorResponse(413, "payload_too_large", "加密保险库超过大小限制");
    }
    let input: unknown;
    try {
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > MAX_ENVELOPE_BYTES) {
        return errorResponse(413, "payload_too_large", "加密保险库超过大小限制");
      }
      input = JSON.parse(raw);
    } catch {
      return errorResponse(400, "invalid_json", "请求体不是有效 JSON");
    }

    const envelope = input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>).envelope
      : undefined;
    if (!isEnvelope(envelope)) {
      return errorResponse(400, "invalid_envelope", "加密保险库格式无效");
    }

    const force = request.headers.get("x-sync-force") === "1";
    const expected = parseRevision(request.headers.get("if-match"));
    if (current && !force) {
      if (expected === null) {
        return errorResponse(428, "precondition_required", "首次覆盖远端保险库需要 If-Match 或强制模式", {
          revision: current.revision,
        });
      }
      if (expected !== current.revision) {
        return errorResponse(409, "conflict", "远端保险库已更新", { revision: current.revision });
      }
    }

    const record: VaultRecord = {
      revision: (current?.revision ?? 0) + 1,
      updatedAt: Date.now(),
      envelope,
    };
    await this.ctx.storage.put(VAULT_KEY, record);
    return json(
      { revision: record.revision, updatedAt: record.updatedAt },
      200,
      { etag: `"${record.revision}"` },
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ service: "llm-gateway-sync", status: "ok" });
    }

    const id = vaultId(request);
    if (!id) return errorResponse(404, "not_found", "同步接口不存在");
    const unauthorized = authorize(request, env);
    if (unauthorized) return unauthorized;

    const objectId = env.VAULT.idFromName(id);
    return env.VAULT.get(objectId).fetch(request);
  },
};
