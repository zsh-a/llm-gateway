import { ChatAccumulator } from "../chat.js";
import type { UpstreamChunk } from "../../providers/contracts.js";
import type { ResponseStore } from "../../infrastructure/response-store.js";
import { cloneJsonValue } from "../../infrastructure/response-store.js";
import type { StreamEvent, StreamToolCall } from "../../domain/events.js";
import type {
  JsonRecord,
  NormalizedChatRequest,
  OpenAIResponse,
  OpenAIResponseStreamEvent,
  ResponseRequestOptions
} from "../../domain/types.js";
import { responsesUsage } from "../../observability/usage.js";

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
