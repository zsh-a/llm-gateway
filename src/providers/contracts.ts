import type { AuthHeaders } from "../auth/auth-store.js";
import type { GatewayConfig } from "../app/config.js";
import type {
  JsonRecord,
  ModelDescriptor,
  NormalizedChatRequest
} from "../domain/types.js";

export type ProviderId = string;

export interface UpstreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
  tool_calls?: unknown;
  refusal?: string | null;
}

export interface UpstreamChoice {
  delta?: UpstreamDelta;
  finish_reason?: string | null;
}

export interface UpstreamChunk {
  id?: string;
  choices?: UpstreamChoice[];
  usage?: JsonRecord | null;
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

export class UpstreamStreamError extends Error {
  public readonly status = 502;

  constructor(message = "上游 SSE 在收到终止事件前关闭") {
    super(message);
    this.name = "UpstreamStreamError";
  }
}

export class UpstreamNetworkError extends Error {
  public readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = "UpstreamNetworkError";
  }
}

export interface UpstreamStreamResult {
  eventCount: number;
  sawDone: boolean;
  sawFinish: boolean;
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly upstreamUrl: string;
  readonly modelListUrl: string;
  readonly modelFile: string;
  readonly fallbackModelIds: string[];
  readonly authHosts: string[];
  readonly authPaths: string[];
  readonly authMethods: string[];
  readonly captureHeaders: string[];
  readonly clientCandidates: string[];
  readonly discoverModels?: (
    authHeaders: AuthHeaders,
    config: GatewayConfig,
    signal?: AbortSignal
  ) => Promise<ModelDescriptor[]>;
  readonly describeModel?: (model: ModelDescriptor) => ModelDescriptor;
  streamChat(
    authHeaders: AuthHeaders,
    request: NormalizedChatRequest,
    config: GatewayConfig,
    onChunk: (chunk: UpstreamChunk) => void,
    externalSignal?: AbortSignal,
    channel?: ProviderChannel
  ): Promise<UpstreamStreamResult>;
}

export interface ProviderChannel {
  id: string;
  upstreamUrl?: string;
}
