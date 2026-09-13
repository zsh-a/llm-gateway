import type { ReasoningEffort } from "./config.js";

export type JsonRecord = { [key: string]: unknown };

export interface NormalizedChatRequest {
  model: string;
  messages: unknown[];
  stream: boolean;
  effort: ReasoningEffort;
}
