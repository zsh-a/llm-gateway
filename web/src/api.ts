import type {
  ApiKeyInput,
  ApiKeyRecord,
  ApiKeyUpdate,
  AuthStatus,
  ChannelConfig,
  ChannelInput,
  ChatResult,
  ChatStreamUpdate,
  DashboardData,
  GatewayModel,
  MetricsQuery,
  MetricsSnapshot,
  MetricsSummary,
  RecentRequest,
  TimeseriesPoint,
  Usage,
} from "./types";

export interface Credentials {
  apiKey: string;
  adminKey: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
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
  tokens: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
    cacheCreationTokens: 0,
    inputAudioTokens: 0,
    outputAudioTokens: 0,
    inputImageTokens: 0,
    outputImageTokens: 0,
    acceptedPredictionTokens: 0,
    rejectedPredictionTokens: 0,
    totalTokens: 0,
    requestsWithUsage: 0,
  },
  byProvider: [],
  byChannel: [],
  byModel: [],
  byApiKey: [],
};

export function loadCredentials(): Credentials {
  return {
    apiKey: sessionStorage.getItem("llm-gateway.api-key") ?? "",
    adminKey: sessionStorage.getItem("llm-gateway.admin-key") ?? "",
  };
}

export function saveCredentials(credentials: Credentials): void {
  sessionStorage.setItem("llm-gateway.api-key", credentials.apiKey);
  sessionStorage.setItem("llm-gateway.admin-key", credentials.adminKey);
}

export class GatewayApi {
  constructor(private readonly credentials: Credentials) {}

  private metricsPrefix(): "/metrics" | "/admin/metrics" {
    return this.credentials.adminKey ? "/admin/metrics" : "/metrics";
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (path.startsWith("/admin/")) {
      const adminCredential = this.credentials.adminKey || this.credentials.apiKey;
      if (adminCredential) headers.set("Authorization", `Bearer ${adminCredential}`);
    } else if (this.credentials.apiKey) {
      headers.set("Authorization", `Bearer ${this.credentials.apiKey}`);
    }
    if (init.body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(path, { ...init, headers });
    const raw = await response.text();
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    if (!response.ok) {
      const error = body.error as Record<string, unknown> | undefined;
      throw new ApiError(
        typeof error?.message === "string" ? error.message : `请求失败（HTTP ${response.status}）`,
        response.status,
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

  async dashboard(signal?: AbortSignal): Promise<DashboardData> {
    const metricsPrefix = this.metricsPrefix();
    const [health, auth, models, summary, timeseries, recent] = await Promise.all([
      this.safe(this.request<DashboardData["health"]>("/health", { signal }), {
        status: "offline",
      }),
      this.safe(this.request<AuthStatus>("/health/auth", { signal }), { providers: {} }),
      this.safe(this.request<{ data: GatewayModel[] }>("/v1/models", { signal }), { data: [] }),
      this.safe(
        this.request<MetricsSummary>(`${metricsPrefix}/summary?window=24h`, { signal }),
        emptySummary,
      ),
      this.safe(
        this.request<{ data: TimeseriesPoint[] }>(`${metricsPrefix}/timeseries?window=24h`, {
          signal,
        }),
        { data: [] },
      ),
      this.safe(
        this.request<{ data: RecentRequest[] }>(`${metricsPrefix}/requests?window=24h&limit=50`, {
          signal,
        }),
        { data: [] },
      ),
    ]);

    const [channelResult, keyResult] = await Promise.allSettled([
      this.request<{ data: ChannelConfig[] }>("/admin/channels", { signal }),
      this.request<{ data: ApiKeyRecord[] }>("/admin/keys", { signal }),
    ]);
    const channels = channelResult.status === "fulfilled" ? (channelResult.value.data ?? []) : [];
    const keys = keyResult.status === "fulfilled" ? (keyResult.value.data ?? []) : [];
    const adminFailure = [channelResult, keyResult].find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    const adminError = adminFailure
      ? adminFailure.reason instanceof ApiError && adminFailure.reason.status === 401
        ? "需要管理员 API Key"
        : adminFailure.reason instanceof Error
          ? adminFailure.reason.message
          : "管理接口不可用"
      : "";

    return {
      health,
      auth,
      models: models.data ?? [],
      summary,
      timeseries: timeseries.data ?? [],
      recent: recent.data ?? [],
      channels,
      keys,
      adminError,
    };
  }

  async metrics(query: MetricsQuery, signal?: AbortSignal): Promise<MetricsSnapshot> {
    const prefix = this.metricsPrefix();
    const filterParams = new URLSearchParams({ window: query.window });
    if (query.provider) filterParams.set("provider", query.provider);
    if (query.model) filterParams.set("model", query.model);
    if (query.status) filterParams.set("status", query.status);
    const requestParams = new URLSearchParams(filterParams);
    requestParams.set("limit", String(query.limit ?? 50));
    if (query.offset) requestParams.set("offset", String(query.offset));

    const [summary, series, recent] = await Promise.all([
      this.request<MetricsSummary>(`${prefix}/summary?${filterParams.toString()}`, { signal }),
      this.request<{ data: TimeseriesPoint[] }>(`${prefix}/timeseries?${filterParams.toString()}`, {
        signal,
      }),
      this.request<{ data: RecentRequest[]; total?: number }>(
        `${prefix}/requests?${requestParams.toString()}`,
        { signal },
      ),
    ]);
    return {
      summary,
      timeseries: series.data ?? [],
      recent: recent.data ?? [],
      total: recent.total ?? recent.data?.length ?? 0,
    };
  }

  private reasoningOptions(model: GatewayModel, effort?: string): Record<string, unknown> {
    if (!effort || effort === "auto") return {};
    const levels = model.reasoningEfforts ?? {};
    const upstreamEffort = levels[effort];
    if (upstreamEffort === null || effort === "off") {
      return { thinking: { type: "disabled" } };
    }
    return {
      reasoning_effort: upstreamEffort ?? effort,
      thinking: { type: "enabled" },
    };
  }

  private chatBody(model: GatewayModel, prompt: string, effort?: string, stream = false): string {
    return JSON.stringify({
      model: model.id,
      messages: [{ role: "user", content: prompt }],
      stream,
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...this.reasoningOptions(model, effort),
    });
  }

  chat(model: GatewayModel, prompt: string, effort?: string): Promise<ChatResult> {
    return this.request<ChatResult>("/v1/chat/completions", {
      method: "POST",
      body: this.chatBody(model, prompt, effort),
    });
  }

  async streamChat(
    model: GatewayModel,
    prompt: string,
    effort: string | undefined,
    onUpdate: (update: ChatStreamUpdate) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers = new Headers({
      Accept: "text/event-stream",
      "Content-Type": "application/json",
    });
    if (this.credentials.apiKey) headers.set("Authorization", `Bearer ${this.credentials.apiKey}`);
    const response = await fetch("/v1/chat/completions", {
      method: "POST",
      headers,
      body: this.chatBody(model, prompt, effort, true),
      signal,
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
        : (delta?.content ?? "");
      const reasoning = delta?.reasoning_content ?? "";
      if (content || reasoning || payload.usage || choice?.finish_reason) {
        onUpdate({
          content: content || undefined,
          reasoning: reasoning || undefined,
          usage: payload.usage,
          finishReason: choice?.finish_reason,
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

  saveChannel(channel: ChannelInput): Promise<unknown> {
    return this.request("/admin/channels", { method: "POST", body: JSON.stringify(channel) });
  }

  deleteChannel(id: string): Promise<unknown> {
    return this.request(`/admin/channels/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  createKey(body: ApiKeyInput): Promise<{ secret: string }> {
    return this.request<{ secret: string }>("/admin/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateKey(id: string, body: ApiKeyUpdate): Promise<unknown> {
    return this.request(`/admin/keys/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
  }

  revokeKey(id: string): Promise<unknown> {
    return this.request(`/admin/keys/${encodeURIComponent(id)}`, { method: "DELETE" });
  }
}
