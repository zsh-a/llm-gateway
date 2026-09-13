import { normalizeEffort } from "./config.js";
import type { UpstreamChunk } from "./provider.js";
import type {
  JsonRecord,
  ModelDescriptor,
  NormalizedChatRequest
} from "./types.js";

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

const REQUEST_OPTION_KEYS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "frequency_penalty",
  "presence_penalty",
  "tools",
  "tool_choice",
  "parallel_tool_calls",
  "response_format",
  "seed",
  "user",
  "stream_options",
  "reasoning_effort",
  "thinking"
];

function requestOptions(body: JsonRecord): JsonRecord {
  const options: JsonRecord = {};
  for (const key of REQUEST_OPTION_KEYS) {
    if (body[key] !== undefined) options[key] = body[key];
  }
  return options;
}

export function normalizeChatRequest(
  value: unknown,
  defaultModel = ""
): NormalizedChatRequest {
  const body = asRecord(value);
  const model = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : defaultModel;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const thinking = asRecord(body.thinking);
  const effortValue = body.reasoning_effort !== undefined
    ? body.reasoning_effort
    : body.thinking === false || thinking.type === "disabled"
      ? "none"
      : body.thinking === true
        ? "high"
        : "medium";

  return {
    model,
    messages,
    stream: asBoolean(body.stream),
    effort: normalizeEffort(effortValue),
    options: requestOptions(body)
  };
}

export function modelsResponse(
  models: Array<ModelDescriptor | string> = []
): JsonRecord {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: "list",
    data: models.map((value) => {
      const model = typeof value === "string"
        ? { id: value, ownedBy: "unknown" }
        : value;
      const item: JsonRecord = {
        id: model.publicId ?? model.id,
        object: "model",
        created,
        owned_by: model.ownedBy ?? "unknown"
      };
      if (model.name) item.name = model.name;
      if (model.providerId) item.provider = model.providerId;
      if (model.capabilities) item.capabilities = model.capabilities;
      if (model.maxInputTokens) item.max_input_tokens = model.maxInputTokens;
      if (model.maxOutputTokens) item.max_output_tokens = model.maxOutputTokens;
      return item;
    })
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
  const result: JsonRecord = {
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
  if (chunk.usage !== undefined) result.usage = chunk.usage;
  return result;
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
  public toolCalls: JsonRecord[];
  public usage: JsonRecord | null;

  constructor() {
    this.reasoning = "";
    this.content = "";
    this.finishReason = "stop";
    this.toolCalls = [];
    this.usage = null;
  }

  add(chunk: UpstreamChunk): void {
    const choice = firstChoice(chunk);
    const delta = choice?.delta;
    if (delta?.reasoning_content) this.reasoning += delta.reasoning_content;
    if (delta?.content) this.content += delta.content;
    if (delta?.tool_calls !== undefined) this.mergeToolCalls(delta.tool_calls);
    if (chunk.usage !== undefined) this.usage = chunk.usage;
    if (choice?.finish_reason) this.finishReason = choice.finish_reason;
  }

  response(model: string): JsonRecord {
    const message: JsonRecord = {
      role: "assistant",
      content: this.content
    };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.toolCalls.length > 0) message.tool_calls = this.toolCalls;

    const result: JsonRecord = {
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
    if (this.usage) result.usage = this.usage;
    return result;
  }

  private mergeToolCalls(value: unknown): void {
    if (!Array.isArray(value)) return;

    for (const item of value) {
      const incoming = asRecord(item);
      const rawIndex = Number(incoming.index);
      const index = Number.isInteger(rawIndex) && rawIndex >= 0
        ? rawIndex
        : this.toolCalls.length;
      const current = this.toolCalls[index] ?? {};
      const currentFunction = asRecord(current.function);
      const incomingFunction = asRecord(incoming.function);

      for (const key of ["id", "type", "index"]) {
        if (incoming[key] !== undefined) current[key] = incoming[key];
      }
      for (const key of ["name", "arguments"]) {
        if (incomingFunction[key] === undefined) continue;
        if (key === "arguments") {
          currentFunction[key] = `${String(currentFunction[key] ?? "")}${String(
            incomingFunction[key]
          )}`;
        } else {
          currentFunction[key] = incomingFunction[key];
        }
      }
      if (Object.keys(currentFunction).length > 0) current.function = currentFunction;
      this.toolCalls[index] = current;
    }
  }
}

export function errorResponse(
  message: string,
  type: string
): JsonRecord {
  return { error: { message, type } };
}
