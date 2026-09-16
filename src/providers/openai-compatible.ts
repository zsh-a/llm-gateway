import type { AuthHeaders } from "../auth/auth-store.js";
import type { GatewayConfig } from "../app/config.js";
import { asRecord } from "../domain/json.js";
import { consumeSseJson } from "../protocols/sse.js";
import type {
  JsonRecord,
  ModelDescriptor,
  NormalizedChatRequest
} from "../domain/types.js";
import {
  UpstreamError,
  UpstreamNetworkError,
  UpstreamStreamError,
  type ProviderAdapter,
  type ProviderChannel,
  type ProviderId,
  type UpstreamChunk,
  type UpstreamStreamResult
} from "./contracts.js";

type RequestBodyBuilder = (
  request: NormalizedChatRequest
) => JsonRecord;

interface OpenAICompatibleProviderOptions {
  id: ProviderId;
  name: string;
  upstreamUrl: string;
  modelListUrl: string;
  modelFile: string;
  fallbackModelIds: string[];
  authHosts: string[];
  authPaths: string[];
  authMethods: string[];
  captureHeaders: string[];
  clientCandidates: string[];
  discoverModels?: (
    authHeaders: AuthHeaders,
    config: GatewayConfig,
    signal?: AbortSignal
  ) => Promise<ModelDescriptor[]>;
  buildBody: RequestBodyBuilder;
  describeModel?: (model: ModelDescriptor) => ModelDescriptor;
}

function upstreamMessages(messages: JsonRecord[]): JsonRecord[] {
  return messages.map((value) => {
    const message = asRecord(value);
    if (message.role !== "developer") return value;
    // DeepSeek/WorkBuddy endpoints generally accept `system` but
    // reject the OpenAI reasoning-model `developer` role. Harness uses the
    // latter for system prompts once reasoning is enabled, so normalize it at
    // this single provider boundary.
    return { ...message, role: "system" };
  });
}

export function baseRequestBody(request: NormalizedChatRequest): JsonRecord {
  const body: JsonRecord = { ...request.options };
  body.model = request.model;
  body.messages = upstreamMessages(request.messages);
  body.stream = true;
  return body;
}

export class OpenAICompatibleProvider implements ProviderAdapter {
  public readonly id: ProviderId;
  public readonly name: string;
  public readonly upstreamUrl: string;
  public readonly modelListUrl: string;
  public readonly modelFile: string;
  public readonly fallbackModelIds: string[];
  public readonly authHosts: string[];
  public readonly authPaths: string[];
  public readonly authMethods: string[];
  public readonly captureHeaders: string[];
  public readonly clientCandidates: string[];
  public readonly discoverModels?: (
    authHeaders: AuthHeaders,
    config: GatewayConfig
  ) => Promise<ModelDescriptor[]>;
  public readonly describeModel?: (model: ModelDescriptor) => ModelDescriptor;
  private readonly buildBody: RequestBodyBuilder;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.id = options.id;
    this.name = options.name;
    this.upstreamUrl = options.upstreamUrl;
    this.modelListUrl = options.modelListUrl;
    this.modelFile = options.modelFile;
    this.fallbackModelIds = options.fallbackModelIds;
    this.authHosts = options.authHosts;
    this.authPaths = options.authPaths;
    this.authMethods = options.authMethods;
    this.captureHeaders = options.captureHeaders;
    this.clientCandidates = options.clientCandidates;
    this.discoverModels = options.discoverModels;
    this.buildBody = options.buildBody;
    this.describeModel = options.describeModel;
  }

  async streamChat(
    authHeaders: AuthHeaders,
    request: NormalizedChatRequest,
    config: GatewayConfig,
    onChunk: (chunk: UpstreamChunk) => void,
    externalSignal?: AbortSignal,
    channel?: ProviderChannel
  ): Promise<UpstreamStreamResult> {
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
      let response: Response;
      try {
        response = await fetch(channel?.upstreamUrl ?? this.upstreamUrl, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(this.buildBody(request)),
          signal: controller.signal
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new UpstreamNetworkError(message);
      }

      if (!response.ok) {
        throw new UpstreamError(response.status, await response.text().catch(() => ""));
      }

      let sawFinish = false;
      const result = await consumeSseJson<UpstreamChunk>(response, (chunk) => {
        if (chunk.choices?.some((choice) => (
          typeof choice.finish_reason === "string" && choice.finish_reason.length > 0
        ))) {
          sawFinish = true;
        }
        onChunk(chunk);
      });

      if (!result.sawDone && !sawFinish) {
        throw new UpstreamStreamError(
          `上游 SSE 在收到终止事件前关闭（已收到 ${result.eventCount} 个事件）`
        );
      }

      return { ...result, sawFinish };
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      if (removeAbortListener) removeAbortListener();
    }
  }
}
