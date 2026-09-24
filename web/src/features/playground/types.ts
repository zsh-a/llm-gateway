import type { GatewayModel, Usage } from "../../types";

export type PlaygroundRequest = {
  model: GatewayModel;
  prompt: string;
  effort: string;
  maxOutputTokens?: number;
};
export type PlaygroundResponse = {
  state: "idle" | "streaming" | "success" | "incomplete" | "error" | "canceled";
  content: string;
  reasoning: string;
  usage?: Usage;
  error: string;
  request?: PlaygroundRequest;
  requestId?: string;
  finishReason?: string;
  startedAt?: number;
  durationMs?: number;
  firstTokenMs?: number;
};
