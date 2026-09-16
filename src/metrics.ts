import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";
import type { JsonRecord, NormalizedChatRequest } from "./types.js";
import {
  normalizeUsage,
  type TokenBreakdown,
  type TokenUsage
} from "./usage.js";

export { normalizeUsage } from "./usage.js";
export type { TokenBreakdown, TokenUsage } from "./usage.js";

export type MetricProtocol = "chat" | "responses";
export type MetricStatus = "success" | "error" | "canceled";

export interface MetricRecord {
  id: string;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  protocol: MetricProtocol;
  provider: string;
  channelId?: string;
  apiKeyId?: string;
  model: string;
  reasoningEffort: string;
  status: MetricStatus;
  usage: TokenUsage | null;
  errorType?: string;
  finishReason?: string;
  toolCalls: number;
}

export interface MetricHandle {
  id: string;
  startedAt: number;
  protocol: MetricProtocol;
  provider: string;
  channelId?: string;
  apiKeyId?: string;
  model: string;
  reasoningEffort: string;
  completed: boolean;
}

export interface MetricAdmission {
  id: string;
  startedAt: number;
  protocol: MetricProtocol;
  apiKeyId?: string;
  completed: boolean;
}

export interface MetricOutcome {
  status: MetricStatus;
  usage?: unknown;
  errorType?: string;
  finishReason?: string;
  toolCalls?: number;
}

interface MetricFilter {
  windowMs?: number;
  limit?: number;
  provider?: string;
  model?: string;
  status?: MetricStatus;
  apiKeyId?: string;
}

interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
  inputImageTokens: number;
  outputImageTokens: number;
  acceptedPredictionTokens: number;
  rejectedPredictionTokens: number;
  totalTokens: number;
  requestsWithUsage: number;
}

interface GroupTotals extends TokenTotals {
  key: string;
  requests: number;
  successes: number;
  errors: number;
  canceled: number;
  totalDurationMs: number;
}

interface MetricMetadata {
  channelId?: string;
  apiKeyId?: string;
}

interface StoredMetrics {
  version: 1;
  records: MetricRecord[];
}

function emptyTotals(): TokenTotals {
  return {
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
    requestsWithUsage: 0
  };
}

function addUsage(totals: TokenTotals, usage: TokenUsage | null): void {
  if (!usage) return;
  totals.requestsWithUsage += 1;
  totals.inputTokens += usage.inputTokens ?? 0;
  totals.outputTokens += usage.outputTokens ?? 0;
  totals.reasoningTokens += usage.reasoningTokens ?? 0;
  totals.cachedTokens += usage.cachedTokens ?? 0;
  totals.cacheCreationTokens += usage.cacheCreationTokens ?? 0;
  totals.inputAudioTokens += usage.inputAudioTokens ?? 0;
  totals.outputAudioTokens += usage.outputAudioTokens ?? 0;
  totals.inputImageTokens += usage.inputImageTokens ?? 0;
  totals.outputImageTokens += usage.outputImageTokens ?? 0;
  totals.acceptedPredictionTokens += usage.acceptedPredictionTokens ?? 0;
  totals.rejectedPredictionTokens += usage.rejectedPredictionTokens ?? 0;
  totals.totalTokens += usage.totalTokens ?? 0;
}

function groupTotals(key: string): GroupTotals {
  return {
    key,
    requests: 0,
    successes: 0,
    errors: 0,
    canceled: 0,
    totalDurationMs: 0,
    ...emptyTotals()
  };
}

function addRecord(group: GroupTotals, record: MetricRecord): void {
  group.requests += 1;
  group.totalDurationMs += record.durationMs;
  if (record.status === "success") group.successes += 1;
  if (record.status === "error") group.errors += 1;
  if (record.status === "canceled") group.canceled += 1;
  addUsage(group, record.usage);
}

function quantile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

export function parseDuration(value: string | null | undefined, fallbackMs: number): number {
  if (!value) return fallbackMs;
  const match = value.trim().toLowerCase().match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (!match) return fallbackMs;
  const amount = Number(match[1]);
  const units: { [key: string]: number } = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000
  };
  return Math.min(30 * 24 * 60 * 60 * 1000, amount * units[match[2]]);
}

export class MetricsStore {
  private readonly records: MetricRecord[] = [];
  private sequence = 0;
  private active = 0;
  private persistenceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly maxRecords: number,
    private readonly file = ""
  ) {
    this.load();
  }

  beginAdmission(
    protocol: MetricProtocol,
    apiKeyId?: string
  ): MetricAdmission {
    return {
      id: this.nextId(),
      startedAt: Date.now(),
      protocol,
      apiKeyId,
      completed: false
    };
  }

  acceptAdmission(admission: MetricAdmission | undefined): void {
    if (admission) admission.completed = true;
  }

  finishAdmission(
    admission: MetricAdmission | undefined,
    model: string,
    outcome: MetricOutcome
  ): void {
    if (!admission || admission.completed) return;
    admission.completed = true;
    const completedAt = Date.now();
    const record: MetricRecord = {
      id: admission.id,
      startedAt: admission.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - admission.startedAt),
      protocol: admission.protocol,
      provider: "gateway",
      apiKeyId: admission.apiKeyId,
      model: model || "unknown",
      reasoningEffort: "unknown",
      status: outcome.status,
      usage: normalizeUsage(outcome.usage),
      errorType: outcome.errorType,
      finishReason: outcome.finishReason,
      toolCalls: outcome.toolCalls ?? 0
    };
    this.records.push(record);
    while (this.records.length > this.maxRecords) this.records.shift();
    this.persist();
  }

  begin(
    protocol: MetricProtocol,
    provider: string,
    model: string,
    request: NormalizedChatRequest,
    metadata: MetricMetadata = {}
  ): MetricHandle {
    const startedAt = Date.now();
    const id = this.nextId(startedAt);
    this.active += 1;
    return {
      id,
      startedAt,
      protocol,
      provider,
      channelId: metadata.channelId,
      apiKeyId: metadata.apiKeyId,
      model,
      reasoningEffort: request.effort,
      completed: false
    };
  }

  finish(handle: MetricHandle, outcome: MetricOutcome): void {
    if (handle.completed) return;
    handle.completed = true;
    this.active = Math.max(0, this.active - 1);
    const completedAt = Date.now();
    const record: MetricRecord = {
      id: handle.id,
      startedAt: handle.startedAt,
      completedAt,
      durationMs: Math.max(0, completedAt - handle.startedAt),
      protocol: handle.protocol,
      provider: handle.provider,
      channelId: handle.channelId,
      apiKeyId: handle.apiKeyId,
      model: handle.model,
      reasoningEffort: handle.reasoningEffort,
      status: outcome.status,
      usage: normalizeUsage(outcome.usage),
      errorType: outcome.errorType,
      finishReason: outcome.finishReason,
      toolCalls: outcome.toolCalls ?? 0
    };
    this.records.push(record);
    while (this.records.length > this.maxRecords) this.records.shift();
    this.persist();
  }

  summary(
    windowMs = 24 * 60 * 60 * 1000,
    apiKeyId?: string
  ): JsonRecord {
    const records = this.filter({ windowMs, apiKeyId });
    const total = records.length;
    const successes = records.filter((record) => record.status === "success").length;
    const errors = records.filter((record) => record.status === "error").length;
    const canceled = records.filter((record) => record.status === "canceled").length;
    const durations = records.map((record) => record.durationMs);
    const totals = emptyTotals();
    for (const record of records) addUsage(totals, record.usage);
    const now = Date.now();

    return {
      object: "llm-gateway.metrics.summary",
      generatedAt: now,
      from: now - windowMs,
      to: now,
      windowMs,
      activeRequests: this.active,
      requests: total,
      successes,
      errors,
      canceled,
      successRate: total === 0 ? null : Number(((successes / total) * 100).toFixed(2)),
      latency: {
        averageMs: total === 0
          ? null
          : Math.round(durations.reduce((sum, value) => sum + value, 0) / total),
        p50Ms: total === 0 ? null : quantile(durations, 0.5),
        p95Ms: total === 0 ? null : quantile(durations, 0.95),
        maxMs: total === 0 ? null : Math.max(...durations)
      },
      tokens: totals,
      byProvider: this.groups(records, (record) => record.provider),
      byChannel: this.groups(
        records,
        (record) => record.channelId ?? record.provider
      ),
      byModel: this.groups(records, (record) => record.model),
      byApiKey: this.groups(
        records,
        (record) => record.apiKeyId ?? "anonymous"
      )
    };
  }

  timeseries(
    windowMs = 24 * 60 * 60 * 1000,
    bucketMs?: number,
    apiKeyId?: string
  ): JsonRecord {
    const now = Date.now();
    const defaultBucket = windowMs <= 60 * 60 * 1000
      ? 5 * 60 * 1000
      : windowMs <= 24 * 60 * 60 * 1000
        ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
    const bucket = Math.max(60 * 1000, bucketMs ?? defaultBucket);
    const from = now - windowMs;
    const firstBucket = Math.floor(from / bucket) * bucket;
    const bucketCount = Math.min(744, Math.ceil((now - firstBucket) / bucket));
    const points: JsonRecord[] = [];
    const records = this.filter({ windowMs, apiKeyId });

    for (let index = 0; index < bucketCount; index += 1) {
      const start = firstBucket + index * bucket;
      const end = start + bucket;
      const group = records.filter((record) => record.startedAt >= start && record.startedAt < end);
      const totals = emptyTotals();
      for (const record of group) addUsage(totals, record.usage);
      points.push({
        start,
        end,
        requests: group.length,
        successes: group.filter((record) => record.status === "success").length,
        errors: group.filter((record) => record.status === "error").length,
        canceled: group.filter((record) => record.status === "canceled").length,
        durationMs: group.length === 0
          ? 0
          : Math.round(group.reduce((sum, record) => sum + record.durationMs, 0) / group.length),
        tokens: totals
      });
    }

    return {
      object: "llm-gateway.metrics.timeseries",
      generatedAt: now,
      from,
      to: now,
      windowMs,
      bucketMs: bucket,
      data: points
    };
  }

  recent(filter: MetricFilter = {}): JsonRecord {
    const records = this.filter(filter).sort((left, right) => right.startedAt - left.startedAt);
    const limit = Math.min(200, Math.max(1, filter.limit ?? 50));
    return {
      object: "llm-gateway.metrics.requests",
      data: records.slice(0, limit),
      limit,
      total: records.length
    };
  }

  models(
    windowMs = 24 * 60 * 60 * 1000,
    apiKeyId?: string
  ): JsonRecord {
    const records = this.filter({ windowMs, apiKeyId });
    return {
      object: "llm-gateway.metrics.models",
      generatedAt: Date.now(),
      windowMs,
      data: this.groups(records, (record) => record.model)
    };
  }

  private filter(filter: MetricFilter): MetricRecord[] {
    const from = Date.now() - (filter.windowMs ?? 24 * 60 * 60 * 1000);
    return this.records.filter((record) => (
      record.startedAt >= from &&
      (!filter.apiKeyId || record.apiKeyId === filter.apiKeyId) &&
      (!filter.provider || record.provider === filter.provider) &&
      (!filter.model || record.model === filter.model) &&
      (!filter.status || record.status === filter.status)
    ));
  }

  private groups(
    records: MetricRecord[],
    keyOf: (record: MetricRecord) => string
  ): JsonRecord[] {
    const groups = new Map<string, GroupTotals>();
    for (const record of records) {
      const key = keyOf(record);
      const group = groups.get(key) ?? groupTotals(key);
      addRecord(group, record);
      groups.set(key, group);
    }
    return [...groups.values()]
      .sort((left, right) => right.requests - left.requests)
      .map((group) => ({
        key: group.key,
        requests: group.requests,
        successes: group.successes,
        errors: group.errors,
        canceled: group.canceled,
        successRate: group.requests === 0
          ? null
          : Number(((group.successes / group.requests) * 100).toFixed(2)),
        averageMs: group.requests === 0
          ? null
          : Math.round(group.totalDurationMs / group.requests),
        tokens: {
          inputTokens: group.inputTokens,
          outputTokens: group.outputTokens,
          reasoningTokens: group.reasoningTokens,
          cachedTokens: group.cachedTokens,
          cacheCreationTokens: group.cacheCreationTokens,
          inputAudioTokens: group.inputAudioTokens,
          outputAudioTokens: group.outputAudioTokens,
          inputImageTokens: group.inputImageTokens,
          outputImageTokens: group.outputImageTokens,
          acceptedPredictionTokens: group.acceptedPredictionTokens,
          rejectedPredictionTokens: group.rejectedPredictionTokens,
          totalTokens: group.totalTokens,
          requestsWithUsage: group.requestsWithUsage
        }
      }));
  }

  private load(): void {
    if (!this.file) return;
    try {
      const value = readJsonFile(this.file);
      if (value === null) return;
      const record = value !== null && typeof value === "object"
        ? value as { [key: string]: unknown }
        : {};
      if (Number(record.version) !== 1 || !Array.isArray(record.records)) return;
      let migrated = false;
      for (const item of record.records) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const metric = item as MetricRecord;
        if (!metric.id || !metric.startedAt || !metric.completedAt) continue;
        if (metric.status !== "success" && metric.status !== "error" && metric.status !== "canceled") continue;
        const usage = metric.usage === null ? null : normalizeUsage(metric.usage);
        if (JSON.stringify(usage) !== JSON.stringify(metric.usage)) migrated = true;
        this.records.push({
          ...metric,
          usage
        });
      }
      while (this.records.length > this.maxRecords) this.records.shift();
      if (migrated) this.persist();
    } catch {
      // A corrupt metrics file must not prevent the gateway from starting.
    }
  }

  private nextId(startedAt = Date.now()): string {
    return `req_${startedAt.toString(36)}_${(this.sequence++).toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  }

  private persist(): void {
    if (!this.file) return;
    if (this.persistenceTimer !== null) return;
    // Metrics are diagnostic data. Coalesce bursts of completions so the
    // request path does not synchronously rewrite the complete ring buffer.
    this.persistenceTimer = setTimeout(() => {
      this.persistenceTimer = null;
      this.persistNow();
    }, 0);
  }

  /** Flush pending diagnostic data before an intentional process shutdown. */
  flush(): void {
    if (this.persistenceTimer === null) return;
    clearTimeout(this.persistenceTimer);
    this.persistenceTimer = null;
    this.persistNow();
  }

  private persistNow(): void {
    if (!this.file) return;
    try {
      const stored: StoredMetrics = { version: 1, records: this.records };
      writeJsonFileAtomic(this.file, stored);
    } catch {
      // Metrics are observability data; persistence failure must not break a request.
    }
  }
}
