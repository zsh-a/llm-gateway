import { ChatAccumulator, normalizeChatRequest } from "./openai.js";
import {
  asNumber,
  asRecord,
  asString,
  asTrimmedString,
  serializedValue
} from "./json.js";
import type { UpstreamChunk } from "./provider.js";
import type { ResponseStore, StoredResponse } from "./response-store.js";
import { cloneJsonValue } from "./response-store.js";
import type { StreamEvent, StreamToolCall } from "./events.js";
import type {
  JsonRecord,
  NormalizedChatRequest,
  OpenAIResponse,
  OpenAIResponseStreamEvent,
  ResponseRequestOptions
} from "./types.js";
import { responsesUsage } from "./usage.js";

function roleValue(value: unknown, fallback: string): string {
  const role = asTrimmedString(value) ?? "";
  return ["system", "developer", "user", "assistant"].includes(role)
    ? role
    : fallback;
}

function isFunctionCallType(type: string): boolean {
  return type === "function_call" || type === "custom_tool_call";
}

function isFunctionCallOutputType(type: string): boolean {
  return type === "function_call_output" || type === "custom_tool_call_output";
}

function chatContent(value: unknown): unknown {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) {
    const record = asRecord(value);
    if (typeof record.text === "string") return record.text;
    return "";
  }

  const parts: unknown[] = [];
  let textOnly = true;
  for (const item of value) {
    const record = asRecord(item);
    const type = asTrimmedString(record.type) ?? "";

    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      if (text) parts.push(text);
      continue;
    }

    if (type === "input_image") {
      const imageUrl = asTrimmedString(record.image_url) ?? "";
      if (imageUrl) {
        const image: JsonRecord = { url: imageUrl };
        if (record.detail !== undefined) image.detail = record.detail;
        parts.push({ type: "image_url", image_url: image });
      }
      textOnly = false;
      continue;
    }

    if (type === "input_file") {
      const fileId = asTrimmedString(record.file_id) ?? "";
      parts.push("[file input" + (fileId ? ": " + fileId : "") + "]");
      continue;
    }

    const text = typeof record.text === "string" ? record.text : "";
    if (text) {
      parts.push(text);
    } else {
      textOnly = false;
      parts.push(item);
    }
  }

  if (textOnly) return parts.map((part) => String(part)).join("");
  return parts;
}

function inputItemToMessage(
  value: unknown,
  fallbackRole: string
): JsonRecord | null {
  if (typeof value === "string") {
    return { role: fallbackRole, content: value };
  }

  const item = asRecord(value);
  const type = asTrimmedString(item.type) ?? "";
  if (type === "reasoning" || type === "item_reference") return null;

  if (isFunctionCallOutputType(type)) {
    const message: JsonRecord = {
      role: "tool",
      content: serializedValue(item.output ?? "")
    };
    const callId = asTrimmedString(item.call_id);
    if (!callId) throw new Error("Responses function_call_output 缺少 call_id");
    message.tool_call_id = callId;
    return message;
  }

  if (isFunctionCallType(type)) {
    const callId = asTrimmedString(item.call_id);
    if (!callId) throw new Error("Responses function_call 缺少 call_id");
    const functionCall: JsonRecord = {
      id: callId,
      type: "function",
      function: {
        name: asTrimmedString(item.name) ?? "",
        arguments: serializedValue(item.arguments ?? item.input ?? "{}")
      }
    };
    return {
      role: "assistant",
      content: "",
      tool_calls: [functionCall]
    };
  }

  if (
    type === "message" ||
    item.role !== undefined ||
    item.content !== undefined ||
    item.text !== undefined
  ) {
    if (item.role === "tool") {
      throw new Error("Responses 工具结果必须使用 function_call_output");
    }
    if (
      item.tool_calls !== undefined ||
      item.function_call !== undefined ||
      item.tool_call_id !== undefined ||
      item.call_id !== undefined
    ) {
      throw new Error("Responses message 不接受 Chat 工具字段");
    }
    const message: JsonRecord = {
      role: roleValue(item.role, fallbackRole),
      content: item.content !== undefined
        ? chatContent(item.content)
        : asString(item.text) ?? ""
    };
    return message;
  }

  return null;
}

function inputMessages(value: unknown, fallbackRole: string): JsonRecord[] {
  const values = Array.isArray(value) ? value : [value];
  const messages: JsonRecord[] = [];
  const pendingToolCalls: JsonRecord[] = [];

  const flushToolCalls = (): void => {
    if (pendingToolCalls.length === 0) return;
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: pendingToolCalls.splice(0)
    });
  };

  for (const item of values) {
    const type = asTrimmedString(asRecord(item).type) ?? "";
    if (isFunctionCallType(type)) {
      const message = inputItemToMessage(item, fallbackRole);
      const toolCalls = message?.tool_calls;
      if (Array.isArray(toolCalls)) {
        pendingToolCalls.push(...toolCalls as JsonRecord[]);
      }
      continue;
    }

    // Responses represents parallel calls as consecutive function_call items.
    // They must become one assistant message with multiple tool_calls before
    // the canonical Chat history validator sees them.
    flushToolCalls();
    const message = inputItemToMessage(item, fallbackRole);
    if (message) messages.push(message);
  }

  flushToolCalls();
  return messages;
}

function responseTools(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  return value.map((item) => {
    const tool = asRecord(item);
    if (
      (asTrimmedString(tool.type) ?? "") !== "function" ||
      tool.function !== undefined ||
      !asTrimmedString(tool.name)
    ) {
      return item;
    }

    const functionValue: JsonRecord = {
      name: asTrimmedString(tool.name) ?? "",
      description: tool.description,
      parameters: tool.parameters ?? {}
    };
    if (tool.strict !== undefined) functionValue.strict = tool.strict;
    return { type: "function", function: functionValue };
  });
}

function responseToolChoice(value: unknown): unknown {
  if (typeof value === "string" || value === undefined || value === null) {
    return value;
  }
  const choice = asRecord(value);
  if (
    (asTrimmedString(choice.type) ?? "") === "function" &&
    choice.function === undefined &&
    asTrimmedString(choice.name)
  ) {
    return {
      type: "function",
      function: { name: asTrimmedString(choice.name) }
    };
  }
  return value;
}

function optionalNumber(value: unknown, field: string): number | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  const number = asNumber(value);
  if (number === undefined) throw new Error(`${field} 必须是数字或 null`);
  return number;
}

function responseFormat(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const format = asRecord(value);
  const type = asTrimmedString(format.type) ?? "";

  if (type === "text") return undefined;
  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    const name = asTrimmedString(format.name) ?? "";
    if (!name || format.schema === undefined) {
      throw new Error("text.format=json_schema 必须包含 name 和 schema");
    }
    const schema: JsonRecord = {
      name,
      schema: format.schema
    };
    if (format.description !== undefined) schema.description = format.description;
    if (format.strict !== undefined) schema.strict = format.strict;
    return { type: "json_schema", json_schema: schema };
  }

  throw new Error("暂不支持 Responses text.format 类型: " + (type || "unknown"));
}

export interface ResponseNormalizationContext {
  responseStore?: ResponseStore;
  owner?: string;
}

function mergeResponseOptions(
  inherited: ResponseRequestOptions | undefined,
  current: ResponseRequestOptions
): ResponseRequestOptions {
  return {
    ...(inherited ? cloneJsonValue(inherited) as ResponseRequestOptions : {}),
    ...current
  };
}

function responseRequestOptions(body: JsonRecord): ResponseRequestOptions {
  const options: ResponseRequestOptions = {};

  for (const key of [
    "background",
    "conversation",
    "include",
    "max_tool_calls",
    "prompt",
    "service_tier",
    "stream_options"
  ]) {
    if (body[key] !== undefined) {
      throw new Error(`暂不支持 Responses 字段 ${key}；网关不会静默丢弃该字段`);
    }
  }

  if (body.instructions !== undefined) options.instructions = body.instructions;
  if (body.text !== undefined && body.text !== null) {
    if (typeof body.text !== "object" || Array.isArray(body.text)) {
      throw new Error("Responses text 必须是对象");
    }
    options.text = body.text as JsonRecord;
  }

  if (body.previous_response_id === null) {
    options.previousResponseId = null;
  } else if (body.previous_response_id !== undefined) {
    const id = asTrimmedString(body.previous_response_id) ?? "";
    if (!id) throw new Error("previous_response_id 必须是非空字符串或 null");
    options.previousResponseId = id;
  }

  if (body.metadata !== undefined) {
    options.metadata = body.metadata === null ? null : asRecord(body.metadata);
  }
  if (body.store !== undefined) {
    if (typeof body.store !== "boolean") throw new Error("store 必须是布尔值");
    options.store = body.store;
  }
  if (body.parallel_tool_calls !== undefined) {
    if (typeof body.parallel_tool_calls !== "boolean") {
      throw new Error("parallel_tool_calls 必须是布尔值");
    }
    options.parallelToolCalls = body.parallel_tool_calls;
  }
  if (body.temperature !== undefined) {
    options.temperature = optionalNumber(body.temperature, "temperature");
  }
  if (body.top_p !== undefined) {
    options.topP = optionalNumber(body.top_p, "top_p");
  }
  if (body.tool_choice !== undefined) options.toolChoice = body.tool_choice;
  if (Array.isArray(body.tools)) options.tools = body.tools;
  if (body.truncation !== undefined) options.truncation = body.truncation as string;
  if (body.max_output_tokens !== undefined) {
    options.maxOutputTokens = optionalNumber(
      body.max_output_tokens,
      "max_output_tokens"
    );
  }
  if (body.reasoning !== undefined) {
    if (
      body.reasoning !== null &&
      (typeof body.reasoning !== "object" || Array.isArray(body.reasoning))
    ) {
      throw new Error("reasoning 必须是对象或 null");
    }
    options.reasoning = body.reasoning === null ? null : asRecord(body.reasoning);
  }

  return options;
}

export function normalizeResponseRequest(
  value: unknown,
  defaultModel = "",
  context: ResponseNormalizationContext = {}
): NormalizedChatRequest {
  const body = asRecord(value);
  const responseOverrides = responseRequestOptions(body);
  const previous = responseOverrides.previousResponseId
    ? context.responseStore?.get(
      responseOverrides.previousResponseId,
      context.owner ?? "anonymous"
    ) ?? null
    : null;
  const response = mergeResponseOptions(previous?.response, responseOverrides);
  const messages: JsonRecord[] = [];

  if (body.instructions !== undefined) {
    messages.push(...inputMessages(body.instructions, "system"));
  }
  if (responseOverrides.previousResponseId) {
    if (!previous) {
      throw new Error("previous_response_id 不存在或已过期；网关只在当前进程内保存 Responses 会话");
    }
    messages.push(...previous.messages);
  }
  if (body.input !== undefined) {
    messages.push(...inputMessages(body.input, "user"));
  }

  const inherited: JsonRecord = previous
    ? { model: previous.model, ...previous.options }
    : {};
  const normalized: JsonRecord = {
    ...inherited,
    ...body,
    messages
  };

  const reasoning = asRecord(normalized.reasoning);
  if (reasoning.effort !== undefined) {
    normalized.reasoning_effort = reasoning.effort;
  }
  if (
    normalized.max_output_tokens !== undefined &&
    normalized.max_completion_tokens === undefined &&
    normalized.max_tokens === undefined
  ) {
    normalized.max_completion_tokens = normalized.max_output_tokens;
  }
  if (normalized.tools !== undefined) {
    normalized.tools = responseTools(normalized.tools);
  }
  if (normalized.tool_choice !== undefined) {
    normalized.tool_choice = responseToolChoice(normalized.tool_choice);
  }

  if (normalized.text !== undefined && normalized.text !== null) {
    const text = asRecord(normalized.text);
    const format = responseFormat(text.format);
    if (format !== undefined) normalized.response_format = format;
  }

  return {
    ...normalizeChatRequest(normalized, defaultModel),
    response
  };
}

export function validateResponseRequest(
  request: NormalizedChatRequest
): string | null {
  const truncation = request.response?.truncation;
  if (
    truncation !== undefined &&
    truncation !== null &&
    truncation !== "disabled"
  ) {
    return "当前网关仅支持 Responses truncation=disabled";
  }
  return null;
}

export interface ResponseContext {
  id: string;
  created: number;
  model: string;
  messageId: string;
  reasoningId: string;
  sequence: number;
  options: ResponseRequestOptions;
  nextOutputIndex: number;
  messageOutputIndex: number;
  messagePartType: "output_text" | "refusal" | null;
  reasoningOutputIndex: number;
  functionOutputs: {
    [key: string]: {
      outputIndex: number;
      itemId: string;
      callId: string;
    };
  };
}

export function createResponseContext(
  model: string,
  options: ResponseRequestOptions = {}
): ResponseContext {
  const token = Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
  return {
    id: "resp_" + token,
    created: Math.floor(Date.now() / 1000),
    model,
    messageId: "msg_" + token,
    reasoningId: "rs_" + token,
    sequence: 0,
    options,
    nextOutputIndex: 0,
    messageOutputIndex: -1,
    messagePartType: null,
    reasoningOutputIndex: -1,
    functionOutputs: {}
  };
}

function outputMessage(
  accumulator: ResponseAccumulator,
  context: ResponseContext,
  status = "completed"
): JsonRecord {
  const content: JsonRecord[] = [];
  if (accumulator.content || !accumulator.refusal) {
    content.push({
      type: "output_text",
      text: accumulator.content,
      annotations: []
    });
  }
  if (accumulator.refusal) {
    content.push({ type: "refusal", refusal: accumulator.refusal });
  }

  return {
    id: context.messageId,
    type: "message",
    status,
    role: "assistant",
    content
  };
}

function callItem(
  context: ResponseContext,
  call: StreamToolCall,
  status: string,
  argumentsValue: string
): JsonRecord {
  const slot = context.functionOutputs[String(call.index)];
  const itemId = slot?.itemId ?? call.id ?? call.callId ??
    context.id + "_call_" + String(call.index);
  const callId = slot?.callId ?? call.callId ?? call.id ?? itemId;
  return {
    id: itemId,
    type: "function_call",
    status,
    call_id: callId,
    name: call.name,
    arguments: argumentsValue
  };
}

function reasoningItem(
  accumulator: ResponseAccumulator,
  context: ResponseContext,
  status = "completed"
): JsonRecord {
  return {
    id: context.reasoningId,
    type: "reasoning",
    status,
    // DeepSeek's Responses dialect exposes the actual chain-of-thought as a
    // reasoning_text content part. `summary_text` is a different, optional
    // Responses feature and causes clients such as Harness to hide the text.
    content: [{ type: "reasoning_text", text: accumulator.reasoning }],
    summary: []
  };
}

function functionOutputs(
  accumulator: ResponseAccumulator,
  context: ResponseContext
): JsonRecord[] {
  const output: JsonRecord[] = [];
  for (const call of accumulator.toolCalls) {
    if (!call) continue;
    output.push(callItem(context, call, "completed", call.arguments));
  }
  return output;
}

function outputItems(
  accumulator: ResponseAccumulator,
  context: ResponseContext
): JsonRecord[] {
  const entries: Array<{ index: number; item: JsonRecord }> = [];
  let fallbackIndex = 0;

  if (accumulator.reasoning) {
    entries.push({
      index: context.reasoningOutputIndex >= 0
        ? context.reasoningOutputIndex
        : fallbackIndex++,
      item: reasoningItem(accumulator, context)
    });
  }
  if (accumulator.content || accumulator.refusal || accumulator.toolCalls.length === 0) {
    entries.push({
      index: context.messageOutputIndex >= 0
        ? context.messageOutputIndex
        : fallbackIndex++,
      item: outputMessage(accumulator, context)
    });
  }
  const calls = functionOutputs(accumulator, context);
  let callOutputIndex = 0;
  for (const item of accumulator.toolCalls) {
    if (!item) continue;
    entries.push({
      index: context.functionOutputs[String(item.index)]?.outputIndex ??
        fallbackIndex++,
      item: calls[callOutputIndex++]
    });
  }

  entries.sort((left, right) => left.index - right.index);
  return entries.map((entry) => entry.item);
}

function responseObject(
  context: ResponseContext,
  status: string,
  output: JsonRecord[],
  outputText: string,
  usage: JsonRecord | null,
  error: JsonRecord | null = null
): JsonRecord {
  const options = context.options;
  const result: JsonRecord = {
    id: context.id,
    object: "response",
    created_at: context.created,
    status,
    completed_at: status === "in_progress" ? null : Math.floor(Date.now() / 1000),
    error,
    incomplete_details: status === "incomplete"
      ? { reason: "max_output_tokens" }
      : null,
    instructions: options.instructions ?? null,
    metadata: options.metadata ?? null,
    model: context.model,
    output,
    output_text: outputText,
    parallel_tool_calls: options.parallelToolCalls ?? true,
    previous_response_id: options.previousResponseId ?? null,
    reasoning: options.reasoning ?? { effort: null, summary: null },
    // Responses are stored by default so previous_response_id remains useful;
    // an explicit store=false is honored by rememberResponse.
    store: options.store ?? true,
    temperature: options.temperature ?? 1,
    text: options.text ?? { format: { type: "text" } },
    tool_choice: options.toolChoice ?? "auto",
    tools: options.tools ?? [],
    top_p: options.topP ?? 1,
    truncation: options.truncation ?? "disabled",
    usage
  };
  return result as unknown as OpenAIResponse as unknown as JsonRecord;
}

export class ResponseAccumulator {
  private readonly chat = new ChatAccumulator();

  get content(): string {
    return this.chat.content;
  }

  get reasoning(): string {
    return this.chat.reasoning;
  }

  get refusal(): string {
    return this.chat.refusal;
  }

  get toolCalls(): StreamToolCall[] {
    return this.chat.toolCalls;
  }

  get finishReason(): string {
    return this.chat.finishReason;
  }

  get finishSeen(): boolean {
    return this.chat.finishSeen;
  }

  get usage(): JsonRecord | null {
    return this.chat.usage;
  }

  assistantMessage(): JsonRecord {
    return this.chat.assistantMessage();
  }

  add(chunk: UpstreamChunk): StreamEvent[] {
    return this.chat.add(chunk);
  }

  response(context: ResponseContext): JsonRecord {
    const status = this.finishReason === "length" ? "incomplete" : "completed";
    const result = responseObject(
      context,
      status,
      outputItems(this, context),
      this.content,
      responsesUsage(this.usage)
    );
    if (this.reasoning) result.reasoning_content = this.reasoning;
    return result;
  }
}

function event(
  context: ResponseContext,
  type: string,
  value: JsonRecord
): JsonRecord {
  context.sequence += 1;
  const result = {
    type,
    ...value,
    sequence_number: context.sequence
  };
  return result as unknown as OpenAIResponseStreamEvent as unknown as JsonRecord;
}

function nextOutputIndex(context: ResponseContext): number {
  const index = context.nextOutputIndex;
  context.nextOutputIndex += 1;
  return index;
}

function startMessage(
  context: ResponseContext,
  partType: "output_text" | "refusal"
): JsonRecord[] {
  if (context.messageOutputIndex >= 0) return [];
  context.messageOutputIndex = nextOutputIndex(context);
  context.messagePartType = partType;

  const part = partType === "refusal"
    ? { type: "refusal", refusal: "" }
    : { type: "output_text", text: "", annotations: [] };
  return [
    event(context, "response.output_item.added", {
      output_index: context.messageOutputIndex,
      item: {
        id: context.messageId,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: []
      }
    }),
    event(context, "response.content_part.added", {
      item_id: context.messageId,
      output_index: context.messageOutputIndex,
      content_index: 0,
      part
    })
  ];
}

function startReasoning(context: ResponseContext): JsonRecord[] {
  if (context.reasoningOutputIndex >= 0) return [];
  context.reasoningOutputIndex = nextOutputIndex(context);
  return [
    event(context, "response.output_item.added", {
      output_index: context.reasoningOutputIndex,
      item: {
        id: context.reasoningId,
        type: "reasoning",
        status: "in_progress",
        content: [],
        summary: []
      }
    }),
    event(context, "response.content_part.added", {
      item_id: context.reasoningId,
      output_index: context.reasoningOutputIndex,
      content_index: 0,
      part: { type: "reasoning_text", text: "" }
    })
  ];
}

function startFunctionCall(
  context: ResponseContext,
  call: StreamToolCall
): JsonRecord[] {
  const key = String(call.index);
  if (context.functionOutputs[key]) return [];

  const itemId = call.id ?? call.callId ?? context.id + "_call_" + key;
  const callId = call.callId ?? call.id ?? itemId;
  context.functionOutputs[key] = {
    outputIndex: nextOutputIndex(context),
    itemId,
    callId
  };

  return [
    event(context, "response.output_item.added", {
      output_index: context.functionOutputs[key].outputIndex,
      item: callItem(context, call, "in_progress", "")
    })
  ];
}

export function responseCreated(context: ResponseContext): JsonRecord {
  return event(context, "response.created", {
    response: responseObject(context, "in_progress", [], "", null)
  });
}

export function responseInProgress(context: ResponseContext): JsonRecord {
  return event(context, "response.in_progress", {
    response: responseObject(context, "in_progress", [], "", null)
  });
}

export function responseChunkEvents(
  chunk: UpstreamChunk,
  context: ResponseContext,
  accumulator: ResponseAccumulator
): JsonRecord[] {
  const events = accumulator.add(chunk);
  const output: JsonRecord[] = [];

  for (const streamEvent of events) {
    switch (streamEvent.type) {
      case "reasoning":
        output.push(...startReasoning(context));
        output.push(event(context, "response.reasoning_text.delta", {
          item_id: context.reasoningId,
          output_index: context.reasoningOutputIndex,
          content_index: 0,
          delta: streamEvent.text
        }));
        break;
      case "text":
        output.push(...startMessage(context, "output_text"));
        output.push(event(context, "response.output_text.delta", {
          item_id: context.messageId,
          output_index: context.messageOutputIndex,
          content_index: 0,
          delta: streamEvent.text,
          logprobs: []
        }));
        break;
      case "refusal":
        output.push(...startMessage(context, "refusal"));
        output.push(event(context, "response.refusal.delta", {
          item_id: context.messageId,
          output_index: context.messageOutputIndex,
          content_index: 0,
          delta: streamEvent.text
        }));
        break;
      case "tool_call": {
        const call = accumulator.toolCalls[streamEvent.index];
        if (!call) break;
        output.push(...startFunctionCall(context, call));
        if (streamEvent.arguments !== undefined && streamEvent.arguments !== "") {
          const slot = context.functionOutputs[String(streamEvent.index)];
          output.push(event(context, "response.function_call_arguments.delta", {
            item_id: slot.itemId,
            output_index: slot.outputIndex,
            delta: streamEvent.arguments
          }));
        }
        break;
      }
      case "role":
      case "finish":
      case "usage":
        break;
    }
  }

  return output;
}

function finishMessageEvents(
  context: ResponseContext,
  accumulator: ResponseAccumulator
): JsonRecord[] {
  if (context.messageOutputIndex < 0) return [];
  const output: JsonRecord[] = [];

  if (context.messagePartType === "refusal") {
    output.push(event(context, "response.refusal.done", {
      item_id: context.messageId,
      output_index: context.messageOutputIndex,
      content_index: 0,
      refusal: accumulator.refusal
    }));
  } else {
    output.push(event(context, "response.output_text.done", {
      item_id: context.messageId,
      output_index: context.messageOutputIndex,
      content_index: 0,
      text: accumulator.content,
      logprobs: []
    }));
  }

  const part = context.messagePartType === "refusal"
    ? { type: "refusal", refusal: accumulator.refusal }
    : { type: "output_text", text: accumulator.content, annotations: [] };
  output.push(event(context, "response.content_part.done", {
    item_id: context.messageId,
    output_index: context.messageOutputIndex,
    content_index: 0,
    part
  }));
  output.push(event(context, "response.output_item.done", {
    output_index: context.messageOutputIndex,
    item: outputMessage(accumulator, context)
  }));
  return output;
}

function finishReasoningEvents(
  context: ResponseContext,
  accumulator: ResponseAccumulator
): JsonRecord[] {
  if (context.reasoningOutputIndex < 0) return [];
  return [
    event(context, "response.reasoning_text.done", {
      item_id: context.reasoningId,
      output_index: context.reasoningOutputIndex,
      content_index: 0,
      text: accumulator.reasoning
    }),
    event(context, "response.content_part.done", {
      item_id: context.reasoningId,
      output_index: context.reasoningOutputIndex,
      content_index: 0,
      part: { type: "reasoning_text", text: accumulator.reasoning }
    }),
    event(context, "response.output_item.done", {
      output_index: context.reasoningOutputIndex,
      item: reasoningItem(accumulator, context)
    })
  ];
}

function finishFunctionCallEvents(
  context: ResponseContext,
  call: StreamToolCall
): JsonRecord[] {
  const slot = context.functionOutputs[String(call.index)];
  if (!slot) return [];
  return [
    event(context, "response.function_call_arguments.done", {
      item_id: slot.itemId,
      output_index: slot.outputIndex,
      arguments: call.arguments
    }),
    event(context, "response.output_item.done", {
      output_index: slot.outputIndex,
      item: callItem(context, call, "completed", call.arguments)
    })
  ];
}

export function responseFinishEvents(
  context: ResponseContext,
  accumulator: ResponseAccumulator
): JsonRecord[] {
  const output: JsonRecord[] = [];

  for (const call of accumulator.toolCalls) {
    if (!call) continue;
    output.push(...startFunctionCall(context, call));
  }
  if (
    context.messageOutputIndex < 0 &&
    accumulator.toolCalls.length === 0
  ) {
    output.push(...startMessage(context, "output_text"));
  }

  const closers: Array<{
    index: number;
    build: () => JsonRecord[];
  }> = [];
  if (context.messageOutputIndex >= 0) {
    closers.push({
      index: context.messageOutputIndex,
      build: () => finishMessageEvents(context, accumulator)
    });
  }
  if (context.reasoningOutputIndex >= 0) {
    closers.push({
      index: context.reasoningOutputIndex,
      build: () => finishReasoningEvents(context, accumulator)
    });
  }
  for (const call of accumulator.toolCalls) {
    if (!call) continue;
    const slot = context.functionOutputs[String(call.index)];
    if (slot) {
      closers.push({
        index: slot.outputIndex,
        build: () => finishFunctionCallEvents(context, call)
      });
    }
  }
  closers.sort((left, right) => left.index - right.index);
  for (const closer of closers) output.push(...closer.build());

  output.push(event(context, "response.completed", {
    response: accumulator.response(context)
  }));
  return output;
}

export function responseFailed(
  context: ResponseContext,
  message: string
): JsonRecord {
  return event(context, "response.failed", {
    response: responseObject(
      context,
      "failed",
      [],
      "",
      null,
      { code: "upstream_error", message }
    )
  });
}

export function rememberResponse(
  context: ResponseContext,
  request: NormalizedChatRequest,
  accumulator: ResponseAccumulator,
  store: ResponseStore,
  owner = "anonymous"
): void {
  if (request.response?.store === false) return;
  store.put(context.id, owner, {
    model: context.model,
    messages: [
      ...request.messages.map((message) => cloneJsonValue(message) as JsonRecord),
      cloneJsonValue(accumulator.assistantMessage()) as JsonRecord
    ],
    options: cloneJsonValue(request.options) as JsonRecord,
    response: cloneJsonValue(request.response ?? {}) as ResponseRequestOptions
  });
}
