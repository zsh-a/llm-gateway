import {
  DEFAULT_MODEL,
  FALLBACK_MODEL_IDS,
  normalizeEffort
} from "./config.js";
import type { NormalizedChatRequest, JsonRecord } from "./types.js";
import type { UpstreamChunk } from "./mimo.js";

export interface StreamContext {
  id: string;
  created: number;
  model: string;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object"
    ? value as JsonRecord
    : {};
}

function asBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;

  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

export function normalizeChatRequest(value: unknown): NormalizedChatRequest {
  const body = asRecord(value);
  const model = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : DEFAULT_MODEL;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const effortValue = body.reasoning_effort !== undefined
    ? body.reasoning_effort
    : body.thinking === true
      ? "high"
      : "medium";

  return {
    model,
    messages,
    stream: asBoolean(body.stream),
    effort: normalizeEffort(effortValue)
  };
}

export function modelsResponse(modelIds: string[] = FALLBACK_MODEL_IDS): JsonRecord {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: modelIds.map((id) => ({
      id,
      object: "model",
      created,
      owned_by: "xiaomi"
    }))
  };
}

export function createStreamContext(model: string): StreamContext {
  return {
    id: `chatcmpl-${Date.now()}`,
    created: Math.floor(Date.now() / 1000),
    model
  };
}

function firstChoice(chunk: UpstreamChunk) {
  return chunk.choices && chunk.choices.length > 0
    ? chunk.choices[0]
    : undefined;
}

function openAiDelta(chunk: UpstreamChunk): JsonRecord {
  const source = firstChoice(chunk)?.delta;
  const delta: JsonRecord = {};
  if (!source) return delta;

  if (source.role !== undefined) delta.role = source.role;
  if (source.content !== undefined) delta.content = source.content;
  if (source.reasoning_content !== undefined) {
    delta.reasoning_content = source.reasoning_content;
  }
  if (source.tool_calls !== undefined) delta.tool_calls = source.tool_calls;
  if (source.function_call !== undefined) delta.function_call = source.function_call;
  if (source.refusal !== undefined) delta.refusal = source.refusal;
  return delta;
}

export function toOpenAIChunk(
  chunk: UpstreamChunk,
  context: StreamContext
): JsonRecord {
  const choice = firstChoice(chunk);
  return {
    id: typeof chunk.id === "string" ? chunk.id : context.id,
    object: "chat.completion.chunk",
    created: context.created,
    model: context.model,
    choices: [
      {
        index: 0,
        delta: openAiDelta(chunk),
        finish_reason: choice?.finish_reason ?? null
      }
    ]
  };
}

export function finalOpenAIChunk(context: StreamContext): JsonRecord {
  return {
    id: context.id,
    object: "chat.completion.chunk",
    created: context.created,
    model: context.model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
  };
}

export class ChatAccumulator {
  public reasoning: string;
  public content: string;
  public finishReason: string;

  constructor() {
    this.reasoning = "";
    this.content = "";
    this.finishReason = "stop";
  }

  add(chunk: UpstreamChunk): void {
    const choice = firstChoice(chunk);
    const delta = choice?.delta;
    if (delta?.reasoning_content) this.reasoning += delta.reasoning_content;
    if (delta?.content) this.content += delta.content;
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
  }

  response(model: string): JsonRecord {
    const message: JsonRecord = {
      role: "assistant",
      content: this.content
    };
    if (this.reasoning) message.reasoning_content = this.reasoning;

    return {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message,
          finish_reason: this.finishReason
        }
      ]
    };
  }
}

export function errorResponse(
  message: string,
  type: string
): JsonRecord {
  return { error: { message, type } };
}
