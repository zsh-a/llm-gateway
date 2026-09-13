import type { AppConfig } from "./config.js";
import type { AuthHeaders } from "./auth.js";
import type { NormalizedChatRequest } from "./types.js";
import { consumeSseJson } from "./sse.js";

export interface UpstreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  tool_calls?: unknown;
  function_call?: unknown;
  refusal?: string;
}

export interface UpstreamChoice {
  delta?: UpstreamDelta;
  finish_reason?: string | null;
}

export interface UpstreamChunk {
  id?: string;
  choices?: UpstreamChoice[];
}

export class UpstreamError extends Error {
  public status: number;
  public body: string;

  constructor(status: number, body: string) {
    super(`上游接口返回 HTTP ${status}: ${body}`);
    this.name = "UpstreamError";
    this.status = status;
    this.body = body;
  }
}

export async function streamChat(
  authHeaders: AuthHeaders,
  request: NormalizedChatRequest,
  config: AppConfig,
  onChunk: (chunk: UpstreamChunk) => void,
  externalSignal?: AbortSignal
): Promise<void> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  if (externalSignal) {
    const abort = (): void => controller.abort();
    externalSignal.addEventListener("abort", abort);
    removeAbortListener = (): void => {
      externalSignal.removeEventListener("abort", abort);
    };
    if (externalSignal.aborted) controller.abort();
  }

  if (config.requestTimeoutMs > 0) {
    timeoutId = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  }

  try {
    const response = await fetch(config.upstreamUrl, {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: request.model,
        messages: request.messages,
        stream: true,
        reasoning_effort: request.effort
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      throw new UpstreamError(response.status, await response.text().catch(() => ""));
    }

    await consumeSseJson<UpstreamChunk>(response, onChunk);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    if (removeAbortListener) removeAbortListener();
  }
}
