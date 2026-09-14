export type PageKey = "overview" | "playground" | "metrics" | "management" | "settings";

export interface GatewayModel {
  id: string;
  name?: string;
  provider?: string;
  owned_by?: string;
  capabilities?: Record<string, boolean>;
  reasoning?: boolean;
  reasoningEfforts?: Record<string, string | null>;
  reasoning_efforts?: Record<string, string | null>;
  defaultReasoningEffort?: string;
  maxTokens?: number;
  max_output_tokens?: number;
}

export interface AuthProviderStatus {
  ready?: boolean;
  capturedAt?: number;
  source?: string;
}

export interface AuthStatus {
  ready?: boolean;
  providers: Record<string, AuthProviderStatus>;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
  requestsWithUsage?: number;
  [key: string]: unknown;
}

export interface MetricGroup {
  key: string;
  requests: number;
  successes: number;
  errors: number;
  successRate: number | null;
  averageMs: number | null;
  tokens: Usage;
}

export interface MetricsSummary {
  requests: number;
  successes: number;
  errors: number;
  canceled: number;
  successRate: number | null;
  activeRequests: number;
  latency: {
    averageMs: number | null;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
  };
  tokens: Usage;
  byProvider: MetricGroup[];
  byChannel: MetricGroup[];
  byModel: MetricGroup[];
  byApiKey: MetricGroup[];
}

export interface TimeseriesPoint {
  start: number;
  end: number;
  requests: number;
  successes: number;
  errors: number;
  canceled: number;
  durationMs: number;
  tokens: Usage;
}

export interface RecentRequest {
  id: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  protocol?: string;
  provider?: string;
  channelId?: string;
  model?: string;
  status?: "success" | "error" | "canceled";
  usage?: Usage | null;
}

export interface ChannelConfig {
  id: string;
  name?: string;
  providerId: string;
  authRef: string;
  upstreamUrl?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  modelMappings?: Record<string, string>;
}

export interface ApiKeyRecord {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  allowedModels: string[];
  rpmLimit: number | null;
  tpmLimit: number | null;
  quotaTokens: number | null;
  usedTokens: number;
  remainingTokens: number | null;
}

export interface DashboardData {
  health: { status: string; service?: string; providers?: string[] };
  auth: AuthStatus;
  models: GatewayModel[];
  summary: MetricsSummary;
  timeseries: TimeseriesPoint[];
  recent: RecentRequest[];
  channels: ChannelConfig[];
  keys: ApiKeyRecord[];
  adminError: string;
}

export interface ChatResult {
  choices?: Array<{
    message?: {
      content?: string | Array<{ text?: string; content?: string }> | null;
      reasoning_content?: string;
      reasoning?: string;
    };
  }>;
  usage?: Usage;
}

export interface ChatStreamUpdate {
  content?: string;
  reasoning?: string;
  usage?: Usage;
  finishReason?: string | null;
  done?: boolean;
}
