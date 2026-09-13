import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname, join } from "node:path";

import { getAuthStore, type AuthHeaders } from "./auth-store.js";
import type { GatewayConfig } from "./config.js";
import {
  getProvider,
  getProviders,
  type ProviderAdapter
} from "./provider.js";
import type {
  JsonRecord,
  ModelCapabilities,
  ModelDescriptor,
  ReasoningEfforts
} from "./types.js";

type ModelSource = "local" | "remote" | "cache" | "fallback";

interface StoredModels {
  version: 1;
  models: ModelDescriptor[];
  fetchedAt: number;
}

interface ModelSnapshot {
  models: ModelDescriptor[];
  source: ModelSource;
}

export interface ModelRoute {
  provider: ProviderAdapter;
  model: ModelDescriptor;
  upstreamModel: string;
  publicModel: string;
}

function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object"
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function reasoningEffortsValue(value: unknown): ReasoningEfforts | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const efforts: ReasoningEfforts = {};
  for (const [id, wireValue] of Object.entries(value as JsonRecord)) {
    if (wireValue === null || typeof wireValue === "string") {
      efforts[id] = wireValue;
    }
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined;
}

const GENERIC_REASONING_EFFORTS: ReasoningEfforts = {
  off: null,
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};

const DEEPSEEK_V4_REASONING_EFFORTS: ReasoningEfforts = {
  off: null,
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max"
};

function modelId(value: unknown): string {
  if (typeof value === "string") return value.trim();

  const record = asRecord(value);
  for (const key of ["id", "modelName", "model"]) {
    const id = stringValue(record[key]);
    if (id) return id;
  }
  return "";
}

function modelDescriptor(
  value: unknown,
  defaultOwnedBy: string
): ModelDescriptor | null {
  const id = modelId(value);
  if (!id) return null;
  if (typeof value === "string") return { id, ownedBy: defaultOwnedBy };

  const record = asRecord(value);
  const recordCapabilities = asRecord(record.capabilities);
  const capabilities: ModelCapabilities = {};
  const toolCalling = booleanValue(
    record.supportsToolCall ?? record.supportsToolCalls ?? record.tool_calling ??
      recordCapabilities.toolCalling ?? recordCapabilities.tool_calling
  );
  const images = booleanValue(
    record.supportsImages ?? record.supportsVision ?? record.vision ??
      recordCapabilities.images ?? recordCapabilities.vision
  );
  const rawReasoning = record.supportsReasoning ?? record.reasoning ??
    record.thinking ?? recordCapabilities.reasoning ?? recordCapabilities.thinking;
  const reasoning = booleanValue(
    rawReasoning
  );
  const nestedReasoning = asRecord(record.reasoning);
  const efforts = reasoningEffortsValue(
    record.reasoningEfforts ?? record.reasoning_efforts ??
      recordCapabilities.reasoningEfforts ?? recordCapabilities.reasoning_efforts ??
      nestedReasoning.efforts
  );
  const reasoningEnabled = reasoning ?? (
    rawReasoning !== undefined && typeof rawReasoning === "object"
      ? true
      : efforts !== undefined
        ? true
        : undefined
  );
  if (toolCalling !== undefined) capabilities.toolCalling = toolCalling;
  if (images !== undefined) capabilities.images = images;
  if (reasoningEnabled !== undefined) capabilities.reasoning = reasoningEnabled;
  if (Object.keys(capabilities).length > 0) capabilities.chat = true;

  const name = stringValue(
    record.displayName ?? record.label ?? record.name ?? record.title
  );
  const ownedBy = stringValue(
    record.owned_by ?? record.ownedBy ?? record.vendor ?? record.provider
  ) || defaultOwnedBy;
  const descriptor: ModelDescriptor = { id, ownedBy };
  if (name && name !== id) descriptor.name = name;
  if (Object.keys(capabilities).length > 0) descriptor.capabilities = capabilities;

  if (efforts !== undefined && reasoningEnabled !== false) {
    descriptor.reasoningEfforts = efforts;
  } else if (reasoningEnabled === true) {
    descriptor.reasoningEfforts = id.toLowerCase().startsWith("deepseek-v4-")
      ? { ...DEEPSEEK_V4_REASONING_EFFORTS }
      : { ...GENERIC_REASONING_EFFORTS };
  }

  const defaultReasoningEffort = stringValue(
    record.defaultReasoningEffort ?? record.default_reasoning_effort ??
      nestedReasoning.defaultEffort ?? nestedReasoning.default_effort ??
      nestedReasoning.effort
  );
  if (defaultReasoningEffort) {
    descriptor.defaultReasoningEffort = defaultReasoningEffort;
  }

  const maxInputTokens = numberValue(
    record.maxInputTokens ?? record.max_input_tokens ?? record.contextWindow
  );
  const maxOutputTokens = numberValue(
    record.maxOutputTokens ?? record.max_output_tokens ?? record.maxTokens
  );
  if (maxInputTokens !== undefined) descriptor.maxInputTokens = maxInputTokens;
  if (maxOutputTokens !== undefined) descriptor.maxOutputTokens = maxOutputTokens;
  return descriptor;
}

function uniqueModels(
  values: unknown[],
  defaultOwnedBy: string
): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const model = modelDescriptor(value, defaultOwnedBy);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

function extractModels(
  value: unknown,
  defaultOwnedBy: string
): ModelDescriptor[] {
  const root = asRecord(value);
  if (root.code !== undefined && Number(root.code) !== 0) return [];

  const values: unknown[] = [];
  if (Array.isArray(root.models)) values.push(...root.models);

  const data = root.data;
  if (Array.isArray(data)) values.push(...data);

  const dataRecord = asRecord(data);
  if (Array.isArray(dataRecord.models)) values.push(...dataRecord.models);
  if (Array.isArray(dataRecord.groups)) {
    for (const group of dataRecord.groups) {
      const models = asRecord(group).models;
      if (Array.isArray(models)) values.push(...models);
    }
  }

  if (values.length === 0 && modelId(value)) values.push(value);
  return uniqueModels(values, defaultOwnedBy);
}

function filterModels(
  models: ModelDescriptor[],
  allowlist: string[]
): ModelDescriptor[] {
  if (allowlist.length === 0) return models;
  const allowed = new Set(allowlist);
  return models.filter((model) => allowed.has(model.id));
}

function providerCacheFile(
  config: GatewayConfig,
  provider: ProviderAdapter
): string {
  return join(config.modelCacheDir, `${provider.id}.json`);
}

function readModelsFile(file: string, defaultOwnedBy: string): ModelDescriptor[] {
  try {
    if (!file || !existsSync(file)) return [];
    return extractModels(JSON.parse(readFileSync(file, "utf8")), defaultOwnedBy);
  } catch {
    return [];
  }
}

function readCachedModels(file: string, defaultOwnedBy: string): ModelDescriptor[] {
  try {
    if (!existsSync(file)) return [];
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const record = asRecord(value);
    if (Number(record.version) !== 1 || !Array.isArray(record.models)) return [];
    return uniqueModels(record.models, defaultOwnedBy);
  } catch {
    return [];
  }
}

function writeCachedModels(file: string, models: ModelDescriptor[]): void {
  const stored: StoredModels = {
    version: 1,
    models,
    fetchedAt: Date.now()
  };

  try {
    mkdirSync(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, file);
      chmodSync(file, 0o600);
    } finally {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Best-effort cleanup; the cache remains usable after a successful rename.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`无法保存模型列表缓存 ${file}: ${message}`);
  }
}

class ModelCatalog {
  private memory: { models: ModelDescriptor[]; loadedAt: number } | null = null;
  private loading: Promise<ModelDescriptor[]> | null = null;

  constructor(private readonly config: GatewayConfig) {}

  async get(): Promise<ModelDescriptor[]> {
    if (
      this.memory &&
      Date.now() - this.memory.loadedAt < this.config.modelCacheTtlMs
    ) {
      return this.memory.models;
    }

    if (this.loading) return this.loading;
    this.loading = this.load();
    try {
      const models = await this.loading;
      this.memory = { models, loadedAt: Date.now() };
      return models;
    } finally {
      this.loading = null;
    }
  }

  private async load(): Promise<ModelDescriptor[]> {
    const providerModels = await Promise.all(
      getProviders().map((provider) => this.loadProvider(provider))
    );
    const rawModels: ModelDescriptor[] = [];
    for (const models of providerModels) rawModels.push(...models);

    const counts: { [key: string]: number } = {};
    for (const model of rawModels) {
      counts[model.id] = (counts[model.id] ?? 0) + 1;
    }

    return rawModels.map((model) => {
      const publicId = counts[model.id] > 1
        ? `${model.providerId}/${model.id}`
        : model.id;
      return { ...model, publicId };
    });
  }

  private async loadProvider(
    provider: ProviderAdapter
  ): Promise<ModelDescriptor[]> {
    const ownedBy = provider.name;
    const local = filterModels(
      readModelsFile(provider.modelFile, ownedBy),
      this.config.modelAllowlist
    );
    if (local.length > 0) return this.withProvider(local, provider);

    if (this.config.modelDiscoveryEnabled && provider.modelListUrl) {
      const remote = filterModels(
        await this.fetchRemote(provider),
        this.config.modelAllowlist
      );
      if (remote.length > 0) {
        writeCachedModels(providerCacheFile(this.config, provider), remote);
        return this.withProvider(remote, provider);
      }
    }

    const cached = filterModels(
      readCachedModels(providerCacheFile(this.config, provider), ownedBy),
      this.config.modelAllowlist
    );
    if (cached.length > 0) return this.withProvider(cached, provider);

    const fallback = filterModels(
      provider.fallbackModelIds.map((id) => ({ id, ownedBy })),
      this.config.modelAllowlist
    );
    return this.withProvider(fallback, provider);
  }

  private withProvider(
    models: ModelDescriptor[],
    provider: ProviderAdapter
  ): ModelDescriptor[] {
    return models.map((model) => {
      const described = provider.describeModel?.(model) ?? model;
      return {
        ...described,
        providerId: provider.id,
        publicId: undefined
      };
    });
  }

  private async fetchRemote(provider: ProviderAdapter): Promise<ModelDescriptor[]> {
    const snapshot = getAuthStore(this.config).get(provider.id);
    const auth: AuthHeaders | null = snapshot?.headers ?? null;
    if (!auth) return [];

    try {
      const response = await fetch(provider.modelListUrl, {
        headers: {
          ...auth,
          accept: "application/json"
        }
      });
      if (!response.ok) return [];
      return extractModels(await response.json(), provider.name);
    } catch {
      return [];
    }
  }
}

let defaultCatalog: ModelCatalog | null = null;
let defaultConfig: GatewayConfig | null = null;

function catalogFor(config: GatewayConfig): ModelCatalog {
  if (!defaultCatalog || defaultConfig !== config) {
    defaultConfig = config;
    defaultCatalog = new ModelCatalog(config);
  }
  return defaultCatalog;
}

export async function getModels(config: GatewayConfig): Promise<ModelDescriptor[]> {
  return catalogFor(config).get();
}

function routeFromModel(
  model: ModelDescriptor,
  provider: ProviderAdapter
): ModelRoute {
  return {
    provider,
    model,
    upstreamModel: model.id,
    publicModel: model.publicId ?? model.id
  };
}

export async function resolveModel(
  config: GatewayConfig,
  requestedModel: string
): Promise<ModelRoute | null> {
  const models = await getModels(config);
  const requested = requestedModel.trim();
  const exact = models.find((model) => model.publicId === requested);
  if (exact && exact.providerId) {
    const provider = getProvider(exact.providerId);
    if (provider) return routeFromModel(exact, provider);
  }

  const separator = requested.indexOf("/");
  if (separator > 0) {
    const provider = getProvider(requested.slice(0, separator));
    const upstreamModel = requested.slice(separator + 1).trim();
    if (provider && upstreamModel) {
      return {
        provider,
        model: {
          id: upstreamModel,
          providerId: provider.id,
          publicId: requested,
          ownedBy: provider.name
        },
        upstreamModel,
        publicModel: requested
      };
    }
  }

  const rawMatches = models.filter((model) => model.id === requested);
  if (rawMatches.length === 1 && rawMatches[0].providerId) {
    const provider = getProvider(rawMatches[0].providerId);
    if (provider) return routeFromModel(rawMatches[0], provider);
  }

  if (!requested && models.length > 0 && models[0].providerId) {
    const provider = getProvider(models[0].providerId);
    if (provider) return routeFromModel(models[0], provider);
  }

  return null;
}
