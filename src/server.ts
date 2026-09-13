import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";

import { getAuthStore } from "./auth-store.js";
import { loadConfig } from "./config.js";
import { getModels, resolveModel, type ModelRoute } from "./models.js";
import {
  ChatAccumulator,
  createStreamContext,
  errorResponse,
  finalOpenAIChunk,
  modelsResponse,
  normalizeChatRequest,
  toOpenAIChunk
} from "./openai.js";
import {
  createResponseContext,
  normalizeResponseRequest,
  responseChunkEvents,
  responseContentPartAdded,
  responseCreated,
  responseFailed,
  responseFinishEvents,
  responseInProgress,
  responseOutputItemAdded,
  ResponseAccumulator
} from "./responses.js";
import {
  getProviders,
  UpstreamError,
  type UpstreamChunk
} from "./provider.js";
import type { NormalizedChatRequest } from "./types.js";

const config = loadConfig();
const authStore = getAuthStore(config);

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

function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  type: string
): void {
  sendJson(res, status, errorResponse(message, type));
}

function authorized(req: IncomingMessage): boolean {
  if (!config.apiKey) return true;
  const bearer = `Bearer ${config.apiKey}`;
  const authorization = String(req.headers.authorization ?? "");
  const apiKey = String(req.headers["x-api-key"] ?? "");
  return authorization === bearer || apiKey === config.apiKey;
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

async function handleStreaming(
  res: ServerResponse,
  authHeaders: Record<string, string>,
  route: ModelRoute,
  request: NormalizedChatRequest
): Promise<void> {
  const context = createStreamContext(route.publicModel);
  let headersSent = false;
  let finishSeen = false;
  const clientAbort = new AbortController();

  res.on("close", () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  try {
    await route.provider.streamChat(
      authHeaders,
      request,
      config,
      (chunk: UpstreamChunk) => {
        if (res.destroyed) return;
        if (!headersSent) {
          writeStreamHeaders(res);
          headersSent = true;
        }

        const finishReason = chunk.choices?.[0]?.finish_reason;
        if (finishReason) finishSeen = true;
        res.write(`data: ${JSON.stringify(toOpenAIChunk(chunk, context))}\n\n`);
      },
      clientAbort.signal
    );

    if (res.destroyed) return;
    if (!headersSent) {
      writeStreamHeaders(res);
      headersSent = true;
    }
    if (!finishSeen) {
      res.write(`data: ${JSON.stringify(finalOpenAIChunk(context))}\n\n`);
    }
    res.end("data: [DONE]\n\n");
  } catch (error) {
    if (res.destroyed) return;
    const failure = upstreamError(error);
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.provider.id);
    }
    if (!headersSent) {
      sendError(res, failure.status, failure.message, failure.type);
      return;
    }
    res.write(
      `data: ${JSON.stringify(errorResponse(failure.message, failure.type))}\n\n`
    );
    res.end("data: [DONE]\n\n");
  }
}

async function handleNonStreaming(
  res: ServerResponse,
  authHeaders: Record<string, string>,
  route: ModelRoute,
  request: NormalizedChatRequest
): Promise<void> {
  const accumulator = new ChatAccumulator();
  try {
    await route.provider.streamChat(authHeaders, request, config, (chunk) => {
      accumulator.add(chunk);
    });
    sendJson(res, 200, accumulator.response(route.publicModel));
  } catch (error) {
    const failure = upstreamError(error);
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.provider.id);
    }
    sendError(res, failure.status, failure.message, failure.type);
  }
}

async function handleResponseStreaming(
  res: ServerResponse,
  authHeaders: Record<string, string>,
  route: ModelRoute,
  request: NormalizedChatRequest
): Promise<void> {
  const context = createResponseContext(route.publicModel);
  const accumulator = new ResponseAccumulator();
  const clientAbort = new AbortController();
  let headersSent = false;

  res.on("close", () => {
    if (!res.writableEnded) clientAbort.abort();
  });

  try {
    writeStreamHeaders(res);
    headersSent = true;
    for (const value of [
      responseCreated(context),
      responseInProgress(context),
      responseOutputItemAdded(context),
      responseContentPartAdded(context)
    ]) {
      writeResponseEvent(res, value);
    }

    await route.provider.streamChat(
      authHeaders,
      request,
      config,
      (chunk: UpstreamChunk) => {
        for (const value of responseChunkEvents(chunk, context, accumulator)) {
          writeResponseEvent(res, value);
        }
      },
      clientAbort.signal
    );

    if (res.destroyed) return;
    for (const value of responseFinishEvents(context, accumulator)) {
      writeResponseEvent(res, value);
    }
    res.end();
  } catch (error) {
    if (res.destroyed) return;
    const failure = upstreamError(error);
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.provider.id);
    }
    if (!headersSent) {
      sendError(res, failure.status, failure.message, failure.type);
      return;
    }
    writeResponseEvent(res, responseFailed(context, failure.message));
    res.end();
  }
}

async function handleResponseNonStreaming(
  res: ServerResponse,
  authHeaders: Record<string, string>,
  route: ModelRoute,
  request: NormalizedChatRequest
): Promise<void> {
  const context = createResponseContext(route.publicModel);
  const accumulator = new ResponseAccumulator();
  try {
    await route.provider.streamChat(authHeaders, request, config, (chunk) => {
      accumulator.add(chunk);
    });
    sendJson(res, 200, accumulator.response(context));
  } catch (error) {
    const failure = upstreamError(error);
    if (failure.status === 401 || failure.status === 403) {
      authStore.invalidate(route.provider.id);
    }
    sendError(res, failure.status, failure.message, failure.type);
  }
}

interface PreparedRequest {
  route: ModelRoute;
  authHeaders: Record<string, string>;
  request: NormalizedChatRequest;
}

type RequestNormalizer = (
  value: unknown,
  defaultModel?: string
) => NormalizedChatRequest;

async function prepareRequest(
  req: IncomingMessage,
  res: ServerResponse,
  normalize: RequestNormalizer
): Promise<PreparedRequest | null> {
  let rawBody: string;
  try {
    rawBody = await readBody(req, config.maxBodyBytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes("大小限制") ? 413 : 400;
    sendError(res, status, message, "invalid_request_error");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody || "{}");
  } catch {
    sendError(res, 400, "请求体不是合法 JSON", "invalid_request_error");
    return null;
  }

  let request: NormalizedChatRequest;
  try {
    request = normalize(parsed, config.defaultModel);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 400, message, "invalid_request_error");
    return null;
  }

  const route = await resolveModel(config, request.model);
  if (!route) {
    sendError(
      res,
      400,
      request.model
        ? "未找到模型 " + request.model + "，请先请求 /v1/models"
        : "请求必须包含 model",
      "invalid_request_error"
    );
    return null;
  }

  const authSnapshot = authStore.get(route.provider.id);
  if (!authSnapshot) {
    sendError(
      res,
      503,
      "未找到 " + route.provider.name +
        " 认证，请先执行 npm run auth -- --provider " + route.provider.id,
      "auth_error"
    );
    return null;
  }

  return {
    route,
    authHeaders: authSnapshot.headers,
    request: {
      ...request,
      model: route.upstreamModel
    }
  };
}

async function handleChat(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const prepared = await prepareRequest(req, res, normalizeChatRequest);
  if (!prepared) return;

  if (prepared.request.stream) {
    await handleStreaming(
      res,
      prepared.authHeaders,
      prepared.route,
      prepared.request
    );
  } else {
    await handleNonStreaming(
      res,
      prepared.authHeaders,
      prepared.route,
      prepared.request
    );
  }
}

async function handleResponses(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const prepared = await prepareRequest(req, res, normalizeResponseRequest);
  if (!prepared) return;

  if (prepared.request.stream) {
    await handleResponseStreaming(
      res,
      prepared.authHeaders,
      prepared.route,
      prepared.request
    );
  } else {
    await handleResponseNonStreaming(
      res,
      prepared.authHeaders,
      prepared.route,
      prepared.request
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

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
    sendJson(res, 200, {
      status: "ok",
      service: "llm-gateway",
      providers: getProviders().map((provider) => provider.id)
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

  if (!authorized(req)) {
    sendError(res, 401, "缺少或无效的代理 API Key", "authentication_error");
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
    await handleResponses(req, res);
    return;
  }

  if (
    req.method === "POST" &&
    (url.pathname === "/v1/chat/completions" ||
      url.pathname === "/chat/completions")
  ) {
    await handleChat(req, res);
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
  });

  return gatewayServer;
}
