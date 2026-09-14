import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

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

function beginMetric(
  res: ServerResponse,
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
  res.setHeader("X-Request-ID", handle.id);
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

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const requestOrigin = req.headers.origin;
  if (config.corsOrigin === "*") {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (requestOrigin === config.corsOrigin) {
    res.setHeader("Access-Control-Allow-Origin", config.corsOrigin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-API-Key"
  );
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown
): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendWebUi(res: ServerResponse): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin"
  });
  res.end(WEB_UI_HTML);
}

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string
): void {
  sendJson(res, status, errorResponse(message, type));
}

function requestCredential(req: IncomingMessage): string {
  const authorization = String(req.headers.authorization ?? "");
  if (authorization.toLowerCase().startsWith("bearer ")) {
    return authorization.slice(7).trim();
  }
  return String(req.headers["x-api-key"] ?? "").trim();
}

function authenticateRequest(req: IncomingMessage): ApiKeyIdentity | null {
  const credential = requestCredential(req);
  if (!apiKeys.requiresAuthentication()) return apiKeys.anonymous();
  return apiKeys.authenticate(credential);
}

function adminAuthorized(req: IncomingMessage): boolean {
  const adminKey = config.adminKey || config.apiKey;
  return !adminKey || requestCredential(req) === adminKey;
}

function metricScope(identity: ApiKeyIdentity): string | undefined {
  return identity.source === "managed" ? identity.keyId : undefined;
}

function readBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = "";
    let size = 0;
    let settled = false;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    req.on("data", (chunk) => {
      if (settled) return;
      const text = String(chunk);
      size += text.length;
      if (size > maxBytes) {
        fail(new Error("请求体超过大小限制"));
        req.destroy();
        return;
      }
      raw += text;
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(raw);
    });
    req.on("error", fail);
  });
}

async function readJsonRecord(
  req: IncomingMessage,
  res: ServerResponse
): Promise<JsonRecord | null> {
  let raw: string;
  try {
    raw = await readBody(req, config.maxBodyBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, message.includes("大小限制") ? 413 : 400, message, "invalid_request_error");
    return null;
  }
  try {
    const value: unknown = JSON.parse(raw || "{}");
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("请求体必须是 JSON 对象");
    }
    return value as JsonRecord;
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求体不是合法 JSON";
    sendError(res, 400, message, "invalid_request_error");
    return null;
  }
}

async function handleAdmin(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (!url.pathname.startsWith("/admin/")) return false;
  if (!adminAuthorized(req)) {
    sendError(res, 401, "缺少或无效的管理员 API Key", "authentication_error");
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/metrics/summary") {
    sendJson(res, 200, metrics.summary(parseDuration(
      url.searchParams.get("window"),
      24 * 60 * 60 * 1000
    )));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/metrics/timeseries") {
    const windowMs = parseDuration(
      url.searchParams.get("window"),
      24 * 60 * 60 * 1000
    );
    const bucketValue = url.searchParams.get("bucket");
    sendJson(res, 200, metrics.timeseries(
      windowMs,
      bucketValue ? parseDuration(bucketValue, 0) : undefined
    ));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/metrics/requests") {
    const limitValue = Number(url.searchParams.get("limit"));
    const statusValue = url.searchParams.get("status");
    const status = statusValue === "success" ||
      statusValue === "error" ||
      statusValue === "canceled"
      ? statusValue
      : undefined;
    sendJson(res, 200, metrics.recent({
      windowMs: parseDuration(url.searchParams.get("window"), 24 * 60 * 60 * 1000),
      limit: Number.isFinite(limitValue) ? limitValue : 50,
      provider: url.searchParams.get("provider") || undefined,
      model: url.searchParams.get("model") || undefined,
      status
    }));
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/metrics/models") {
    sendJson(res, 200, metrics.models(parseDuration(
      url.searchParams.get("window"),
      24 * 60 * 60 * 1000
    )));
    return true;
  }

  const channels = getChannelStore(config);
  if (req.method === "GET" && url.pathname === "/admin/channels") {
    sendJson(res, 200, {
      object: "llm-gateway.channels",
      data: channels.list()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/admin/channels") {
    const body = await readJsonRecord(req, res);
    if (!body) return true;
    try {
      const channel = channels.upsert(body);
      clearModelCache(config);
      sendJson(res, 200, { object: "llm-gateway.channel", data: channel });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 400, message, "invalid_request_error");
    }
    return true;
  }

  const channelMatch = url.pathname.match(/^\/admin\/channels\/([^/]+)$/);
  if (req.method === "DELETE" && channelMatch) {
    const removed = channels.remove(decodeURIComponent(channelMatch[1]));
    if (!removed) {
      sendError(res, 404, "渠道不存在", "invalid_request_error");
      return true;
    }
    clearModelCache(config);
    sendJson(res, 200, { object: "llm-gateway.channel.deleted", id: channelMatch[1] });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/admin/keys") {
    sendJson(res, 200, {
      object: "llm-gateway.api_keys",
      data: apiKeys.list()
    });
    return true;
  }

  if (req.method === "POST" && url.pathname === "/admin/keys") {
    const body = await readJsonRecord(req, res);
    if (!body) return true;
    try {
      const created = apiKeys.create(body);
      sendJson(res, 201, {
        object: "llm-gateway.api_key",
        data: created.record,
        secret: created.secret,
        warning: "secret 只在本次响应中返回，请立即保存"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 400, message, "invalid_request_error");
    }
    return true;
  }

  const keyMatch = url.pathname.match(/^\/admin\/keys\/([^/]+)$/);
  if (req.method === "PATCH" && keyMatch) {
    const body = await readJsonRecord(req, res);
    if (!body) return true;
    const updated = apiKeys.update(decodeURIComponent(keyMatch[1]), body);
    if (!updated) {
      sendError(res, 404, "API Key 不存在", "invalid_request_error");
      return true;
    }
    sendJson(res, 200, { object: "llm-gateway.api_key", data: updated });
    return true;
  }
  if (req.method === "DELETE" && keyMatch) {
    const revoked = apiKeys.revoke(decodeURIComponent(keyMatch[1]));
    if (!revoked) {
      sendError(res, 404, "API Key 不存在", "invalid_request_error");
      return true;
    }
    sendJson(res, 200, { object: "llm-gateway.api_key.revoked", id: keyMatch[1] });
    return true;
  }

  sendError(res, 404, "管理接口不存在", "invalid_request_error");
  return true;
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

function writeStreamHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
}

function writeResponseEvent(res: ServerResponse, value: Record<string, unknown>): void {
  if (res.destroyed) return;
  const type = typeof value.type === "string" ? value.type : "message";
  res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
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
    if (externalSignal?.aborted) {
      throw new Error("请求已取消");
    }
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

async function handleStreaming(
  res: ServerResponse,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<void> {
  const context = createStreamContext(route.publicModel);
  const accumulator = new ChatAccumulator();
  const metric = beginMetric(res, "chat", route, request, identity);
  const includeUsage = includesUsage(request);
  let headersSent = false;
  let finishSeen = false;
  let metricOutcome: MetricOutcome = {
    status: "error",
    errorType: "internal_error"
  };
  const clientAbort = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  try {
    await streamUpstream(
      route,
      request,
      (chunk: UpstreamChunk) => {
        if (res.destroyed) return;
        if (!headersSent) {
          writeStreamHeaders(res);
          headersSent = true;
        }

        const events = accumulator.add(chunk);
        if (events.some((event) => event.type === "finish")) finishSeen = true;
        const visibleEvents = includeUsage
          ? events.filter((event) => event.type !== "usage")
          : events;
        for (const value of toOpenAIChunks(visibleEvents, context)) {
          res.write(`data: ${JSON.stringify(value)}\n\n`);
        }
      },
      clientAbort.signal,
      (channel) => { metric.channelId = channel.id; }
    );

    if (res.destroyed) {
      metricOutcome = {
        status: "canceled",
        errorType: "client_disconnect",
        usage: accumulator.usage,
        finishReason: accumulator.finishReason,
        toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
      };
      return;
    }
    if (!headersSent) {
      writeStreamHeaders(res);
      headersSent = true;
    }
    if (!finishSeen) {
      res.write(`data: ${JSON.stringify(finalOpenAIChunk(context, accumulator.finishReason))}\n\n`);
    }
    if (includeUsage) {
      res.write(
        `data: ${JSON.stringify(usageOpenAIChunk(context, accumulator.usage))}\n\n`
      );
    }
    res.end("data: [DONE]\n\n");
    metricOutcome = {
      status: "success",
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
  } catch (error) {
    if (res.destroyed) {
      metricOutcome = {
        status: "canceled",
        errorType: "client_disconnect",
        usage: accumulator.usage,
        finishReason: accumulator.finishReason,
        toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
      };
      return;
    }
    const failure = upstreamError(error);
    metricOutcome = {
      status: clientAbort.signal.aborted ? "canceled" : "error",
      errorType: failure.type,
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.channel.authRef);
    }
    if (!headersSent) {
      sendError(res, failure.status, failure.message, failure.type);
      return;
    }
    res.write(
      `data: ${JSON.stringify(errorResponse(failure.message, failure.type))}\n\n`
    );
    res.end("data: [DONE]\n\n");
  } finally {
    finishMetric(metric, identity, metricOutcome);
  }
}

async function handleNonStreaming(
  res: ServerResponse,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<void> {
  const accumulator = new ChatAccumulator();
  const metric = beginMetric(res, "chat", route, request, identity);
  let metricOutcome: MetricOutcome = {
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
    sendJson(res, 200, accumulator.response(route.publicModel));
    metricOutcome = {
      status: "success",
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
  } catch (error) {
    const failure = upstreamError(error);
    metricOutcome = {
      status: "error",
      errorType: failure.type,
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.channel.authRef);
    }
    sendError(res, failure.status, failure.message, failure.type);
  } finally {
    finishMetric(metric, identity, metricOutcome);
  }
}

async function handleResponseStreaming(
  res: ServerResponse,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<void> {
  const context = createResponseContext(route.publicModel, request.response);
  const accumulator = new ResponseAccumulator();
  const metric = beginMetric(res, "responses", route, request, identity);
  const clientAbort = new AbortController();
  let headersSent = false;
  let metricOutcome: MetricOutcome = {
    status: "error",
    errorType: "internal_error"
  };

  res.on("close", () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  try {
    writeStreamHeaders(res);
    headersSent = true;
    for (const value of [responseCreated(context), responseInProgress(context)]) {
      writeResponseEvent(res, value);
    }

    await streamUpstream(
      route,
      request,
      (chunk: UpstreamChunk) => {
        for (const value of responseChunkEvents(chunk, context, accumulator)) {
          writeResponseEvent(res, value);
        }
      },
      clientAbort.signal,
      (channel) => { metric.channelId = channel.id; }
    );

    if (res.destroyed) {
      metricOutcome = {
        status: "canceled",
        errorType: "client_disconnect",
        usage: accumulator.usage,
        finishReason: accumulator.finishReason,
        toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
      };
      return;
    }
    for (const value of responseFinishEvents(context, accumulator)) {
      writeResponseEvent(res, value);
    }
    rememberResponse(context, accumulator);
    res.end();
    metricOutcome = {
      status: "success",
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
  } catch (error) {
    if (res.destroyed) {
      metricOutcome = {
        status: "canceled",
        errorType: "client_disconnect",
        usage: accumulator.usage,
        finishReason: accumulator.finishReason,
        toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
      };
      return;
    }
    const failure = upstreamError(error);
    metricOutcome = {
      status: clientAbort.signal.aborted ? "canceled" : "error",
      errorType: failure.type,
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.channel.authRef);
    }
    if (!headersSent) {
      sendError(res, failure.status, failure.message, failure.type);
      return;
    }
    writeResponseEvent(res, responseFailed(context, failure.message));
    res.end();
  } finally {
    finishMetric(metric, identity, metricOutcome);
  }
}

async function handleResponseNonStreaming(
  res: ServerResponse,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<void> {
  const context = createResponseContext(route.publicModel, request.response);
  const accumulator = new ResponseAccumulator();
  const metric = beginMetric(res, "responses", route, request, identity);
  let metricOutcome: MetricOutcome = {
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
    sendJson(res, 200, accumulator.response(context));
    rememberResponse(context, accumulator);
    metricOutcome = {
      status: "success",
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
  } catch (error) {
    const failure = upstreamError(error);
    metricOutcome = {
      status: "error",
      errorType: failure.type,
      usage: accumulator.usage,
      finishReason: accumulator.finishReason,
      toolCalls: accumulator.toolCalls.filter((call) => Boolean(call)).length
    };
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.channel.authRef);
    }
    sendError(res, failure.status, failure.message, failure.type);
  } finally {
    finishMetric(metric, identity, metricOutcome);
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
  req: IncomingMessage,
  res: ServerResponse,
  normalize: RequestNormalizer,
  validate: RequestValidator,
  identity: ApiKeyIdentity,
  admission?: MetricAdmission
): Promise<PreparedRequest | null> {
  const reject = (
    status: number,
    message: string,
    type: string,
    model = "unknown"
  ): null => {
    metrics.finishAdmission(admission, model, {
      status: "error",
      errorType: type
    });
    if (admission) res.setHeader("X-Request-ID", admission.id);
    sendError(res, status, message, type);
    return null;
  };

  let rawBody: string;
  try {
    rawBody = await readBody(req, config.maxBodyBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("大小限制") ? 413 : 400;
    return reject(status, message, "invalid_request_error");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    return reject(400, "请求体不是合法 JSON", "invalid_request_error");
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
  req: IncomingMessage,
  res: ServerResponse,
  identity: ApiKeyIdentity,
  admission?: MetricAdmission
): Promise<void> {
  const prepared = await prepareRequest(
    req,
    res,
    normalizeChatRequest,
    validateChatRequest,
    identity,
    admission
  );
  if (!prepared) return;

  if (prepared.request.stream) {
    await handleStreaming(
      res,
      prepared.route,
      prepared.request,
      prepared.identity
    );
  } else {
    await handleNonStreaming(
      res,
      prepared.route,
      prepared.request,
      prepared.identity
    );
  }
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse,
  identity: ApiKeyIdentity,
  admission?: MetricAdmission
): Promise<void> {
  const prepared = await prepareRequest(
    req,
    res,
    normalizeResponseRequest,
    validateResponseRequest,
    identity,
    admission
  );
  if (!prepared) return;

  if (prepared.request.stream) {
    await handleResponseStreaming(
      res,
      prepared.route,
      prepared.request,
      prepared.identity
    );
  } else {
    await handleResponseNonStreaming(
      res,
      prepared.route,
      prepared.request,
      prepared.identity
    );
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  setCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`
  );

  if (
    req.method === "GET" &&
    (url.pathname === "/ui" || url.pathname === "/ui/" || url.pathname === "/ui/index.html")
  ) {
    sendWebUi(res);
    return;
  }

  if (
    req.method === "GET" &&
    (url.pathname === "/" ||
      url.pathname === "/health" ||
      url.pathname === "/health/live")
  ) {
    sendJson(res, 200, {
      status: "ok",
      service: "llm-gateway",
      mode: "live",
      providers: getProviders().map((provider) => provider.id)
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health/ready") {
    const auth = authStore.status(getProviders().map((provider) => provider.id));
    const models = await getModels(config);
    const ready = auth.ready && models.length > 0;
    sendJson(res, ready ? 200 : 503, {
      status: ready ? "ok" : "not_ready",
      service: "llm-gateway",
      mode: "ready",
      authenticated: auth.ready,
      models: models.length,
      providers: auth.providers
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/health/auth") {
    sendJson(
      res,
      200,
      authStore.status(getProviders().map((provider) => provider.id))
    );
    return;
  }

  if (
    req.method === "GET" &&
    url.pathname === "/.well-known/llm-gateway/capabilities"
  ) {
    const auth = authStore.status(getProviders().map((provider) => provider.id));
    const models = modelsResponse(await getModels(config));
    sendJson(res, 200, {
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
    return;
  }

  if (await handleAdmin(req, res, url)) return;

  const admissionProtocol = req.method === "POST" &&
    (url.pathname === "/v1/responses" || url.pathname === "/responses")
    ? "responses"
    : req.method === "POST" &&
      (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")
      ? "chat"
      : null;
  const admission = admissionProtocol
    ? metrics.beginAdmission(admissionProtocol)
    : undefined;
  const identity = authenticateRequest(req);
  if (!identity) {
    metrics.finishAdmission(admission, "unknown", {
      status: "error",
      errorType: "authentication_error"
    });
    if (admission) res.setHeader("X-Request-ID", admission.id);
    sendError(res, 401, "缺少或无效的代理 API Key", "authentication_error");
    return;
  }
  if (admission) admission.apiKeyId = identity.keyId;

  if (req.method === "GET" && url.pathname === "/metrics/summary") {
    const windowMs = parseDuration(
      url.searchParams.get("window"),
      24 * 60 * 60 * 1000
    );
    const scope = metricScope(identity);
    sendJson(res, 200, scope ? metrics.summary(windowMs, scope) : metrics.summary(windowMs));
    return;
  }

  if (req.method === "GET" && url.pathname === "/metrics/timeseries") {
    const windowMs = parseDuration(
      url.searchParams.get("window"),
      24 * 60 * 60 * 1000
    );
    const bucketValue = url.searchParams.get("bucket");
    const bucketMs = bucketValue ? parseDuration(bucketValue, 0) : undefined;
    const scope = metricScope(identity);
    const value = scope
      ? metrics.timeseries(windowMs, bucketMs, scope)
      : bucketMs === undefined
        ? metrics.timeseries(windowMs)
        : metrics.timeseries(windowMs, bucketMs);
    sendJson(res, 200, value);
    return;
  }

  if (req.method === "GET" && url.pathname === "/metrics/requests") {
    const windowMs = parseDuration(
      url.searchParams.get("window"),
      24 * 60 * 60 * 1000
    );
    const limitValue = Number(url.searchParams.get("limit"));
    const statusValue = url.searchParams.get("status");
    const status = statusValue === "success" ||
      statusValue === "error" ||
      statusValue === "canceled"
      ? statusValue
      : undefined;
    sendJson(res, 200, metrics.recent({
      windowMs,
      limit: Number.isFinite(limitValue) ? limitValue : 50,
      provider: url.searchParams.get("provider") || undefined,
      model: url.searchParams.get("model") || undefined,
      status,
      apiKeyId: metricScope(identity)
    }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/metrics/models") {
    const windowMs = parseDuration(
      url.searchParams.get("window"),
      24 * 60 * 60 * 1000
    );
    const scope = metricScope(identity);
    sendJson(res, 200, scope ? metrics.models(windowMs, scope) : metrics.models(windowMs));
    return;
  }

  if (req.method === "GET" && url.pathname === "/v1/models") {
    sendJson(res, 200, modelsResponse(await getModels(config)));
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/v1/responses" || url.pathname === "/responses")
  ) {
    await handleResponses(req, res, identity, admission);
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/v1/chat/completions" ||
      url.pathname === "/chat/completions")
  ) {
    await handleChat(req, res, identity, admission);
    return;
  }

  sendError(res, 404, "Not found", "invalid_request_error");
}

let gatewayServer: Server | null = null;

export function startGateway(): Server {
  if (gatewayServer) return gatewayServer;

  gatewayServer = createServer((req, res) => {
    void route(req, res).catch((error) => {
      if (res.headersSent || res.destroyed) {
        if (!res.writableEnded) res.end();
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendError(res, 500, message, "internal_error");
    });
  });

  gatewayServer.on("error", (error) => {
    console.error("LLM Gateway 服务错误:", error.message);
  });

  gatewayServer.listen(config.port, config.bindHost, () => {
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
  });

  return gatewayServer;
}
