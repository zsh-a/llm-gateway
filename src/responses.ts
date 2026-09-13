import { ChatAccumulator, normalizeChatRequest } from "./openai.js";
import type { UpstreamChunk } from "./provider.js";
import type { StreamEvent, StreamToolCall } from "./stream.js";
import type {
  JsonRecord,
  NormalizedChatRequest,
  OpenAIResponse,
  OpenAIResponseStreamEvent,
  ResponseRequestOptions
} from "./types.js";

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object"
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function serializedValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

function roleValue(value: unknown, fallback: string): string {
  const role = stringValue(value);
  return ["system", "developer", "user", "assistant", "tool"].includes(role)
    ? role
    : fallback;
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
    const type = stringValue(record.type);

    if (type === "input_text" || type === "output_text" || type === "text") {
      const text = typeof record.text === "string" ? record.text : "";
      if (text) parts.push(text);
      continue;
    }

    if (type === "input_image") {
      const imageUrl = stringValue(record.image_url);
      if (imageUrl) {
        const image: JsonRecord = { url: imageUrl };
        if (record.detail !== undefined) image.detail = record.detail;
        parts.push({ type: "image_url", image_url: image });
      }
      textOnly = false;
      continue;
    }

    if (type === "input_file") {
      const fileId = stringValue(record.file_id);
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
  const type = stringValue(item.type);
  if (type === "reasoning" || type === "item_reference") return null;

  if (type === "function_call_output") {
    const message: JsonRecord = {
      role: "tool",
      content: serializedValue(item.output ?? "")
    };
    const callId = stringValue(item.call_id) || stringValue(item.id);
    if (callId) message.tool_call_id = callId;
    return message;
  }

  if (type === "function_call") {
    const callId = stringValue(item.call_id) || stringValue(item.id);
    const functionCall: JsonRecord = {
      id: callId,
      type: "function",
      function: {
        name: stringValue(item.name),
        arguments: serializedValue(item.arguments ?? "{}")
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
    const message: JsonRecord = {
      role: roleValue(item.role, fallbackRole),
      content: item.content !== undefined
        ? chatContent(item.content)
        : stringValue(item.text)
    };
    if (item.name !== undefined) message.name = item.name;
    return message;
  }

  return null;
}

function inputMessages(value: unknown, fallbackRole: string): unknown[] {
  const values = Array.isArray(value) ? value : [value];
  const messages: unknown[] = [];
  for (const item of values) {
    const message = inputItemToMessage(item, fallbackRole);
    if (message) messages.push(message);
  }
  return messages;
}

function responseTools(value: unknown): unknown {
  if (!Array.isArray(value)) return value;

  return value.map((item) => {
    const tool = asRecord(item);
    if (
      stringValue(tool.type) !== "function" ||
      tool.function !== undefined ||
      !stringValue(tool.name)
    ) {
      return item;
    }

    const functionValue: JsonRecord = {
      name: stringValue(tool.name),
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
    stringValue(choice.type) === "function" &&
    choice.function === undefined &&
    stringValue(choice.name)
  ) {
    return {
      type: "function",
      function: { name: stringValue(choice.name) }
    };
  }
  return value;
}

function responseFormat(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  const format = asRecord(value);
  const type = stringValue(format.type);

  if (type === "text") return undefined;
  if (type === "json_object") return { type: "json_object" };
  if (type === "json_schema") {
    const name = stringValue(format.name);
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

interface StoredResponse {
  messages: JsonRecord[];
}

const responseHistory = new Map<string, StoredResponse>();
const MAX_RESPONSE_HISTORY = 128;

function previousMessages(id: string): JsonRecord[] | null {
  const stored = responseHistory.get(id);
  if (!stored) return null;
  responseHistory.delete(id);
  responseHistory.set(id, stored);
  return stored.messages.map((message) => ({ ...message }));
}

function responseRequestOptions(body: JsonRecord): ResponseRequestOptions {
  const options: ResponseRequestOptions = {};

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
    const id = stringValue(body.previous_response_id);
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
  if (body.temperature !== undefined) options.temperature = body.temperature as number;
  if (body.top_p !== undefined) options.topP = body.top_p as number;
  if (body.tool_choice !== undefined) options.toolChoice = body.tool_choice;
  if (Array.isArray(body.tools)) options.tools = body.tools;
  if (body.truncation !== undefined) options.truncation = body.truncation as string;
  if (body.max_output_tokens !== undefined) {
    options.maxOutputTokens = body.max_output_tokens as number;
  }
  if (body.reasoning !== undefined) {
    options.reasoning = body.reasoning === null ? null : asRecord(body.reasoning);
  }

  return options;
}

export function normalizeResponseRequest(
  value: unknown,
  defaultModel = ""
): NormalizedChatRequest {
  const body = asRecord(value);
  const response = responseRequestOptions(body);
  const messages: unknown[] = [];

  if (response.previousResponseId) {
    const previous = previousMessages(response.previousResponseId);
    if (!previous) {
      throw new Error("previous_response_id 不存在或已过期；网关只在当前进程内保存 Responses 会话");
    }
    messages.push(...previous);
  }
  if (body.instructions !== undefined) {
    messages.push(...inputMessages(body.instructions, "system"));
  }
  if (body.input !== undefined) {
    messages.push(...inputMessages(body.input, "user"));
  }

  const normalized: JsonRecord = {
    ...body,
    messages
  };

  const reasoning = asRecord(body.reasoning);
  if (reasoning.effort !== undefined) {
    normalized.reasoning_effort = reasoning.effort;
  }
  if (
    body.max_output_tokens !== undefined &&
    body.max_completion_tokens === undefined &&
    body.max_tokens === undefined
  ) {
    normalized.max_completion_tokens = body.max_output_tokens;
  }
  if (body.tools !== undefined) normalized.tools = responseTools(body.tools);
  if (body.tool_choice !== undefined) {
    normalized.tool_choice = responseToolChoice(body.tool_choice);
  }

  if (body.text !== undefined && body.text !== null) {
    const text = asRecord(body.text);
    const format = responseFormat(text.format);
    if (format !== undefined) normalized.response_format = format;
  }

  return {
    ...normalizeChatRequest(normalized, defaultModel),
    response
  };
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

function responseUsage(value: JsonRecord | null): JsonRecord | null {
  if (!value) return null;

  const usage: JsonRecord = { ...value };
  const inputTokens = usage.input_tokens ?? usage.prompt_tokens;
  const outputTokens = usage.output_tokens ?? usage.completion_tokens;
  const totalTokens = usage.total_tokens ??
    (typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : undefined);

  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  if (totalTokens !== undefined) usage.total_tokens = totalTokens;
  delete usage.prompt_tokens;
  delete usage.completion_tokens;
  return usage;
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
    store: options.store ?? false,
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
      responseUsage(this.usage)
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
  accumulator: ResponseAccumulator
): void {
  responseHistory.delete(context.id);
  responseHistory.set(context.id, {
    messages: [accumulator.assistantMessage()]
  });
  while (responseHistory.size > MAX_RESPONSE_HISTORY) {
    const first = responseHistory.keys().next().value;
    if (first === undefined) break;
    responseHistory.delete(first);
  }
}
