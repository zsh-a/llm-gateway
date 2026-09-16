import type {
  ApiKeyRecord,
  AuthStatus,
  ChannelConfig,
  ChatResult,
  DashboardData,
  GatewayModel,
  ChatStreamUpdate,
  MetricsSummary,
  RecentRequest,
  TimeseriesPoint,
  Usage
} from "./types";

export interface Credentials {
  apiKey: string;
  adminKey: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

const emptySummary: MetricsSummary = {
  requests: 0,
  successes: 0,
  errors: 0,
  canceled: 0,
  successRate: null,
  activeRequests: 0,
  latency: { averageMs: null, p50Ms: null, p95Ms: null, maxMs: null },
  tokens: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, inputAudioTokens: 0, outputAudioTokens: 0, inputImageTokens: 0, outputImageTokens: 0, acceptedPredictionTokens: 0, rejectedPredictionTokens: 0, totalTokens: 0, requestsWithUsage: 0 },
  byProvider: [],
  byChannel: [],
  byModel: [],
  byApiKey: []
};

export function loadCredentials(): Credentials {
  return {
    apiKey: sessionStorage.getItem("llm-gateway.api-key") ?? "",
    adminKey: sessionStorage.getItem("llm-gateway.admin-key") ?? ""
  };
}

export function saveCredentials(credentials: Credentials): void {
  sessionStorage.setItem("llm-gateway.api-key", credentials.apiKey);
  sessionStorage.setItem("llm-gateway.admin-key", credentials.adminKey);
}

export class GatewayApi {
  constructor(private readonly credentials: Credentials) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (path.startsWith("/admin/")) {
      if (this.credentials.adminKey) headers.set("Authorization", `Bearer ${this.credentials.adminKey}`);
    } else if (this.credentials.apiKey) {
      headers.set("Authorization", `Bearer ${this.credentials.apiKey}`);
    }
    if (init.body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(path, { ...init, headers });
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = body.error as Record<string, unknown> | undefined;
      throw new ApiError(
        typeof error?.message === "string" ? error.message : `请求失败（HTTP ${response.status}）`,
        response.status
      );
    }
    return body as T;
  }

  private async safe<T>(request: Promise<T>, fallback: T): Promise<T> {
    try {
      return await request;
    } catch {
      return fallback;
    }
  }

  async dashboard(): Promise<DashboardData> {
    const [health, auth, models, summary, timeseries, recent] = await Promise.all([
      this.safe(this.request<DashboardData["health"]>("/health"), { status: "offline" }),
      this.safe(this.request<AuthStatus>("/health/auth"), { providers: {} }),
      this.safe(this.request<{ data: GatewayModel[] }>("/v1/models"), { data: [] }),
      this.safe(this.request<MetricsSummary>("/metrics/summary?window=24h"), emptySummary),
      this.safe(this.request<{ data: TimeseriesPoint[] }>("/metrics/timeseries?window=24h"), { data: [] }),
      this.safe(this.request<{ data: RecentRequest[] }>("/metrics/requests?window=24h&limit=8"), { data: [] })
    ]);

    let channels: ChannelConfig[] = [];
    let keys: ApiKeyRecord[] = [];
    let adminError = "";
    try {
      const channelResponse = await this.request<{ data: ChannelConfig[] }>("/admin/channels");
      channels = channelResponse.data ?? [];
      const keyResponse = await this.request<{ data: ApiKeyRecord[] }>("/admin/keys");
      keys = keyResponse.data ?? [];
    } catch (error) {
      adminError = error instanceof ApiError && error.status === 401
        ? "需要管理员 API Key"
        : error instanceof Error ? error.message : "管理接口不可用";
    }

    return {
      health,
      auth,
      models: models.data ?? [],
      summary,
      timeseries: timeseries.data ?? [],
      recent: recent.data ?? [],
      channels,
      keys,
      adminError
    };
  }

  private reasoningOptions(model: GatewayModel, effort?: string): Record<string, unknown> {
    if (!effort) return {};
    const levels = model.reasoningEfforts ?? {};
    const upstreamEffort = levels[effort];
    if (upstreamEffort === null || effort === "off") {
      return { thinking: { type: "disabled" } };
    }
    return {
      reasoning_effort: upstreamEffort ?? effort,
      thinking: { type: "enabled" }
    };
  }

  private chatBody(model: GatewayModel, prompt: string, effort?: string, stream = false): string {
    return JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: prompt }],
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...this.reasoningOptions(model, effort)
    });
  }

  chat(model: GatewayModel, prompt: string, effort?: string): Promise<ChatResult> {
    return this.request<ChatResult>("/v1/chat/completions", {
      method: "POST",
      body: this.chatBody(model, prompt, effort)
    });
  }

  async streamChat(
    model: GatewayModel,
    prompt: string,
    effort: string | undefined,
    onUpdate: (update: ChatStreamUpdate) => void,
    signal?: AbortSignal
  ): Promise<void> {
    const headers = new Headers({
      Accept: "text/event-stream",
      "Content-Type": "application/json"
    });
    if (this.credentials.apiKey) headers.set("Authorization", `Bearer ${this.credentials.apiKey}`);
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers,
      body: this.chatBody(model, prompt, effort, true),
      signal
    });
    if (!response.ok) {
      const raw = await response.text();
      let message = `请求失败（HTTP ${response.status}）`;
      try {
        const body = JSON.parse(raw) as { error?: { message?: string } };
        message = body.error?.message || message;
      } catch {
        // Keep the HTTP fallback when the gateway did not return JSON.
      }
      throw new ApiError(message, response.status);
    }
    if (!response.body) throw new ApiError("Gateway 未返回流式响应", 502);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let ended = false;
    const consume = (block: string): void => {
      const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim();
      if (!data) return;
      if (data === "[DONE]") {
        ended = true;
        onUpdate({ done: true });
        return;
      }
      let payload: {
        choices?: Array<{
          delta?: {
            content?: string | Array<{ text?: string }> | null;
            reasoning_content?: string;
          };
          finish_reason?: string | null;
        }>;
        usage?: Usage;
      };
      try {
        payload = JSON.parse(data) as typeof payload;
      } catch {
        return;
      }
      const choice = payload.choices?.[0];
      const delta = choice?.delta;
      const content = Array.isArray(delta?.content)
        ? delta.content.map((part) => part.text ?? "").join("")
        : delta?.content ?? "";
      const reasoning = delta?.reasoning_content ?? "";
      if (content || reasoning || payload.usage || choice?.finish_reason) {
        onUpdate({
          content: content || undefined,
          reasoning: reasoning || undefined,
          usage: payload.usage,
          finishReason: choice?.finish_reason
        });
      }
    };

    while (!ended) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !result.done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
      if (result.done) {
        if (buffer.trim()) consume(buffer);
        break;
      }
    }
    if (!ended) onUpdate({ done: true });
  }

  saveChannel(channel: ChannelConfig): Promise<unknown> {
    return this.request("/admin/channels", { method: "POST", body: JSON.stringify(channel) });
  }

  deleteChannel(id: string): Promise<unknown> {
    return this.request(`/admin/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  createKey(body: Record<string, unknown>): Promise<{ secret: string }> {
    return this.request<{ secret: string }>("/admin/keys", { method: "POST", body: JSON.stringify(body) });
  }

  revokeKey(id: string): Promise<unknown> {
    return this.request(`/admin/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
