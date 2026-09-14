import { normalizeEffort } from "./config.js";
import {
  StreamAccumulator,
  type StreamEvent,
  type StreamToolCall
} from "./stream.js";
import { normalizeToolHistory } from "./tool-history.js";
import type {
  JsonRecord,
  ModelDescriptor,
  NormalizedChatRequest,
  OpenAIChatCompletion,
  OpenAIChatCompletionChunk
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
  "thinking",
  "service_tier",
  "logprobs",
  "top_logprobs",
  "n"
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
  for (const key of ["reasoning_effort", "reasoningEffort"]) {
    if (body[key] !== undefined && typeof body[key] !== "string") {
      throw new Error(`${key} 必须是字符串`);
    }
  }
  const model = typeof body.model === "string" && body.model.trim()
    ? body.model.trim()
    : defaultModel;
  const messages = normalizeToolHistory(
    Array.isArray(body.messages) ? body.messages : []
  );
  const thinking = asRecord(body.thinking);
  const reasoning = asRecord(body.reasoning);
  const effortValue = body.reasoning_effort !== undefined
    ? body.reasoning_effort
    : body.reasoningEffort !== undefined
      ? body.reasoningEffort
      : reasoning.effort !== undefined
        ? reasoning.effort
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
    reasoningEffortExplicit:
      body.reasoning_effort !== undefined ||
      body.reasoningEffort !== undefined ||
      body.reasoning !== undefined ||
      body.thinking !== undefined,
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
      if (model.capabilities?.reasoning !== undefined) {
        // DeepSeek Harness uses this top-level field when it can consume a
        // discovered model descriptor; keep the nested OpenAI-compatible
        // capability above for other clients.
        item.reasoning = model.capabilities.reasoning;
      }
      if (model.reasoningEfforts) {
        item.reasoningEfforts = model.reasoningEfforts;
      }
      if (model.defaultReasoningEffort) {
        item.defaultReasoningEffort = model.defaultReasoningEffort;
      }
      if (model.maxInputTokens) {
        item.max_input_tokens = model.maxInputTokens;
        item.contextWindow = model.maxInputTokens;
      }
      if (model.maxOutputTokens) {
        item.max_output_tokens = model.maxOutputTokens;
        item.maxTokens = model.maxOutputTokens;
      }
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

function chatChunk(value: JsonRecord): JsonRecord {
  // Provider extensions (for example reasoning_content) are intentionally
  // allowed at this boundary, while the standard fields are kept aligned with
  // the official SDK type.
  return value as unknown as OpenAIChatCompletionChunk as unknown as JsonRecord;
}

function chatCompletion(value: JsonRecord): JsonRecord {
  return value as unknown as OpenAIChatCompletion as unknown as JsonRecord;
}

function baseChunk(
  context: StreamContext,
  choices: unknown[],
  usage?: JsonRecord | null
): JsonRecord {
  const result: JsonRecord = {
    id: context.id,
    object: "chat.completion.chunk",
    created: context.created,
    model: context.model,
    choices
  };
  if (usage !== undefined) result.usage = usage;
  return result;
}

function toolCallDelta(event: Extract<StreamEvent, { type: "tool_call" }>): JsonRecord {
  const functionValue: JsonRecord = {};
  if (event.name !== undefined) functionValue.name = event.name;
  if (event.arguments !== undefined) functionValue.arguments = event.arguments;

  const toolCall: JsonRecord = {
    index: event.index,
    type: event.toolType ?? "function",
    function: functionValue
  };
  toolCall.id = event.id ?? event.callId ?? `call_${event.index}`;
  return toolCall;
}

function chunkForEvent(
  event: StreamEvent,
  context: StreamContext
): JsonRecord {
  if (event.type === "usage") {
    return chatChunk(baseChunk(context, [], event.usage));
  }

  const delta: JsonRecord = {};
  let finishReason: string | null = null;
  switch (event.type) {
    case "role":
      delta.role = event.role;
      break;
    case "text":
      delta.content = event.text;
      break;
    case "reasoning":
      delta.reasoning_content = event.text;
      break;
    case "refusal":
      delta.refusal = event.text;
      break;
    case "tool_call":
      delta.tool_calls = [toolCallDelta(event)];
      break;
    case "finish":
      finishReason = event.reason;
      break;
  }

  return chatChunk(baseChunk(context, [
    { index: 0, delta, finish_reason: finishReason }
  ]));
}

export function toOpenAIChunks(
  events: StreamEvent[],
  context: StreamContext
): JsonRecord[] {
  return events.map((event) => chunkForEvent(event, context));
}

export function finalOpenAIChunk(
  context: StreamContext,
  finishReason = "stop"
): JsonRecord {
  return chatChunk(baseChunk(context, [
    { index: 0, delta: {}, finish_reason: finishReason }
  ]));
}

export function usageOpenAIChunk(
  context: StreamContext,
  usage: JsonRecord | null
): JsonRecord {
  return chatChunk(baseChunk(context, [], usage));
}

export function includesUsage(request: NormalizedChatRequest): boolean {
  const streamOptions = asRecord(request.options.stream_options);
  return request.stream && streamOptions.include_usage === true;
}

export function validateChatRequest(
  request: NormalizedChatRequest
): string | null {
  const n = request.options.n;
  if (n !== undefined && (typeof n !== "number" || !Number.isInteger(n) || n !== 1)) {
    return "当前网关只支持 n=1；多候选结果无法安全映射到单个上游响应";
  }

  const streamOptions = request.options.stream_options;
  if (
    streamOptions !== undefined &&
    (streamOptions === null || typeof streamOptions !== "object" || Array.isArray(streamOptions))
  ) {
    return "stream_options 必须是对象";
  }
  const streamOptionsRecord = asRecord(streamOptions);
  if (
    streamOptionsRecord.include_usage !== undefined &&
    typeof streamOptionsRecord.include_usage !== "boolean"
  ) {
    return "stream_options.include_usage 必须是布尔值";
  }

  const tools = request.options.tools;
  if (tools !== undefined && !Array.isArray(tools)) {
    return "tools 必须是数组";
  }
  const parallelToolCalls = request.options.parallel_tool_calls;
  if (parallelToolCalls !== undefined && typeof parallelToolCalls !== "boolean") {
    return "parallel_tool_calls 必须是布尔值";
  }
  return null;
}

export function validateModelRequest(
  request: NormalizedChatRequest,
  model: ModelDescriptor
): string | null {
  if (model.capabilities?.chat === false) {
    return `模型 ${model.publicId ?? model.id} 不支持 Chat Completions/Responses`;
  }
  if (!request.reasoningEffortExplicit || request.effort === "none") return null;
  if (model.capabilities?.reasoning === false) {
    return `模型 ${model.publicId ?? model.id} 不支持 reasoning_effort`;
  }

  const efforts = model.reasoningEfforts;
  if (efforts) {
    const supported = Object.prototype.hasOwnProperty.call(efforts, request.effort);
    if (!supported) {
      return `模型 ${model.publicId ?? model.id} 不支持 reasoning_effort=${request.effort}`;
    }
  }
  return null;
}

function chatToolCall(call: StreamToolCall): JsonRecord {
  return {
    id: call.id ?? call.callId ?? `call_${call.index}`,
    type: call.type || "function",
    function: {
      name: call.name,
      arguments: call.arguments
    }
  };
}

export class ChatAccumulator extends StreamAccumulator {
  assistantMessage(): JsonRecord {
    const message: JsonRecord = {
      role: "assistant",
      content: this.content
    };
    if (this.reasoning) message.reasoning_content = this.reasoning;
    if (this.refusal) message.refusal = this.refusal;
    if (this.toolCalls.length > 0) {
      const toolCalls: JsonRecord[] = [];
      for (const call of this.toolCalls) {
        if (call) toolCalls.push(chatToolCall(call));
      }
      message.tool_calls = toolCalls;
    }
    return message;
  }

  response(model: string): JsonRecord {
    const result: JsonRecord = {
      id: `chatcmpl-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: this.assistantMessage(),
          finish_reason: this.finishReason
        }
      ]
    };
    if (this.usage) result.usage = this.usage;
    return chatCompletion(result);
  }
}

export function errorResponse(
  message: string,
  type: string
): JsonRecord {
  return { error: { message, type } };
}
