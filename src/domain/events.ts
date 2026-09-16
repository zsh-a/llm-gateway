import type { JsonRecord } from "./types.js";

/** Provider-neutral output events consumed by all public protocol renderers. */
export interface StreamToolCall {
  index: number;
  id?: string;
  callId?: string;
  type: string;
  name: string;
  arguments: string;
}

export type StreamEvent =
  | { type: "role"; role: string }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "refusal"; text: string }
  | {
      type: "tool_call";
      index: number;
      id?: string;
      callId?: string;
      toolType?: string;
      name?: string;
      arguments?: string;
    }
  | { type: "finish"; reason: string }
  | { type: "usage"; usage: JsonRecord };

