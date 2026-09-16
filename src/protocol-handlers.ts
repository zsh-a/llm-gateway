import { streamSSE } from "hono/streaming";

import { asGatewayError } from "./errors.js";
import type { GatewayDeps } from "./deps.js";
import {
  prepareGatewayRequest,
  type PreparedRequest,
  type RequestNormalizer,
  type RequestValidator
} from "./gateway-service.js";
import type { GatewayContext } from "./http-types.js";
import {
  linkClientAbort,
  readJsonRecord,
  sendError,
  sendJson,
  SseWriter,
  upstreamError
} from "./http-utils.js";
import type { ApiKeyIdentity } from "./key-store.js";
import type { ModelRoute } from "./model-router.js";
import {
  ChatAccumulator,
  createStreamContext,
  errorResponse,
  finalOpenAIChunk,
  includesUsage,
  normalizeChatRequest,
  toOpenAIChunks,
  usageOpenAIChunk,
  validateChatRequest
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
import type { JsonRecord, NormalizedChatRequest } from "./types.js";
import { streamUpstream } from "./upstream.js";
import {
  MetricsStore,
  type MetricAdmission,
  type MetricHandle,
  type MetricOutcome
} from "./metrics.js";

function beginMetric(
  metrics: MetricsStore,
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
  metrics: MetricsStore,
  apiKeys: { recordUsage: (identity: ApiKeyIdentity, usage: unknown) => void },
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
  finishSeen: boolean;
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
    finishReason: accumulator.finishSeen ? accumulator.finishReason : undefined,
    toolCalls: accumulator.toolCalls.filter(Boolean).length
  };
}

function responseEventName(value: Record<string, unknown>): string {
  return typeof value.type === "string" ? value.type : "message";
}

function handleChatStreaming(
  deps: GatewayDeps,
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Response {
  const context = createStreamContext(route.publicModel);
  const accumulator = new ChatAccumulator();
  const metric = beginMetric(deps.metrics, c, "chat", route, request, identity);
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
        deps,
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
      writer.writeJson(errorResponse(failure.message, failure.type));
      writer.writeData("[DONE]");
      await writer.flush();
    } finally {
      clientAbort.dispose();
      finishMetric(deps.metrics, deps.apiKeys, metric, identity, outcome);
    }
  });
}

async function handleChatNonStreaming(
  deps: GatewayDeps,
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<Response> {
  const accumulator = new ChatAccumulator();
  const metric = beginMetric(deps.metrics, c, "chat", route, request, identity);
  let outcome: MetricOutcome = {
    status: "error",
    errorType: "internal_error"
  };
  try {
    await streamUpstream(
      deps,
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
    return sendError(c, failure.status, failure.message, failure.type);
  } finally {
    finishMetric(deps.metrics, deps.apiKeys, metric, identity, outcome);
  }
}

function handleResponseStreaming(
  deps: GatewayDeps,
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Response {
  const context = createResponseContext(route.publicModel, request.response);
  const accumulator = new ResponseAccumulator();
  const metric = beginMetric(deps.metrics, c, "responses", route, request, identity);
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
        deps,
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
      rememberResponse(context, request, accumulator, deps.responseStore, identity.keyId);
      await writer.flush();
      outcome = outcomeFor(accumulator, "success");
    } catch (error) {
      if (aborted()) {
        outcome = outcomeFor(accumulator, "canceled", "client_disconnect");
        return;
      }
      const failure = upstreamError(error);
      outcome = outcomeFor(accumulator, "error", failure.type);
      writeEvent(responseFailed(context, failure.message));
      await writer.flush();
    } finally {
      clientAbort.dispose();
      finishMetric(deps.metrics, deps.apiKeys, metric, identity, outcome);
    }
  });
}

async function handleResponseNonStreaming(
  deps: GatewayDeps,
  c: GatewayContext,
  route: ModelRoute,
  request: NormalizedChatRequest,
  identity: ApiKeyIdentity
): Promise<Response> {
  const context = createResponseContext(route.publicModel, request.response);
  const accumulator = new ResponseAccumulator();
  const metric = beginMetric(deps.metrics, c, "responses", route, request, identity);
  let outcome: MetricOutcome = {
    status: "error",
    errorType: "internal_error"
  };
  try {
    await streamUpstream(
      deps,
      route,
      request,
      (chunk) => { accumulator.add(chunk); },
      undefined,
      (channel) => { metric.channelId = channel.id; }
    );
    const response = sendJson(c, 200, accumulator.response(context));
    rememberResponse(context, request, accumulator, deps.responseStore, identity.keyId);
    outcome = outcomeFor(accumulator, "success");
    return response;
  } catch (error) {
    const failure = upstreamError(error);
    outcome = outcomeFor(accumulator, "error", failure.type);
    return sendError(c, failure.status, failure.message, failure.type);
  } finally {
    finishMetric(deps.metrics, deps.apiKeys, metric, identity, outcome);
  }
}

async function prepareRequest(
  deps: GatewayDeps,
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
    deps.metrics.finishAdmission(admission, model, {
      status: "error",
      errorType: type
    });
    if (admission) c.header("X-Request-ID", admission.id);
    return sendError(c, status, message, type);
  };

  let parsed: JsonRecord;
  try {
    parsed = await readJsonRecord(c, deps.config.maxBodyBytes) as JsonRecord;
  } catch (error) {
    const failure = asGatewayError(error, 400, "invalid_request_error");
    return reject(failure.status, failure.message, failure.type);
  }

  try {
    const prepared = await prepareGatewayRequest(
      deps,
      parsed,
      normalize,
      validate,
      identity
    );
    deps.metrics.acceptAdmission(admission);
    return prepared;
  } catch (error) {
    const failure = asGatewayError(error, 400, "invalid_request_error");
    return reject(
      failure.status,
      failure.message,
      failure.type,
      failure.model ?? "unknown"
    );
  }
}

export async function handleChat(
  deps: GatewayDeps,
  c: GatewayContext,
  identity: ApiKeyIdentity,
  admission: MetricAdmission | undefined
): Promise<Response> {
  const prepared = await prepareRequest(
    deps,
    c,
    normalizeChatRequest,
    validateChatRequest,
    identity,
    admission
  );
  if (prepared instanceof Response) return prepared;
  return prepared.request.stream
    ? handleChatStreaming(deps, c, prepared.route, prepared.request, prepared.identity)
    : handleChatNonStreaming(deps, c, prepared.route, prepared.request, prepared.identity);
}

export async function handleResponses(
  deps: GatewayDeps,
  c: GatewayContext,
  identity: ApiKeyIdentity,
  admission: MetricAdmission | undefined
): Promise<Response> {
  const prepared = await prepareRequest(
    deps,
    c,
    normalizeResponseRequest,
    validateResponseRequest,
    identity,
    admission
  );
  if (prepared instanceof Response) return prepared;
  return prepared.request.stream
    ? handleResponseStreaming(deps, c, prepared.route, prepared.request, prepared.identity)
    : handleResponseNonStreaming(deps, c, prepared.route, prepared.request, prepared.identity);
}
