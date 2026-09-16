import type { AuthHeaders } from "./auth-store.js";
import type { GatewayConfig } from "./config.js";
import { asRecord } from "./json.js";
import { consumeSseJson } from "./sse.js";
import type {
  JsonRecord,
  ModelDescriptor,
  NormalizedChatRequest
} from "./types.js";

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

function baseRequestBody(request: NormalizedChatRequest): JsonRecord {
  const body: JsonRecord = { ...request.options };
  body.model = request.model;
  body.messages = upstreamMessages(request.messages);
  body.stream = true;
  return body;
}

function mimoRequestBody(request: NormalizedChatRequest): JsonRecord {
  const body = baseRequestBody(request);

  if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  if (
    request.modelDescriptor?.capabilities?.reasoning === false &&
    !request.reasoningEffortExplicit
  ) {
    delete body.reasoning_effort;
    delete body.thinking;
    return body;
  }

  if (request.effort === "none") {
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
  } else {
    body.reasoning_effort = request.effort;
  }

  return body;
}

function workbuddyRequestBody(request: NormalizedChatRequest): JsonRecord {
  const body = baseRequestBody(request);

  if (request.effort === "none") {
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
  } else if (
    request.reasoningEffortExplicit ||
    request.effort !== "medium"
  ) {
    body.reasoning_effort = request.effort;
  }
  return body;
}

const MIMO_REASONING_EFFORTS = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};

function mimoModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const id = model.id.toLowerCase();
  if (/(asr|tts|seedream|image|voiceclone|voicedesign|audio)/.test(id)) {
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        chat: false,
        reasoning: false
      }
    };
  }
  if (!id.startsWith("mimo-x-")) {
    return {
      ...model,
      capabilities: { ...model.capabilities, chat: true }
    };
  }

  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      chat: true,
      reasoning: true
    },
    reasoningEfforts: model.reasoningEfforts ?? { ...MIMO_REASONING_EFFORTS },
    defaultReasoningEffort: model.defaultReasoningEffort ?? "medium"
  };
}

function workbuddyModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const id = model.id.toLowerCase();
  if (/(image|kling|tts|asr|audio|voice)/.test(id)) {
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        chat: false,
        reasoning: false
      }
    };
  }
  return {
    ...model,
    capabilities: { ...model.capabilities, chat: true }
  };
}

class OpenAICompatibleProvider implements ProviderAdapter {
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

function macApplicationBinaries(
  application: string,
  executables: string[]
): string[] {
  if (process.platform !== "darwin") return [];

  const roots = [
    "/Applications",
    process.env.HOME ? process.env.HOME + "/Applications" : ""
  ].filter(Boolean);

  return roots.flatMap((root) => executables.map((executable) => (
    root + "/" + application + ".app/Contents/MacOS/" + executable
  )));
}

const providers: ProviderAdapter[] = [
  new OpenAICompatibleProvider({
    id: "mimo",
    name: "MiMo",
    upstreamUrl: "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions",
    modelListUrl: "https://mimo-server-cn.xiaomimimo.com/api/model/list",
    modelFile: "",
    fallbackModelIds: ["mimo-x-pro-preview", "mimo-pro", "mimo-flash"],
    authHosts: ["mimo-server-cn.xiaomimimo.com"],
    authPaths: ["/api/route/chat/completions"],
    authMethods: ["POST"],
    captureHeaders: ["cookie", "authorization", "x-*"],
    clientCandidates: macApplicationBinaries("Xiaomi MiMo", ["Xiaomi MiMo", "Electron"]),
    buildBody: mimoRequestBody,
    describeModel: mimoModelDescriptor
  }),
  new OpenAICompatibleProvider({
    id: "workbuddy",
    name: "WorkBuddy",
    upstreamUrl: "https://copilot.tencent.com/v2/chat/completions",
    modelListUrl: "",
    modelFile: "",
    fallbackModelIds: ["default"],
    authHosts: ["copilot.tencent.com"],
    authPaths: ["/v3/config", "/v2/report", "/v2/chat/completions"],
    authMethods: ["GET", "POST"],
    captureHeaders: ["cookie", "authorization", "x-*"],
    clientCandidates: macApplicationBinaries("WorkBuddy", ["Electron", "WorkBuddy"]),
    buildBody: workbuddyRequestBody,
    describeModel: workbuddyModelDescriptor
  })
];

export class ProviderRegistry {
  private readonly providerMap = new Map<string, ProviderAdapter>();

  constructor(providerList: ReadonlyArray<ProviderAdapter>) {
    for (const provider of providerList) {
      if (this.providerMap.has(provider.id)) {
        throw new Error(`重复的 Provider ID: ${provider.id}`);
      }
      this.providerMap.set(provider.id, provider);
    }
  }

  list(): ProviderAdapter[] {
    return [...this.providerMap.values()];
  }

  get(id: string): ProviderAdapter | null {
    return this.providerMap.get(id) ?? null;
  }
}

export const defaultProviderRegistry = new ProviderRegistry(providers);

export function getProviders(): ProviderAdapter[] {
  return defaultProviderRegistry.list();
}

export function getProvider(id: string): ProviderAdapter | null {
  return defaultProviderRegistry.get(id);
}
