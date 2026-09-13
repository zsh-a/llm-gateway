import { ChatAccumulator, normalizeChatRequest } from "./openai.js";
import type { UpstreamChunk } from "./provider.js";
import type { JsonRecord, NormalizedChatRequest } from "./types.js";

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
    return JSON.stringify(value);
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

export function normalizeResponseRequest(
  value: unknown,
  defaultModel = ""
): NormalizedChatRequest {
  const body = asRecord(value);
  const messages: unknown[] = [];

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

  return normalizeChatRequest(normalized, defaultModel);
}

export interface ResponseContext {
  id: string;
  created: number;
  model: string;
  messageId: string;
  reasoningId: string;
  sequence: number;
}

export function createResponseContext(model: string): ResponseContext {
  const token = Date.now().toString(36);
  return {
    id: "resp_" + token,
    created: Math.floor(Date.now() / 1000),
    model,
    messageId: "msg_" + token,
    reasoningId: "rs_" + token,
    sequence: 0
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
  context: ResponseContext
): JsonRecord {
  const message: JsonRecord = {
    id: context.messageId,
    type: "message",
    status: "completed",
    role: "assistant",
    content: [
      {
        type: "output_text",
        text: accumulator.content,
        annotations: []
      }
    ]
  };
  if (accumulator.reasoning) {
    message.reasoning_content = accumulator.reasoning;
  }
  return message;
}

function functionOutputs(
  accumulator: ResponseAccumulator,
  context: ResponseContext
): JsonRecord[] {
  return accumulator.toolCalls.map((value, index) => {
    const call = asRecord(value);
    const functionValue = asRecord(call.function);
    const callId = stringValue(call.id) ||
      context.messageId + "_call_" + String(index);
    return {
      id: callId,
      type: "function_call",
      status: "completed",
      call_id: callId,
      name: stringValue(functionValue.name),
      arguments: stringValue(functionValue.arguments) || "{}"
    };
  });
}

function outputItems(
  accumulator: ResponseAccumulator,
  context: ResponseContext
): JsonRecord[] {
  const output: JsonRecord[] = [];
  if (accumulator.content || accumulator.toolCalls.length === 0) {
    output.push(outputMessage(accumulator, context));
  }
  output.push(...functionOutputs(accumulator, context));
  return output;
}

function responseObject(
  context: ResponseContext,
  status: string,
  output: JsonRecord[],
  outputText: string,
  usage: JsonRecord | null,
  error: JsonRecord | null = null
): JsonRecord {
  return {
    id: context.id,
    object: "response",
    created_at: context.created,
    status,
    completed_at: status === "in_progress" ? null : Math.floor(Date.now() / 1000),
    error,
    incomplete_details: status === "incomplete"
      ? { reason: "max_output_tokens" }
      : null,
    model: context.model,
    output,
    output_text: outputText,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: 1,
    text: { format: { type: "text" } },
    tool_choice: "auto",
    tools: [],
    top_p: 1,
    truncation: "disabled",
    usage
  };
}

export class ResponseAccumulator {
  private readonly chat = new ChatAccumulator();

  get content(): string {
    return this.chat.content;
  }

  get reasoning(): string {
    return this.chat.reasoning;
  }

  get toolCalls(): JsonRecord[] {
    return this.chat.toolCalls;
  }

  get finishReason(): string {
    return this.chat.finishReason;
  }

  add(chunk: UpstreamChunk): void {
    this.chat.add(chunk);
  }

  response(context: ResponseContext): JsonRecord {
    const output = outputItems(this, context);
    const result = responseObject(
      context,
      this.finishReason === "length" ? "incomplete" : "completed",
      output,
      this.content,
      responseUsage(this.chat.usage)
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
  return {
    type,
    ...value,
    sequence_number: context.sequence
  };
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

export function responseOutputItemAdded(context: ResponseContext): JsonRecord {
  return event(context, "response.output_item.added", {
    output_index: 0,
    item: {
      id: context.messageId,
      type: "message",
      status: "in_progress",
      role: "assistant",
      content: []
    }
  });
}

export function responseContentPartAdded(context: ResponseContext): JsonRecord {
  return event(context, "response.content_part.added", {
    item_id: context.messageId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] }
  });
}

export function responseChunkEvents(
  chunk: UpstreamChunk,
  context: ResponseContext,
  accumulator: ResponseAccumulator
): JsonRecord[] {
  accumulator.add(chunk);
  const delta = chunk.choices?.[0]?.delta;
  if (!delta) return [];

  const events: JsonRecord[] = [];
  if (delta.reasoning_content) {
    events.push(event(context, "response.reasoning_summary_text.delta", {
      item_id: context.reasoningId,
      delta: delta.reasoning_content
    }));
  }
  if (delta.content) {
    events.push(event(context, "response.output_text.delta", {
      item_id: context.messageId,
      output_index: 0,
      content_index: 0,
      delta: delta.content,
      logprobs: []
    }));
  }
  if (delta.refusal) {
    events.push(event(context, "response.refusal.delta", {
      item_id: context.messageId,
      output_index: 0,
      content_index: 0,
      delta: delta.refusal
    }));
  }
  return events;
}

export function responseFinishEvents(
  context: ResponseContext,
  accumulator: ResponseAccumulator
): JsonRecord[] {
  const events: JsonRecord[] = [
    event(context, "response.output_text.done", {
      item_id: context.messageId,
      output_index: 0,
      content_index: 0,
      text: accumulator.content,
      logprobs: []
    }),
    event(context, "response.content_part.done", {
      item_id: context.messageId,
      output_index: 0,
      content_index: 0,
      part: {
        type: "output_text",
        text: accumulator.content,
        annotations: []
      }
    }),
    event(context, "response.output_item.done", {
      output_index: 0,
      item: outputMessage(accumulator, context)
    })
  ];

  if (accumulator.reasoning) {
    events.push(event(context, "response.reasoning_summary_text.done", {
      item_id: context.reasoningId,
      summary_index: 0,
      text: accumulator.reasoning
    }));
  }
  events.push(event(context, "response.completed", {
    response: accumulator.response(context)
  }));
  return events;
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
