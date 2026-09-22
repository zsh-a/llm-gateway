export type PageKey = "overview" | "playground" | "metrics" | "management" | "settings";

export type NoticeTone = "success" | "error" | "warning" | "info";
export type ThemePreference = "light" | "dark" | "system";

export interface NavigateOptions {
  modelId?: string;
  apiKeyId?: string;
  replace?: boolean;
}

export type Navigate = (page: PageKey, options?: NavigateOptions) => void;

export type MetricsWindow = "1h" | "24h" | "7d" | "30d";
export type MetricsStatus = "all" | "success" | "error" | "canceled";

export interface MetricsQuery {
  window: MetricsWindow;
  apiKeyId?: string;
  provider?: string;
  model?: string;
  status?: Exclude<MetricsStatus, "all">;
  limit?: number;
  offset?: number;
}

export interface GatewayModel {
  id: string;
  name?: string;
  provider?: string;
  owned_by?: string;
  capabilities?: Record<string, boolean>;
  reasoning?: boolean;
  reasoningEfforts?: Record<string, string | null>;
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

export interface UsageBreakdown {
  cachedTokens?: number;
  audioTokens?: number;
  imageTokens?: number;
  textTokens?: number;
  reasoningTokens?: number;
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  inputImageTokens?: number;
  outputImageTokens?: number;
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
  inputDetails?: UsageBreakdown;
  outputDetails?: UsageBreakdown;
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
  keyUsage?: KeyUsage[];
  scope?: "admin" | "self";
  periodStart?: number;
  history?: { completeSince: number; legacyIncomplete: boolean };
}

export interface MetricsSnapshot {
  summary: MetricsSummary;
  timeseries: TimeseriesPoint[];
  recent: RecentRequest[];
  total: number;
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
  apiKeyId?: string;
  apiKeyName?: string;
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  protocol?: string;
  provider?: string;
  channelId?: string;
  model?: string;
  reasoningEffort?: string;
  status?: "success" | "error" | "canceled";
  finishReason?: string;
  toolCalls?: number;
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

export type ChannelInput = Pick<ChannelConfig, "id" | "providerId"> &
  Partial<Omit<ChannelConfig, "id" | "providerId">>;

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
  expiresAt?: number | null;
  revokedAt?: number | null;
  lastUsedAt?: number | null;
  readOnly?: boolean;
}

export interface KeyUsage {
  key: ApiKeyRecord;
  usage: MetricGroup & { lastUsedAt?: number | null; canceled?: number };
  activeRequests: number;
}

export type ApiKeyInput = Pick<ApiKeyRecord, "name"> &
  Partial<Pick<ApiKeyRecord, "allowedModels" | "rpmLimit" | "tpmLimit" | "quotaTokens">>;

export type ApiKeyUpdate = Partial<ApiKeyInput> & { enabled?: boolean };

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
  resources: Record<"auth" | "models" | "channels" | "keys" | "metrics", ResourceState>;
}

export interface ResourceState {
  pending: boolean;
  error: string;
  hasData: boolean;
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
