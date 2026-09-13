import type { AuthHeaders } from "./auth-store.js";
import type { GatewayConfig } from "./config.js";
import { consumeSseJson } from "./sse.js";
import type {
  JsonRecord,
  ModelDescriptor,
  NormalizedChatRequest
} from "./types.js";

export type ProviderId = "mimo" | "workbuddy";

export interface UpstreamDelta {
  role?: string;
  content?: string;
  reasoning_content?: string;
  reasoning?: string;
  thinking?: string;
  tool_calls?: unknown;
  function_call?: unknown;
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

export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly name: string;
  readonly defaultModel: string;
  readonly upstreamUrl: string;
  readonly modelListUrl: string;
  readonly modelFile: string;
  readonly fallbackModelIds: string[];
  readonly authHosts: string[];
  readonly authPaths: string[];
  readonly authMethods: string[];
  readonly captureHeaders: string[];
  readonly clientCandidates: string[];
  readonly describeModel?: (model: ModelDescriptor) => ModelDescriptor;
  streamChat(
    authHeaders: AuthHeaders,
    request: NormalizedChatRequest,
    config: GatewayConfig,
    onChunk: (chunk: UpstreamChunk) => void,
    externalSignal?: AbortSignal
  ): Promise<void>;
}

type RequestBodyBuilder = (
  request: NormalizedChatRequest
) => JsonRecord;

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object"
    ? value as JsonRecord
    : {};
}

function upstreamMessages(messages: unknown[]): unknown[] {
  return messages.map((value) => {
    const message = asRecord(value);
    if (message.role !== "developer") return value;
    // DeepSeek/WorkBuddy-compatible endpoints generally accept `system` but
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
  constructor(
    public readonly id: ProviderId,
    public readonly name: string,
    public readonly defaultModel: string,
    public readonly upstreamUrl: string,
    public readonly modelListUrl: string,
    public readonly modelFile: string,
    public readonly fallbackModelIds: string[],
    public readonly authHosts: string[],
    public readonly authPaths: string[],
    public readonly authMethods: string[],
    public readonly captureHeaders: string[],
    public readonly clientCandidates: string[],
    private readonly buildBody: RequestBodyBuilder,
    public readonly describeModel?: (model: ModelDescriptor) => ModelDescriptor
  ) {}

  async streamChat(
    authHeaders: AuthHeaders,
    request: NormalizedChatRequest,
    config: GatewayConfig,
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
      const response = await fetch(this.upstreamUrl, {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify(this.buildBody(request)),
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
}

function workbuddyModelFile(): string {
  return process.platform === "darwin"
    ? "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json"
    : "";
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
  new OpenAICompatibleProvider(
    "mimo",
    "MiMo",
    "mimo-x-pro-preview",
    "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions",
    "https://mimo-server-cn.xiaomimimo.com/api/model/list",
    "",
    ["mimo-x-pro-preview", "mimo-pro", "mimo-flash"],
    ["mimo-server-cn.xiaomimimo.com"],
    ["/api/route/chat/completions"],
    ["POST"],
    ["cookie", "authorization", "x-*"],
    macApplicationBinaries("Xiaomi MiMo", ["Xiaomi MiMo", "Electron"]),
    mimoRequestBody,
    mimoModelDescriptor
  ),
  new OpenAICompatibleProvider(
    "workbuddy",
    "WorkBuddy",
    "default",
    "https://copilot.tencent.com/v2/chat/completions",
    "",
    workbuddyModelFile(),
    ["default"],
    ["copilot.tencent.com"],
    ["/v3/config", "/v2/report", "/v2/chat/completions"],
    ["GET", "POST"],
    ["cookie", "authorization", "x-*"],
    macApplicationBinaries("WorkBuddy", ["Electron", "WorkBuddy"]),
    workbuddyRequestBody,
    workbuddyModelDescriptor
  )
];

const providerMap: { [key: string]: ProviderAdapter } = {};
for (const provider of providers) providerMap[provider.id] = provider;

export function getProviders(): ProviderAdapter[] {
  return [...providers];
}

export function getProvider(id: string): ProviderAdapter | null {
  return providerMap[id] ?? null;
}
