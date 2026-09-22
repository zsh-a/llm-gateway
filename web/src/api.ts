import { invoke } from "@tauri-apps/api/core";
import { EventSourceParserStream } from "eventsource-parser/stream";
import { isTauriRuntime } from "./remote-sync";
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
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private gatewayUrl(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  get isAdministrator(): boolean {
    return isTauriRuntime() || Boolean(this.credentials.adminKey);
  }

  private metricsPrefix(): "/metrics" | "/admin/metrics" {
    return this.isAdministrator ? "/admin/metrics" : "/metrics";
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    if (isTauriRuntime() && path.startsWith("/admin/")) {
      init.signal?.throwIfAborted();
      let result: { status: number; body: Record<string, unknown> };
      try {
        result = await invoke("management_request", {
          method: init.method ?? "GET",
          path,
          body: typeof init.body === "string" ? JSON.parse(init.body) : null,
        });
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error));
      }
      init.signal?.throwIfAborted();
      if (result.status >= 400) {
        const error = result.body.error as { message?: string } | undefined;
        throw new ApiError(error?.message ?? "管理请求失败", result.status);
      }
      return result.body as T;
    }
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (path.startsWith("/admin/")) {
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
    return (
      await this.request<{ data: GatewayModel[] }>(
        this.isAdministrator ? "/admin/models" : "/v1/models",
        { signal },
      )
    ).data;
  }

  async channels(signal?: AbortSignal): Promise<ChannelConfig[]> {
    return (await this.request<{ data: ChannelConfig[] }>("/admin/channels", { signal })).data;
  }

  async keys(signal?: AbortSignal): Promise<ApiKeyRecord[]> {
    return (await this.request<{ data: ApiKeyRecord[] }>("/admin/keys", { signal })).data;
  }

  private metricParams(query: MetricsQuery): URLSearchParams {
    const params = new URLSearchParams({ window: query.window });
    if (query.apiKeyId) params.set("apiKeyId", query.apiKeyId);
    if (query.provider) params.set("provider", query.provider);
    if (query.model) params.set("model", query.model);
    if (query.status) params.set("status", query.status);
    return params;
  }

  metricsSummary(query: MetricsQuery, signal?: AbortSignal): Promise<MetricsSummary> {
    return this.request(`${this.metricsPrefix()}/summary?${this.metricParams(query)}`, { signal });
  }

  async metricsTimeseries(query: MetricsQuery, signal?: AbortSignal): Promise<TimeseriesPoint[]> {
    const result = await this.request<{ data: TimeseriesPoint[] }>(
      `${this.metricsPrefix()}/timeseries?${this.metricParams(query)}`,
      { signal },
    );
    return result.data;
  }

  async metricsRequests(
    query: MetricsQuery,
    signal?: AbortSignal,
  ): Promise<Pick<MetricsSnapshot, "recent" | "total">> {
    const params = this.metricParams(query);
    params.set("limit", String(query.limit ?? 50));
    params.set("offset", String(query.offset ?? 0));
    const result = await this.request<{ data: RecentRequest[]; total?: number }>(
      `${this.metricsPrefix()}/requests?${params}`,
      { signal },
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
          usage: payload.usage,
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
