import { ChatAccumulator, normalizeChatRequest } from "../chat.js";
import {
  asNumber,
  asRecord,
  asString,
  asTrimmedString,
  serializedValue
} from "../../domain/json.js";
import type { ResponseStore } from "../../infrastructure/response-store.js";
import { cloneJsonValue } from "../../infrastructure/response-store.js";
import type {
  JsonRecord,
  NormalizedChatRequest,
  ResponseRequestOptions
} from "../../domain/types.js";

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

