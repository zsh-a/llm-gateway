import type { ChatCompletion, ChatCompletionChunk } from "openai/resources/chat/completions";
import type { Response, ResponseStreamEvent } from "openai/resources/responses/responses";
import type { ReasoningEffort } from "./config.js";

export type JsonRecord = { [key: string]: unknown };
export type ReasoningEfforts = { [key: string]: string | null };

// Keep the wire serializers anchored to the official OpenAI schema without
// importing the SDK at runtime. The gateway still intentionally keeps a small
// JsonRecord boundary because provider extensions such as reasoning_content
// are not part of every OpenAI schema version.
export type OpenAIChatCompletion = ChatCompletion;
export type OpenAIChatCompletionChunk = ChatCompletionChunk;
export type OpenAIResponse = Response;
export type OpenAIResponseStreamEvent = ResponseStreamEvent;

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
  reasoningEfforts?: ReasoningEfforts;
  defaultReasoningEffort?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export interface ResponseRequestOptions {
  instructions?: unknown;
  text?: JsonRecord;
  previousResponseId?: string | null;
  metadata?: JsonRecord | null;
  store?: boolean;
  parallelToolCalls?: boolean;
  temperature?: number | null;
  topP?: number | null;
  toolChoice?: unknown;
  tools?: unknown[];
  truncation?: string | null;
  maxOutputTokens?: number | null;
  reasoning?: JsonRecord | null;
}

export interface NormalizedChatRequest {
  model: string;
  messages: unknown[];
  stream: boolean;
  effort: ReasoningEffort;
  reasoningEffortExplicit: boolean;
  options: JsonRecord;
  response?: ResponseRequestOptions;
}
