import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import type { ContentfulStatusCode } from "hono/utils/http-status";

import { getAuthStore } from "./auth-store.js";
import { getChannelStore, type ChannelConfig } from "./channels.js";
import { loadConfig } from "./config.js";
import { clearModelCache, getModels, resolveModel, type ModelRoute } from "./models.js";
import { ApiKeyStore, type ApiKeyIdentity } from "./key-store.js";
import {
  MetricsStore,
  parseDuration,
  type MetricHandle,
  type MetricAdmission,
  type MetricOutcome
} from "./metrics.js";
import {
  ChatAccumulator,
  createStreamContext,
  errorResponse,
  finalOpenAIChunk,
  includesUsage,
  modelsResponse,
  normalizeChatRequest,
  toOpenAIChunks,
  validateChatRequest,
  validateModelRequest,
  usageOpenAIChunk
} from "./openai.js";
import {
  createResponseContext,
  normalizeResponseRequest,
  responseChunkEvents,
  responseCreated,
  responseFailed,
  responseFinishEvents,
  responseInProgress,
  rememberResponse,
  ResponseAccumulator,
  validateResponseRequest
} from "./responses.js";
import {
  getProviders,
  UpstreamError,
  type UpstreamChunk
} from "./provider.js";
import type { JsonRecord, NormalizedChatRequest } from "./types.js";
import { WEB_UI_HTML } from "./web-ui.js";

const config = loadConfig();
const authStore = getAuthStore(config);
const apiKeys = new ApiKeyStore(config.apiKeysFile, config.apiKey);
const metrics = new MetricsStore(config.metricsMaxRecords, config.metricsFile);

interface GatewayVariables {
  identity: ApiKeyIdentity;
  admission: MetricAdmission | undefined;
}

type GatewayEnv = { Variables: GatewayVariables };
type GatewayContext = Context<GatewayEnv>;

class GatewayError extends Error {
  constructor(
    public readonly status: number,
    public readonly type: string,
    message: string
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

function statusCode(status: number): ContentfulStatusCode {
  return status as ContentfulStatusCode;
}

function sendJson(c: Context, status: number, body: unknown): Response {
  return c.body(
    JSON.stringify(body),
    statusCode(status),
    { "Content-Type": "application/json; charset=utf-8" }
  );
}

function sendError(
  c: Context,
  status: number,
  message: string,
  type: string
): Response {
  return sendJson(c, status, errorResponse(message, type));
}

function sendWebUi(c: Context): Response {
  return c.body(WEB_UI_HTML, 200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
}

function requestCredential(c: Context): string {
  const authorization = c.req.header("authorization") ?? "";
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return (c.req.header("x-api-key") ?? "").trim();
}

function authenticateRequest(c: Context): ApiKeyIdentity | null {
  const credential = requestCredential(c);
  if (!apiKeys.requiresAuthentication()) return apiKeys.anonymous();
  return apiKeys.authenticate(credential);
}

function adminAuthorized(c: Context): boolean {
  const adminKey = config.adminKey || config.apiKey;
  return !adminKey || requestCredential(c) === adminKey;
}

function metricScope(identity: ApiKeyIdentity): string | undefined {
  return identity.source === "managed" ? identity.keyId : undefined;
}

function beginMetric(
  c: GatewayContext,
  protocol: "chat" | "responses",
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): MetricHandle {
  const handle = metrics.begin(
    protocol,
    route.provider.id,
    route.publicModel,
    request,
    {
      channelId: route.channel.id,
      apiKeyId: identity.keyId
    }
  );
  c.header("X-Request-ID", handle.id);
  return handle;
}

function finishMetric(
  handle: MetricHandle,
  identity: ApiKeyIdentity,
  outcome: MetricOutcome
): void {
  metrics.finish(handle, outcome);
  apiKeys.recordUsage(identity, outcome.usage);
}

interface MetricAccumulator {
  usage: unknown;
  finishReason: string;
  toolCalls: unknown[];
}

function outcomeFor(
  accumulator: MetricAccumulator,
  status: MetricOutcome["status"],
  errorType?: string
): MetricOutcome {
  return {
    status,
    errorType,
    usage: accumulator.usage,
    finishReason: accumulator.finishReason,
    toolCalls: accumulator.toolCalls.filter(Boolean).length
  };
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

async function readJsonRecord(c: Context): Promise<JsonRecord> {
  const raw = await readBody(c, config.maxBodyBytes);
  let value: unknown;
  try {
    value = JSON.parse(raw || "{}");
  } catch {
    throw new GatewayError(400, "invalid_request_error", "请求体不是合法 JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new GatewayError(400, "invalid_request_error", "请求体必须是 JSON 对象");
  }
  return value as JsonRecord;
}

function asGatewayError(
  error: unknown,
  fallbackStatus: number,
  fallbackType: string
): GatewayError {
  if (error instanceof GatewayError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new GatewayError(fallbackStatus, fallbackType, message);
}

function upstreamError(error: unknown): {
  status: number;
  message: string;
  type: string;
} {
  if (error instanceof UpstreamError) {
    return {
      status: error.status,
      message: error.message,
      type: "upstream_error"
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  if (message.toLowerCase().includes("abort")) {
    return { status: 504, message: "上游请求超时或已取消", type: "timeout_error" };
  }
  return { status: 502, message, type: "upstream_error" };
}

function retryableUpstreamFailure(error: unknown): boolean {
  if (!(error instanceof UpstreamError)) return true;
  return error.status === 401 || error.status === 403 ||
    error.status === 408 || error.status === 409 || error.status === 429 ||
    error.status >= 500;
}

async function streamUpstream(
  route: ModelRoute,
  request: NormalizedChatRequest,
  onChunk: (chunk: UpstreamChunk) => void,
  externalSignal: AbortSignal | undefined,
  onChannel: (channel: ChannelConfig) => void
): Promise<ChannelConfig> {
  let lastError: unknown = null;
  for (let index = 0; index < route.candidates.length; index += 1) {
    const candidate = route.candidates[index];
    if (externalSignal?.aborted) throw new Error("请求已取消");

    const snapshot = authStore.get(candidate.channel.authRef);
    if (!snapshot) {
      lastError = new UpstreamError(
        503,
        "未找到渠道 " + candidate.channel.id + " 的认证缓存"
      );
      continue;
    }

    let emitted = false;
    onChannel(candidate.channel);
    try {
      await route.provider.streamChat(
        snapshot.headers,
        { ...request, model: candidate.upstreamModel },
        config,
        (chunk) => {
          if (chunk.choices && chunk.choices.length > 0) emitted = true;
          onChunk(chunk);
        },
        externalSignal,
        candidate.channel
      );
      return candidate.channel;
    } catch (error) {
      lastError = error;
      if (
        error instanceof UpstreamError &&
        (error.status === 401 || error.status === 403)
      ) {
        authStore.invalidate(candidate.channel.authRef);
      }
      if (
        externalSignal?.aborted ||
        emitted ||
        index === route.candidates.length - 1 ||
        !retryableUpstreamFailure(error)
      ) {
        throw error;
      }
    }
  }
  throw lastError ?? new Error("没有可用的上游渠道");
}

class SseWriter {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly stream: SSEStreamingApi) {}

  writeData(data: string, event?: string): void {
    this.pending = this.pending
      .then(() => this.stream.writeSSE(event ? { data, event } : { data }))
      .catch(() => undefined);
  }

  writeJson(value: Record<string, unknown>, event?: string): void {
    this.writeData(JSON.stringify(value), event);
  }

  flush(): Promise<void> {
    return this.pending;
  }
}

interface AbortLink {
  signal: AbortSignal;
  dispose: () => void;
}

function linkClientAbort(c: Context, stream: SSEStreamingApi): AbortLink {
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

function responseEventName(value: Record<string, unknown>): string {
  return typeof value.type === "string" ? value.type : "message";
}

function handleChatStreaming(
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Response {
  const context = createStreamContext(route.publicModel);
  const accumulator = new ChatAccumulator();
  const metric = beginMetric(c, "chat", route, request, identity);
  const includeUsage = includesUsage(request);
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    const writer = new SseWriter(stream);
    const clientAbort = linkClientAbort(c, stream);
    let finishSeen = false;
    let outcome: MetricOutcome = {
      status: "error",
      errorType: "internal_error"
    };
    const aborted = (): boolean => stream.aborted || clientAbort.signal.aborted;

    try {
      await streamUpstream(
        route,
        request,
        (chunk) => {
          if (aborted()) return;
          const events = accumulator.add(chunk);
          if (events.some((event) => event.type === "finish")) finishSeen = true;
          const visibleEvents = includeUsage
            ? events.filter((event) => event.type !== "usage")
            : events;
          for (const value of toOpenAIChunks(visibleEvents, context)) {
            writer.writeJson(value);
          }
        },
        clientAbort.signal,
        (channel) => { metric.channelId = channel.id; }
      );

      if (aborted()) {
        outcome = outcomeFor(accumulator, "canceled", "client_disconnect");
        return;
      }
      await writer.flush();
      if (aborted()) {
        outcome = outcomeFor(accumulator, "canceled", "client_disconnect");
        return;
      }
      if (!finishSeen) writer.writeJson(finalOpenAIChunk(context, accumulator.finishReason));
      if (includeUsage) writer.writeJson(usageOpenAIChunk(context, accumulator.usage));
      writer.writeData("[DONE]");
      await writer.flush();
      outcome = outcomeFor(accumulator, "success");
    } catch (error) {
      if (aborted()) {
        outcome = outcomeFor(accumulator, "canceled", "client_disconnect");
        return;
      }
      const failure = upstreamError(error);
      outcome = outcomeFor(accumulator, "error", failure.type);
      if (failure.status === 401 || failure.status === 403) {
        authStore.invalidate(route.channel.authRef);
      }
      writer.writeJson(errorResponse(failure.message, failure.type));
      writer.writeData("[DONE]");
      await writer.flush();
    } finally {
      clientAbort.dispose();
      finishMetric(metric, identity, outcome);
    }
  });
}

async function handleChatNonStreaming(
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<Response> {
  const accumulator = new ChatAccumulator();
  const metric = beginMetric(c, "chat", route, request, identity);
  let outcome: MetricOutcome = {
    status: "error",
    errorType: "internal_error"
  };
  try {
    await streamUpstream(
      route,
      request,
      (chunk) => { accumulator.add(chunk); },
      undefined,
      (channel) => { metric.channelId = channel.id; }
    );
    outcome = outcomeFor(accumulator, "success");
    return sendJson(c, 200, accumulator.response(route.publicModel));
  } catch (error) {
    const failure = upstreamError(error);
    outcome = outcomeFor(accumulator, "error", failure.type);
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.channel.authRef);
    }
    return sendError(c, failure.status, failure.message, failure.type);
  } finally {
    finishMetric(metric, identity, outcome);
  }
}

function handleResponseStreaming(
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Response {
  const context = createResponseContext(route.publicModel, request.response);
  const accumulator = new ResponseAccumulator();
  const metric = beginMetric(c, "responses", route, request, identity);
  c.header("X-Accel-Buffering", "no");

  return streamSSE(c, async (stream) => {
    const writer = new SseWriter(stream);
    const clientAbort = linkClientAbort(c, stream);
    let outcome: MetricOutcome = {
      status: "error",
      errorType: "internal_error"
    };
    const aborted = (): boolean => stream.aborted || clientAbort.signal.aborted;
    const writeEvent = (value: Record<string, unknown>): void => {
      writer.writeJson(value, responseEventName(value));
    };

    try {
      writeEvent(responseCreated(context));
      writeEvent(responseInProgress(context));
      await writer.flush();

      await streamUpstream(
        route,
        request,
        (chunk) => {
          if (aborted()) return;
          for (const value of responseChunkEvents(chunk, context, accumulator)) {
            writeEvent(value);
          }
        },
        clientAbort.signal,
        (channel) => { metric.channelId = channel.id; }
      );

      if (aborted()) {
        outcome = outcomeFor(accumulator, "canceled", "client_disconnect");
        return;
      }
      for (const value of responseFinishEvents(context, accumulator)) {
        writeEvent(value);
      }
      rememberResponse(context, accumulator);
      await writer.flush();
      outcome = outcomeFor(accumulator, "success");
    } catch (error) {
      if (aborted()) {
        outcome = outcomeFor(accumulator, "canceled", "client_disconnect");
        return;
      }
      const failure = upstreamError(error);
      outcome = outcomeFor(accumulator, "error", failure.type);
      if (failure.status === 401 || failure.status === 403) {
        authStore.invalidate(route.channel.authRef);
      }
      writeEvent(responseFailed(context, failure.message));
      await writer.flush();
    } finally {
      clientAbort.dispose();
      finishMetric(metric, identity, outcome);
    }
  });
}

async function handleResponseNonStreaming(
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<Response> {
  const context = createResponseContext(route.publicModel, request.response);
  const accumulator = new ResponseAccumulator();
  const metric = beginMetric(c, "responses", route, request, identity);
  let outcome: MetricOutcome = {
    status: "error",
    errorType: "internal_error"
  };
  try {
    await streamUpstream(
      route,
      request,
      (chunk) => { accumulator.add(chunk); },
      undefined,
      (channel) => { metric.channelId = channel.id; }
    );
    const response = sendJson(c, 200, accumulator.response(context));
    rememberResponse(context, accumulator);
    outcome = outcomeFor(accumulator, "success");
    return response;
  } catch (error) {
    const failure = upstreamError(error);
    outcome = outcomeFor(accumulator, "error", failure.type);
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.channel.authRef);
    }
    return sendError(c, failure.status, failure.message, failure.type);
  } finally {
    finishMetric(metric, identity, outcome);
  }
}

interface PreparedRequest {
  route: ModelRoute;
  request: NormalizedChatRequest;
  identity: ApiKeyIdentity;
}

type RequestNormalizer = (
  value: unknown,
  defaultModel?: string
) => NormalizedChatRequest;

type RequestValidator = (request: NormalizedChatRequest) => string | null;

async function prepareRequest(
  c: GatewayContext,
  normalize: RequestNormalizer,
  validate: RequestValidator,
  identity: ApiKeyIdentity,
  admission: MetricAdmission | undefined
): Promise<PreparedRequest | Response> {
  const reject = (
    status: number,
    message: string,
    type: string,
    model = "unknown"
  ): Response => {
    metrics.finishAdmission(admission, model, {
      status: "error",
      errorType: type
    });
    if (admission) c.header("X-Request-ID", admission.id);
    return sendError(c, status, message, type);
  };

  let parsed: JsonRecord;
  try {
    parsed = await readJsonRecord(c);
  } catch (error) {
    const failure = asGatewayError(error, 400, "invalid_request_error");
    return reject(failure.status, failure.message, failure.type);
  }

  let request: NormalizedChatRequest;
  try {
    request = normalize(parsed, config.defaultModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return reject(400, message, "invalid_request_error");
  }

  const validationError = validate(request);
  if (validationError) {
    return reject(400, validationError, "invalid_request_error", request.model);
  }

  const route = await resolveModel(config, request.model);
  if (!route) {
    return reject(
      400,
      request.model
        ? "未找到模型 " + request.model + "，请先请求 /v1/models"
        : "请求必须包含 model",
      "invalid_request_error",
      request.model
    );
  }

  const modelValidationError = validateModelRequest(request, route.model);
  if (modelValidationError) {
    return reject(400, modelValidationError, "invalid_request_error", route.publicModel);
  }

  const modelAccessError = apiKeys.authorizeModel(
    identity,
    request.model || route.publicModel
  );
  if (modelAccessError) {
    return reject(403, modelAccessError, "permission_error", route.publicModel);
  }

  const hasAuth = route.candidates.some((candidate) => (
    authStore.get(candidate.channel.authRef) !== null
  ));
  if (!hasAuth) {
    return reject(
      503,
      "未找到 " + route.provider.name + " 渠道 " + route.channel.id +
        " 认证，请先执行 npm run auth -- --provider " + route.provider.id,
      "auth_error",
      route.publicModel
    );
  }

  const reservationError = apiKeys.reserve(identity);
  if (reservationError) {
    return reject(429, reservationError, "rate_limit_error", route.publicModel);
  }

  metrics.acceptAdmission(admission);
  return {
    route,
    identity,
    request: {
      ...request,
      model: route.upstreamModel,
      modelDescriptor: route.model
    }
  };
}

async function handleChat(
  c: GatewayContext,
  identity: ApiKeyIdentity,
  admission: MetricAdmission | undefined
): Promise<Response> {
  const prepared = await prepareRequest(
    c,
    normalizeChatRequest,
    validateChatRequest,
    identity,
    admission
  );
  if (prepared instanceof Response) return prepared;
  return prepared.request.stream
    ? handleChatStreaming(c, prepared.route, prepared.request, prepared.identity)
    : handleChatNonStreaming(c, prepared.route, prepared.request, prepared.identity);
}

async function handleResponses(
  c: GatewayContext,
  identity: ApiKeyIdentity,
  admission: MetricAdmission | undefined
): Promise<Response> {
  const prepared = await prepareRequest(
    c,
    normalizeResponseRequest,
    validateResponseRequest,
    identity,
    admission
  );
  if (prepared instanceof Response) return prepared;
  return prepared.request.stream
    ? handleResponseStreaming(c, prepared.route, prepared.request, prepared.identity)
    : handleResponseNonStreaming(c, prepared.route, prepared.request, prepared.identity);
}

function admissionProtocol(
  method: string,
  path: string
): "chat" | "responses" | null {
  if (method !== "POST") return null;
  if (path === "/v1/responses" || path === "/responses") return "responses";
  if (path === "/v1/chat/completions" || path === "/chat/completions") {
    return "chat";
  }
  return null;
}

function requiresGatewayAuth(path: string): boolean {
  return path.startsWith("/v1/") ||
    path.startsWith("/chat/") ||
    path.startsWith("/metrics/") ||
    path === "/responses";
}

const authenticate: MiddlewareHandler<GatewayEnv> = async (c, next) => {
  if (!requiresGatewayAuth(c.req.path)) {
    await next();
    return;
  }

  const protocol = admissionProtocol(c.req.method, c.req.path);
  const admission = protocol ? metrics.beginAdmission(protocol) : undefined;
  c.set("admission", admission);
  const identity = authenticateRequest(c);
  if (!identity) {
    metrics.finishAdmission(admission, "unknown", {
      status: "error",
      errorType: "authentication_error"
    });
    if (admission) c.header("X-Request-ID", admission.id);
    return sendError(c, 401, "缺少或无效的代理 API Key", "authentication_error");
  }

  c.set("identity", identity);
  if (admission) admission.apiKeyId = identity.keyId;
  await next();
};

const authorizeAdmin: MiddlewareHandler<GatewayEnv> = async (c, next) => {
  if (c.req.path !== "/admin" && !c.req.path.startsWith("/admin/")) {
    await next();
    return;
  }
  if (!adminAuthorized(c)) {
    return sendError(c, 401, "缺少或无效的管理员 API Key", "authentication_error");
  }
  await next();
};

function identityOf(c: GatewayContext): ApiKeyIdentity {
  return c.get("identity");
}

function admissionOf(c: GatewayContext): MetricAdmission | undefined {
  return c.get("admission");
}

function registerAdminRoutes(app: Hono<GatewayEnv>): void {
  app.get("/admin/metrics/summary", (c) => sendJson(c, 200, metrics.summary(
    parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000)
  )));

  app.get("/admin/metrics/timeseries", (c) => {
    const windowMs = parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000);
    const bucket = c.req.query("bucket");
    return sendJson(c, 200, metrics.timeseries(
      windowMs,
      bucket ? parseDuration(bucket, 0) : undefined
    ));
  });

  app.get("/admin/metrics/requests", (c) => {
    const statusValue = c.req.query("status");
    const status = statusValue === "success" ||
      statusValue === "error" ||
      statusValue === "canceled"
      ? statusValue
      : undefined;
    return sendJson(c, 200, metrics.recent({
      windowMs: parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000),
      limit: Number(c.req.query("limit")) || 50,
      provider: c.req.query("provider") || undefined,
      model: c.req.query("model") || undefined,
      status
    }));
  });

  app.get("/admin/metrics/models", (c) => sendJson(c, 200, metrics.models(
    parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000)
  )));

  const channels = getChannelStore(config);
  app.get("/admin/channels", (c) => sendJson(c, 200, {
    object: "llm-gateway.channels",
    data: channels.list()
  }));

  app.post("/admin/channels", async (c) => {
    const body = await readJsonRecord(c);
    try {
      const channel = channels.upsert(body);
      clearModelCache(config);
      return sendJson(c, 200, { object: "llm-gateway.channel", data: channel });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendError(c, 400, message, "invalid_request_error");
    }
  });

  app.delete("/admin/channels/:id", (c) => {
    const id = c.req.param("id");
    const removed = channels.remove(id);
    if (!removed) return sendError(c, 404, "渠道不存在", "invalid_request_error");
    clearModelCache(config);
    return sendJson(c, 200, { object: "llm-gateway.channel.deleted", id });
  });

  app.get("/admin/keys", (c) => sendJson(c, 200, {
    object: "llm-gateway.api_keys",
    data: apiKeys.list()
  }));

  app.post("/admin/keys", async (c) => {
    const body = await readJsonRecord(c);
    try {
      const created = apiKeys.create(body);
      return sendJson(c, 201, {
        object: "llm-gateway.api_key",
        data: created.record,
        secret: created.secret,
        warning: "secret 只在本次响应中返回，请立即保存"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendError(c, 400, message, "invalid_request_error");
    }
  });

  app.patch("/admin/keys/:id", async (c) => {
    const body = await readJsonRecord(c);
    const id = c.req.param("id");
    const updated = apiKeys.update(id, body);
    if (!updated) return sendError(c, 404, "API Key 不存在", "invalid_request_error");
    return sendJson(c, 200, { object: "llm-gateway.api_key", data: updated });
  });

  app.delete("/admin/keys/:id", (c) => {
    const id = c.req.param("id");
    const revoked = apiKeys.revoke(id);
    if (!revoked) return sendError(c, 404, "API Key 不存在", "invalid_request_error");
    return sendJson(c, 200, { object: "llm-gateway.api_key.revoked", id });
  });

  app.all("/admin/*", (c) => sendError(c, 404, "管理接口不存在", "invalid_request_error"));
}

function registerPublicRoutes(app: Hono<GatewayEnv>): void {
  const live = (c: Context): Response => sendJson(c, 200, {
    status: "ok",
    service: "llm-gateway",
    mode: "live",
    providers: getProviders().map((provider) => provider.id)
  });
  for (const path of ["/", "/health", "/health/live"]) app.get(path, live);
  for (const path of ["/ui", "/ui/", "/ui/index.html"]) {
    app.get(path, (c) => sendWebUi(c));
  }

  app.get("/health/ready", async (c) => {
    const auth = authStore.status(getProviders().map((provider) => provider.id));
    const models = await getModels(config);
    const ready = auth.ready && models.length > 0;
    return sendJson(c, ready ? 200 : 503, {
      status: ready ? "ok" : "not_ready",
      service: "llm-gateway",
      mode: "ready",
      authenticated: auth.ready,
      models: models.length,
      providers: auth.providers
    });
  });

  app.get("/health/auth", (c) => sendJson(
    c,
    200,
    authStore.status(getProviders().map((provider) => provider.id))
  ));

  app.get("/.well-known/llm-gateway/capabilities", async (c) => {
    const auth = authStore.status(getProviders().map((provider) => provider.id));
    const models = modelsResponse(await getModels(config));
    return sendJson(c, 200, {
      object: "llm-gateway.capabilities",
      version: 1,
      service: "llm-gateway",
      authRequired: apiKeys.requiresAuthentication(),
      protocols: {
        chatCompletions: {
          path: "/v1/chat/completions",
          stream: true,
          tools: true,
          reasoningContent: true,
          usageChunk: true,
          developerRole: false
        },
        responses: {
          path: "/v1/responses",
          stream: true,
          reasoningText: true,
          functionCalls: true,
          structuredOutputs: true,
          previousResponseId: "process"
        }
      },
      providers: getProviders().map((provider) => ({
        id: provider.id,
        name: provider.name,
        authenticated: auth.providers[provider.id]?.ready === true
      })),
      models: models.data
    });
  });

  app.get("/metrics/summary", (c) => {
    const windowMs = parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000);
    const scope = metricScope(identityOf(c));
    return sendJson(c, 200, scope ? metrics.summary(windowMs, scope) : metrics.summary(windowMs));
  });

  app.get("/metrics/timeseries", (c) => {
    const windowMs = parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000);
    const bucketValue = c.req.query("bucket");
    const bucketMs = bucketValue ? parseDuration(bucketValue, 0) : undefined;
    const scope = metricScope(identityOf(c));
    const value = scope
      ? metrics.timeseries(windowMs, bucketMs, scope)
      : bucketMs === undefined
        ? metrics.timeseries(windowMs)
        : metrics.timeseries(windowMs, bucketMs);
    return sendJson(c, 200, value);
  });

  app.get("/metrics/requests", (c) => {
    const statusValue = c.req.query("status");
    const status = statusValue === "success" ||
      statusValue === "error" ||
      statusValue === "canceled"
      ? statusValue
      : undefined;
    return sendJson(c, 200, metrics.recent({
      windowMs: parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000),
      limit: Number(c.req.query("limit")) || 50,
      provider: c.req.query("provider") || undefined,
      model: c.req.query("model") || undefined,
      status,
      apiKeyId: metricScope(identityOf(c))
    }));
  });

  app.get("/metrics/models", (c) => {
    const windowMs = parseDuration(c.req.query("window"), 24 * 60 * 60 * 1000);
    const scope = metricScope(identityOf(c));
    return sendJson(c, 200, scope ? metrics.models(windowMs, scope) : metrics.models(windowMs));
  });

  app.get("/v1/models", async (c) => sendJson(
    c,
    200,
    modelsResponse(await getModels(config))
  ));

  for (const path of ["/v1/responses", "/responses"]) {
    app.post(path, (c) => handleResponses(c, identityOf(c), admissionOf(c)));
  }
  for (const path of ["/v1/chat/completions", "/chat/completions"]) {
    app.post(path, (c) => handleChat(c, identityOf(c), admissionOf(c)));
  }
}

export function createGatewayApp(): Hono<GatewayEnv> {
  const app = new Hono<GatewayEnv>();
  app.use("*", cors({
    origin: config.corsOrigin,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "X-API-Key"],
    exposeHeaders: ["X-Request-ID"]
  }));
  app.options("*", (c) => c.body(null, 204));
  app.use("*", authenticate);
  app.use("*", authorizeAdmin);

  registerAdminRoutes(app);
  registerPublicRoutes(app);

  app.onError((error, c) => {
    const failure = asGatewayError(error, 500, "internal_error");
    return sendError(c, failure.status, failure.message, failure.type);
  });
  app.notFound((c) => sendError(c, 404, "Not found", "invalid_request_error"));
  return app;
}

let gatewayServer: ServerType | null = null;

export function startGateway(): ServerType {
  if (gatewayServer) return gatewayServer;

  const app = createGatewayApp();
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.bindHost,
      port: config.port
    },
    () => {
      console.log(
        `LLM Gateway 已启动: http://${config.bindHost}:${config.port}`
      );
      console.log(
        `- 兼容接口: http://${config.bindHost}:${config.port}/v1/chat/completions`
      );
      console.log(
        `- Responses 接口: http://${config.bindHost}:${config.port}/v1/responses`
      );
      console.log(`- 模型列表: http://${config.bindHost}:${config.port}/v1/models`);
      console.log(`- Web 控制台: http://${config.bindHost}:${config.port}/ui`);
    }
  );

  server.on("error", (error) => {
    console.error("LLM Gateway 服务错误:", error.message);
  });
  gatewayServer = server;
  return server;
}
