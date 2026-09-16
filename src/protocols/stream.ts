import type { UpstreamChunk } from "../providers/contracts.js";
import { asRecord, asString, serializedValue } from "../domain/json.js";
import type { StreamEvent, StreamToolCall } from "../domain/events.js";
import type { JsonRecord } from "../domain/types.js";

export type { StreamEvent, StreamToolCall } from "../domain/events.js";

function indexValue(value: unknown, fallback: number): number {
  const index = Number(value);
  return Number.isInteger(index) && index >= 0 ? index : fallback;
}

function toolCallEvents(value: unknown): StreamEvent[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item, itemIndex) => {
    const incoming = asRecord(item);
    const functionValue = asRecord(incoming.function);
    const rawArguments = functionValue.arguments;
    const argumentsValue = rawArguments === undefined
      ? undefined
      : typeof rawArguments === "string"
        ? rawArguments
        : serializedValue(rawArguments);

    return {
      type: "tool_call",
      index: indexValue(incoming.index, itemIndex),
      id: asString(incoming.id),
      callId: asString(incoming.call_id),
      toolType: asString(incoming.type),
      name: asString(functionValue.name),
      arguments: argumentsValue
    };
  });
}

/** Convert provider-specific Chat Completions chunks into a small protocol IR. */
export function toStreamEvents(chunk: UpstreamChunk): StreamEvent[] {
  const choice = chunk.choices?.[0];
  const delta = choice?.delta;
  const events: StreamEvent[] = [];

  if (delta?.role) events.push({ type: "role", role: delta.role });
  const reasoningText = delta?.reasoning_content ?? delta?.reasoning ?? delta?.thinking;
  if (typeof reasoningText === "string" && reasoningText) {
    events.push({ type: "reasoning", text: reasoningText });
  }
  if (typeof delta?.content === "string" && delta.content) {
    events.push({ type: "text", text: delta.content });
  }
  if (typeof delta?.refusal === "string" && delta.refusal) {
    events.push({ type: "refusal", text: delta.refusal });
  }

  if (delta?.tool_calls !== undefined && delta.tool_calls !== null) {
    events.push(...toolCallEvents(delta.tool_calls));
  }

  if (choice?.finish_reason) {
    events.push({ type: "finish", reason: choice.finish_reason });
  }
  if (chunk.usage !== undefined && chunk.usage !== null) {
    events.push({ type: "usage", usage: chunk.usage });
  }

  return events;
}

export class StreamAccumulator {
  public role = "";
  public reasoning = "";
  public content = "";
  public refusal = "";
  public usage: JsonRecord | null = null;
  public readonly toolCalls: StreamToolCall[] = [];

  private finishReasonValue: string | null = null;

  get finishReason(): string {
    return this.finishReasonValue ?? (this.toolCalls.length > 0 ? "tool_calls" : "stop");
  }

  get finishSeen(): boolean {
    return this.finishReasonValue !== null;
  }

  add(chunk: UpstreamChunk): StreamEvent[] {
    const events = toStreamEvents(chunk);
    this.addEvents(events);
    return events;
  }

  addEvents(events: StreamEvent[]): void {
    for (const event of events) {
      switch (event.type) {
        case "role":
          this.role = event.role;
          break;
        case "text":
          this.content += event.text;
          break;
        case "reasoning":
          this.reasoning += event.text;
          break;
        case "refusal":
          this.refusal += event.text;
          break;
        case "tool_call":
          this.mergeToolCall(event);
          break;
        case "finish":
          this.finishReasonValue = event.reason;
          break;
        case "usage":
          this.usage = event.usage;
          break;
      }
    }
  }

  private mergeToolCall(event: Extract<StreamEvent, { type: "tool_call" }>): void {
    const current = this.toolCalls[event.index] ?? {
      index: event.index,
      type: "function",
      name: "",
      arguments: ""
    };

    if (event.id !== undefined) current.id = event.id;
    if (event.callId !== undefined) current.callId = event.callId;
    if (event.toolType) current.type = event.toolType;
    if (event.name !== undefined) current.name = event.name;
    if (event.arguments !== undefined) current.arguments += event.arguments;

    this.toolCalls[event.index] = current;
  }
}
