import type { ReasoningEffort } from "./config.js";

export type JsonRecord = { [key: string]: unknown };

export interface ModelCapabilities {
  chat?: boolean;
  toolCalling?: boolean;
  images?: boolean;
  reasoning?: boolean;
}

export interface ModelDescriptor {
  id: string;
  providerId?: string;
  publicId?: string;
  name?: string;
  ownedBy?: string;
  capabilities?: ModelCapabilities;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface NormalizedChatRequest {
  model: string;
  messages: unknown[];
  stream: boolean;
  effort: ReasoningEffort;
  options: JsonRecord;
}
