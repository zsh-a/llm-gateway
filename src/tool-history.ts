import type { JsonRecord } from "./types.js";

interface PendingToolCall {
  id: string;
  name: string;
}

interface NormalizedAssistant {
  message: JsonRecord;
  calls: PendingToolCall[];
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
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

function invalid(message: string): never {
  throw new Error("工具调用历史无效: " + message);
}

function normalizeToolCall(
  value: unknown,
  messageIndex: number,
  callIndex: number,
  fallbackId?: string
): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    invalid(`messages[${messageIndex}].tool_calls[${callIndex}] 必须是对象`);
  }

  const call = asRecord(value);
  const functionValue = asRecord(call.function);
  const id = stringValue(call.id) || stringValue(call.call_id) || fallbackId;
  const name = stringValue(functionValue.name);
  if (!id) {
    invalid(`messages[${messageIndex}].tool_calls[${callIndex}] 缺少 id`);
  }
  if (!name) {
    invalid(`messages[${messageIndex}].tool_calls[${callIndex}] 缺少 function.name`);
  }

  const normalized: JsonRecord = { ...call };
  delete normalized.call_id;
  normalized.id = id;
  normalized.type = stringValue(call.type) || "function";
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
  const legacyCall = message.function_call;

  if (modernCalls !== undefined && legacyCall !== undefined && legacyCall !== null) {
    invalid(`messages[${messageIndex}] 同时包含 tool_calls 和 function_call`);
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
      const id = stringValue(call.id);
      const functionValue = asRecord(call.function);
      if (ids.has(id)) {
        invalid(`messages[${messageIndex}] 重复的 tool_call id: ${id}`);
      }
      ids.add(id);
      return { id, name: stringValue(functionValue.name) };
    });
    return {
      message: { ...message, tool_calls: calls },
      calls: pending
    };
  }

  if (legacyCall !== undefined && legacyCall !== null) {
    const legacy = asRecord(legacyCall);
    const name = stringValue(legacy.name);
    if (!name) invalid(`messages[${messageIndex}].function_call 缺少 name`);
    const id = `legacy_call_${messageIndex}`;
    const call = normalizeToolCall(
      {
        id,
        type: "function",
        function: {
          name,
          arguments: legacy.arguments ?? {}
        }
      },
      messageIndex,
      0,
      id
    );
    const normalized = { ...message };
    delete normalized.function_call;
    normalized.tool_calls = [call];
    return {
      message: normalized,
      calls: [{ id, name }]
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

  const role = stringValue(message.role);
  if (role === "function") {
    const name = stringValue(message.name);
    const matches = name
      ? pending.filter((call) => call.name === name)
      : pending;
    if (matches.length !== 1) {
      invalid(
        `messages[${messageIndex}] 无法匹配旧式 function 结果` +
        (name ? `: ${name}` : "")
      );
    }

    const call = matches[0];
    const normalized: JsonRecord = {
      ...message,
      role: "tool",
      tool_call_id: call.id
    };
    delete normalized.name;
    return { message: normalized, call };
  }

  const id = stringValue(message.tool_call_id) || stringValue(message.call_id);
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
  delete normalized.call_id;
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
export function normalizeToolHistory(messages: unknown[]): unknown[] {
  const normalized: unknown[] = [];
  let pending: PendingToolCall[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const value = messages[index];
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      invalid(`messages[${index}] 必须是对象`);
    }

    const message = asRecord(value);
    const role = stringValue(message.role);

    if (role === "assistant") {
      requireToolResults(index, pending);
      const result = normalizeAssistant(message, index);
      normalized.push(result.message);
      pending = result.calls;
      continue;
    }

    if (role === "tool" || role === "function") {
      const result = normalizeToolResult(message, index, pending);
      normalized.push(result.message);
      pending = pending.filter((call) => call.id !== result.call.id);
      continue;
    }

    requireToolResults(index, pending);
    normalized.push(value);
  }

  requireToolResults(messages.length, pending);
  return normalized;
}
