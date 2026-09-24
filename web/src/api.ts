import { EventSourceParserStream } from "eventsource-parser/stream";
import { normalizeUsage } from "./lib/usage";
import type { ManagementRequest, ManagementTransport } from "./management";
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

// The desktop app uses the local Axum gateway by default; deployments can override it.
export const gatewayBaseUrl = (
  import.meta.env.VITE_GATEWAY_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/+$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

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
  readonly baseUrl: string;

  constructor(
    private readonly credentials: Credentials,
    baseUrl = gatewayBaseUrl,
    private readonly management?: ManagementTransport,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private gatewayUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  get isAdministrator(): boolean {
    return Boolean(this.management || this.credentials.adminKey);
  }

  private metricsPrefix(): "/metrics" | "/admin/metrics" {
    return this.isAdministrator ? "/admin/metrics" : "/metrics";
  }

  private async adminRequest<T>(
    request: ManagementRequest,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    if (!this.management) return this.request(path, init, true);
    init.signal?.throwIfAborted();
    const result = await this.management(request);
    init.signal?.throwIfAborted();
    if (result.status >= 400) {
      const error = result.body.error as { message?: string } | undefined;
      throw new ApiError(error?.message ?? "管理请求失败", result.status);
    }
    return result.body as T;
  }

  private async request<T>(path: string, init: RequestInit = {}, admin = false): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (admin) {
      const adminCredential = this.credentials.adminKey;
      if (adminCredential) headers.set("Authorization", `Bearer ${adminCredential}`);
    } else if (this.credentials.apiKey) {
      headers.set("Authorization", `Bearer ${this.credentials.apiKey}`);
    }
    if (init.body !== undefined) headers.set("Content-Type", "application/json");

    const response = await fetch(this.gatewayUrl(path), { ...init, headers });
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

  health(signal?: AbortSignal): Promise<DashboardData["health"]> {
    return this.request("/health", { signal });
  }

  auth(signal?: AbortSignal): Promise<AuthStatus> {
    return this.request("/health/auth", { signal });
  }

  async models(signal?: AbortSignal): Promise<GatewayModel[]> {
    const result = this.isAdministrator
      ? await this.adminRequest<{ data: GatewayModel[] }>(
          { operation: "models" },
          "/admin/models",
          { signal },
        )
      : await this.request<{ data: GatewayModel[] }>("/v1/models", { signal });
    return result.data;
  }

  async channels(signal?: AbortSignal): Promise<ChannelConfig[]> {
    return (
      await this.adminRequest<{ data: ChannelConfig[] }>(
        { operation: "list_channels" },
        "/admin/channels",
        { signal },
      )
    ).data;
  }

  async keys(signal?: AbortSignal): Promise<ApiKeyRecord[]> {
    return (
      await this.adminRequest<{ data: ApiKeyRecord[] }>({ operation: "list_keys" }, "/admin/keys", {
        signal,
      })
    ).data;
  }

  private metricParams(query: MetricsQuery): URLSearchParams {
    const params = new URLSearchParams({ window: query.window });
    if (query.apiKeyId) params.set("apiKeyId", query.apiKeyId);
    if (query.provider) params.set("provider", query.provider);
    if (query.model) params.set("model", query.model);
    if (query.status) params.set("status", query.status);
    return params;
  }

  private metricRequest<T>(
    view: "summary" | "timeseries" | "requests",
    query: MetricsQuery,
    signal?: AbortSignal,
  ): Promise<T> {
    const params = this.metricParams(query);
    if (view === "requests") {
      params.set("limit", String(query.limit ?? 50));
      params.set("offset", String(query.offset ?? 0));
    }
    const path = `${this.metricsPrefix()}/${view}?${params}`;
    return this.isAdministrator
      ? this.adminRequest({ operation: "metrics", view, query }, path, { signal })
      : this.request(path, { signal });
  }

  metricsSummary(query: MetricsQuery, signal?: AbortSignal): Promise<MetricsSummary> {
    return this.metricRequest("summary", query, signal);
  }

  async metricsTimeseries(query: MetricsQuery, signal?: AbortSignal): Promise<TimeseriesPoint[]> {
    return (await this.metricRequest<{ data: TimeseriesPoint[] }>("timeseries", query, signal))
      .data;
  }

  async metricsRequests(
    query: MetricsQuery,
    signal?: AbortSignal,
  ): Promise<Pick<MetricsSnapshot, "recent" | "total">> {
    const result = await this.metricRequest<{ data: RecentRequest[]; total?: number }>(
      "requests",
      query,
      signal,
    );
    return { recent: result.data, total: result.total ?? result.data.length };
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

  async chat(model: GatewayModel, prompt: string, effort?: string): Promise<ChatResult> {
    const result = await this.request<ChatResult>("/v1/chat/completions", {
      method: "POST",
      body: this.chatBody(model, prompt, effort),
    });
    return { ...result, usage: normalizeUsage(result.usage) };
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
    const response = await fetch(this.gatewayUrl("/v1/chat/completions"), {
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

    const reader = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(new EventSourceParserStream())
      .getReader();
    let finished = false;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (!finished) throw new ApiError("响应连接提前结束，请重试", 502);
          break;
        }
        if (value.data.trim() === "[DONE]") break;
        if (!value.data.trim()) continue;
        const payload = JSON.parse(value.data) as {
          error?: { message?: string; status?: number };
          choices?: Array<{
            delta?: {
              content?: string | Array<{ text?: string }> | null;
              reasoning_content?: string;
            };
            finish_reason?: string | null;
          }>;
          usage?: Usage;
        };
        if (payload.error)
          throw new ApiError(payload.error.message || "模型响应失败", payload.error.status ?? 502);
        const choice = payload.choices?.[0];
        const delta = choice?.delta;
        const content = Array.isArray(delta?.content)
          ? delta.content.map((part) => part.text ?? "").join("")
          : (delta?.content ?? "");
        if (choice?.finish_reason) finished = true;
        onUpdate({
          content: content || undefined,
          reasoning: delta?.reasoning_content,
          usage: normalizeUsage(payload.usage),
          finishReason: choice?.finish_reason,
        });
      }
      onUpdate({ done: true });
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }

  saveChannel(channel: ChannelInput): Promise<unknown> {
    return this.adminRequest({ operation: "save_channel", body: channel }, "/admin/channels", {
      method: "POST",
      body: JSON.stringify(channel),
    });
  }

  deleteChannel(id: string): Promise<unknown> {
    return this.adminRequest(
      { operation: "delete_channel", id },
      `/admin/channels/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  createKey(body: ApiKeyInput): Promise<{ secret: string }> {
    return this.adminRequest<{ secret: string }>({ operation: "create_key", body }, "/admin/keys", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  updateKey(id: string, body: ApiKeyUpdate): Promise<unknown> {
    return this.adminRequest(
      { operation: "update_key", id, body },
      `/admin/keys/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(body),
      },
    );
  }

  revokeKey(id: string): Promise<unknown> {
    return this.adminRequest(
      { operation: "revoke_key", id },
      `/admin/keys/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }
}
