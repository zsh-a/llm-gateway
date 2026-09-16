import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { asGatewayError, GatewayError } from "./errors.js";
import { errorResponse } from "./openai.js";
import {
  UpstreamError,
  UpstreamNetworkError,
  UpstreamStreamError
} from "./provider.js";
import { secretsEqual } from "./security.js";
import {
  UpstreamCanceledError,
  UpstreamTimeoutError
} from "./upstream.js";
import { WEB_UI_HTML } from "./web-ui.js";

function statusCode(status: number): ContentfulStatusCode {
  return status as ContentfulStatusCode;
}

export function sendJson(c: Context, status: number, body: unknown): Response {
  return c.body(
    JSON.stringify(body),
    statusCode(status),
    { "Content-Type": "application/json; charset=utf-8" }
  );
}

export function sendError(
  c: Context,
  status: number,
  message: string,
  type: string
): Response {
  return sendJson(c, status, errorResponse(message, type));
}

export function sendWebUi(c: Context): Response {
  return c.body(WEB_UI_HTML, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
}

export function requestCredential(c: Context): string {
  const authorization = c.req.header("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return (c.req.header("x-api-key") ?? "").trim();
}

export function adminAuthorized(c: Context, adminKey: string): boolean {
  return !adminKey || secretsEqual(requestCredential(c), adminKey);
}

async function readBody(c: Context, maxBytes: number): Promise<string> {
  const contentLength = Number(c.req.header("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new GatewayError(413, "invalid_request_error", "请求体超过大小限制");
  }

  try {
    const raw = await c.req.text();
    const size = new TextEncoder().encode(raw).byteLength;
    if (size > maxBytes) {
      throw new GatewayError(413, "invalid_request_error", "请求体超过大小限制");
    }
    return raw;
  } catch (error) {
    if (error instanceof GatewayError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayError(400, "invalid_request_error", message);
  }
}

export async function readJsonRecord(
  c: Context,
  maxBodyBytes: number
): Promise<{ [key: string]: unknown }> {
  const raw = await readBody(c, maxBodyBytes);
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    throw new GatewayError(400, "invalid_request_error", "请求体不是合法 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request_error", "请求体必须是 JSON 对象");
  }
  return value as { [key: string]: unknown };
}

export function upstreamError(error: unknown): {
  status: number;
  message: string;
  type: string;
} {
  if (error instanceof UpstreamCanceledError) {
    return { status: 499, message: error.message, type: "canceled_error" };
  }
  if (error instanceof UpstreamTimeoutError) {
    return { status: error.status, message: error.message, type: "timeout_error" };
  }
  if (error instanceof UpstreamStreamError) {
    return {
      status: error.status,
      message: error.message,
      type: "upstream_stream_incomplete"
    };
  }
  if (error instanceof UpstreamError) {
    return {
      status: error.status,
      // Keep upstream response bodies server-side; provider diagnostics and
      // cookies must not be reflected to clients.
      message: `上游接口返回 HTTP ${error.status}`,
      type: "upstream_error"
    };
  }
  if (error instanceof UpstreamNetworkError) {
    return { status: error.status, message: "无法连接上游服务", type: "upstream_error" };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("abort")) {
    return { status: 504, message: "上游请求超时或已取消", type: "timeout_error" };
  }
  return { status: 502, message: "上游请求失败", type: "upstream_error" };
}

export class SseWriter {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly stream: SSEStreamingApi) {}

  writeData(data: string, event?: string): void {
    this.pending = this.pending
      .then(() => this.stream.writeSSE(event ? { data, event } : { data }));
  }

  writeJson(value: Record<string, unknown>, event?: string): void {
    this.writeData(JSON.stringify(value), event);
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

export interface AbortLink {
  signal: AbortSignal;
  dispose: () => void;
}

export function linkClientAbort(c: Context, stream: SSEStreamingApi): AbortLink {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  c.req.raw.signal.addEventListener("abort", abort);
  stream.onAbort(abort);
  if (c.req.raw.signal.aborted) abort();
  return {
    signal: controller.signal,
    dispose: () => c.req.raw.signal.removeEventListener("abort", abort)
  };
}

export function appError(error: unknown): GatewayError {
  return asGatewayError(error, 500, "internal_error", "内部服务器错误");
}
