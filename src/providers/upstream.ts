import type { AuthStore } from "../auth/auth-store.js";
import type { ChannelConfig } from "../routing/channels.js";
import type { GatewayConfig } from "../app/config.js";
import type { ModelRoute } from "../routing/model-router.js";
import {
  UpstreamError,
  UpstreamNetworkError,
  UpstreamStreamError,
  type UpstreamChunk,
  type UpstreamStreamResult
} from "./contracts.js";
import type { NormalizedChatRequest } from "../domain/types.js";

export class UpstreamTimeoutError extends Error {
  public readonly status = 504;

  constructor(message = "上游请求超时") {
    super(message);
    this.name = "UpstreamTimeoutError";
  }
}

export class UpstreamCanceledError extends Error {
  public readonly status = 499;

  constructor(message = "请求已取消") {
    super(message);
    this.name = "UpstreamCanceledError";
  }
}

export interface UpstreamDeps {
  authStore: AuthStore;
  config: GatewayConfig;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError" ||
    error instanceof Error && error.name === "AbortError";
}

function retryableFailure(error: unknown): boolean {
  if (error instanceof UpstreamNetworkError || error instanceof UpstreamStreamError) {
    return true;
  }
  if (!(error instanceof UpstreamError)) return false;
  return error.status === 401 || error.status === 403 ||
    error.status === 408 || error.status === 409 || error.status === 429 ||
    error.status >= 500;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve(true);
    }, milliseconds);
    const abort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(false);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

/** Execute a routed request with a single total deadline and typed failover rules. */
export async function streamUpstream(
  deps: UpstreamDeps,
  route: ModelRoute,
  request: NormalizedChatRequest,
  onChunk: (chunk: UpstreamChunk) => void,
  externalSignal: AbortSignal | undefined,
  onChannel: (channel: ChannelConfig) => void
): Promise<{ channel: ChannelConfig; stream: UpstreamStreamResult }> {
  const { authStore, config } = deps;
  const controller = new AbortController();
  const deadline = config.requestTimeoutMs > 0
    ? Date.now() + config.requestTimeoutMs
    : null;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const abortFromClient = (): void => controller.abort();
  externalSignal?.addEventListener("abort", abortFromClient);
  if (externalSignal?.aborted) controller.abort();
  if (deadline !== null) {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, Math.max(1, deadline - Date.now()));
  }

  let lastError: unknown = null;
  try {
    for (let index = 0; index < route.candidates.length; index += 1) {
      const candidate = route.candidates[index];
      if (externalSignal?.aborted) throw new UpstreamCanceledError();
      if (timedOut) throw new UpstreamTimeoutError();

      const snapshot = authStore.get(candidate.channel.authRef);
      if (!snapshot) {
        lastError = new UpstreamError(
          503,
          "未找到渠道 " + candidate.channel.id + " 的认证缓存"
        );
        continue;
      }

      let emitted = false;
      onChannel(candidate.channel);
      try {
        const remaining = deadline === null
          ? 0
          : Math.max(1, deadline - Date.now());
        const attemptConfig = deadline === null
          ? config
          : { ...config, requestTimeoutMs: remaining };
        const stream = await route.provider.streamChat(
          snapshot.headers,
          { ...request, model: candidate.upstreamModel },
          attemptConfig,
          (chunk) => {
            if (chunk.choices && chunk.choices.length > 0) emitted = true;
            onChunk(chunk);
          },
          controller.signal,
          candidate.channel
        );
        if (!stream.sawDone && !stream.sawFinish) {
          throw new UpstreamStreamError();
        }
        return { channel: candidate.channel, stream };
      } catch (error) {
        if (externalSignal?.aborted) throw new UpstreamCanceledError();
        if (timedOut || (deadline !== null && Date.now() >= deadline)) {
          throw new UpstreamTimeoutError();
        }
        if (isAbortError(error)) {
          throw new UpstreamTimeoutError();
        }

        lastError = error;
        if (
          error instanceof UpstreamError &&
          (error.status === 401 || error.status === 403)
        ) {
          authStore.invalidate(candidate.channel.authRef);
        }
        if (
          emitted ||
          index === route.candidates.length - 1 ||
          !retryableFailure(error)
        ) {
          throw error;
        }

        const remaining = deadline === null ? 200 : deadline - Date.now();
        if (remaining <= 0) throw new UpstreamTimeoutError();
        const waited = await delay(
          Math.min(100 * 2 ** index, 500, remaining),
          controller.signal
        );
        if (!waited) {
          if (externalSignal?.aborted) throw new UpstreamCanceledError();
          throw new UpstreamTimeoutError();
        }
      }
    }
    throw lastError ?? new Error("没有可用的上游渠道");
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    externalSignal?.removeEventListener("abort", abortFromClient);
  }
}
