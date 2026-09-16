import type { JsonRecord } from "./types.js";
import { asRecord, asTrimmedString, serializedValue } from "./json.js";

interface PendingToolCall {
  id: string;
  name: string;
}

interface NormalizedAssistant {
  message: JsonRecord;
  calls: PendingToolCall[];
}

function invalid(message: string): never {
  throw new Error("工具调用历史无效: " + message);
}

function normalizeToolCall(
  value: unknown,
  messageIndex: number,
  callIndex: number
): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`messages[${messageIndex}].tool_calls[${callIndex}] 必须是对象`);
  }

  const call = asRecord(value);
  const functionValue = asRecord(call.function);
  if (call.call_id !== undefined) {
    invalid(`messages[${messageIndex}].tool_calls[${callIndex}] 只支持 id`);
  }
  const id = asTrimmedString(call.id);
  const name = asTrimmedString(functionValue.name) ?? "";
  if (!id) {
    invalid(`messages[${messageIndex}].tool_calls[${callIndex}] 缺少 id`);
  }
  if (!name) {
    invalid(`messages[${messageIndex}].tool_calls[${callIndex}] 缺少 function.name`);
  }

  const normalized: JsonRecord = { ...call };
  normalized.id = id;
  normalized.type = asTrimmedString(call.type) || "function";
  normalized.function = {
    ...functionValue,
    name,
    arguments: serializedValue(functionValue.arguments ?? {})
  };
  return normalized;
}

function normalizeAssistant(
  message: JsonRecord,
  messageIndex: number
): NormalizedAssistant {
  const modernCalls = message.tool_calls;
  if (message.function_call !== undefined) {
    invalid(`messages[${messageIndex}] assistant 消息只支持 tool_calls`);
  }

  if (modernCalls !== undefined) {
    if (!Array.isArray(modernCalls)) {
      invalid(`messages[${messageIndex}].tool_calls 必须是数组`);
    }

    const calls = modernCalls.map((value, callIndex) => (
      normalizeToolCall(value, messageIndex, callIndex)
    ));
    const ids = new Set<string>();
    const pending = calls.map((call) => {
      const id = asTrimmedString(call.id) ?? "";
      const functionValue = asRecord(call.function);
      if (ids.has(id)) {
        invalid(`messages[${messageIndex}] 重复的 tool_call id: ${id}`);
      }
      ids.add(id);
      return { id, name: asTrimmedString(functionValue.name) ?? "" };
    });
    return {
      message: { ...message, tool_calls: calls },
      calls: pending
    };
  }

  return { message, calls: [] };
}

function pendingDescription(pending: PendingToolCall[]): string {
  return pending.map((call) => `${call.id} (${call.name})`).join(", ");
}

function normalizeToolResult(
  message: JsonRecord,
  messageIndex: number,
  pending: PendingToolCall[]
): { message: JsonRecord; call: PendingToolCall } {
  if (pending.length === 0) {
    invalid(`messages[${messageIndex}] 存在孤立的工具结果`);
  }

  const role = asTrimmedString(message.role) ?? "";
  if (role === "function") {
    invalid(`messages[${messageIndex}] 工具结果必须使用 role=tool`);
  }

  if (message.call_id !== undefined) {
    invalid(`messages[${messageIndex}] 工具结果只支持 tool_call_id`);
  }
  const id = asTrimmedString(message.tool_call_id);
  if (!id) {
    invalid(`messages[${messageIndex}] 工具结果缺少 tool_call_id`);
  }
  const call = pending.find((item) => item.id === id);
  if (!call) {
    invalid(
      `messages[${messageIndex}] 的 tool_call_id=${id} ` +
      "未匹配到前一个 assistant.tool_calls"
    );
  }

  const normalized: JsonRecord = {
    ...message,
    role: "tool",
    tool_call_id: id
  };
  return { message: normalized, call };
}

function requireToolResults(
  messageIndex: number,
  pending: PendingToolCall[]
): void {
  if (pending.length > 0) {
    invalid(
      `messages[${messageIndex}] 之前的工具调用缺少结果: ` +
      pendingDescription(pending)
    );
  }
}

/**
 * Convert tool history to one canonical Chat Completions shape and verify that
 * every assistant tool call has exactly one matching result before another
 * conversation message is accepted.
 */
export function normalizeToolHistory(messages: unknown[]): JsonRecord[] {
  const normalized: JsonRecord[] = [];
  let pending: PendingToolCall[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const value = messages[index];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      invalid(`messages[${index}] 必须是对象`);
    }

    const message = asRecord(value);
    const role = asTrimmedString(message.role) ?? "";

    if (role === "assistant") {
      requireToolResults(index, pending);
      const result = normalizeAssistant(message, index);
      normalized.push(result.message);
      pending = result.calls;
      continue;
    }

    if (role === "function") {
      invalid(`messages[${index}] 工具结果必须使用 role=tool`);
    }

    if (role === "tool") {
      const result = normalizeToolResult(message, index, pending);
      normalized.push(result.message);
      pending = pending.filter((call) => call.id !== result.call.id);
      continue;
    }

    requireToolResults(index, pending);
    normalized.push(message);
  }

  requireToolResults(messages.length, pending);
  return normalized;
}
