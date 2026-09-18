import { join } from "node:path";

import { type AuthHeaders, type AuthStore } from "../auth/auth-store.js";
import type { GatewayConfig } from "../app/config.js";
import { type ChannelConfig, type ChannelStore } from "./channels.js";
import { readJsonFile, writeJsonFileAtomic } from "../infrastructure/file-store.js";
import { asRecord } from "../domain/json.js";
import {
  defaultProviderRegistry,
  type ProviderRegistry,
  type ProviderAdapter
} from "../providers/index.js";
import type { ModelDescriptor } from "../domain/types.js";
import { extractModels, filterModels, uniqueModels } from "./model-descriptor.js";

interface StoredModels {
  version: 1;
  models: ModelDescriptor[];
  fetchedAt: number;
}
function providerCacheFile(
  config: GatewayConfig,
  provider: ProviderAdapter
): string {
  return join(config.modelCacheDir, `${provider.id}.json`);
}

function readModelsFile(file: string, defaultOwnedBy: string): ModelDescriptor[] {
  try {
    if (!file) return [];
    const value = readJsonFile(file);
    return value === null ? [] : extractModels(value, defaultOwnedBy);
  } catch {
    return [];
  }
}

function readCachedModels(file: string, defaultOwnedBy: string): ModelDescriptor[] {
  try {
    const value = readJsonFile(file);
    if (value === null) return [];
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
    writeJsonFileAtomic(file, stored);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`无法保存模型列表缓存 ${file}: ${message}`);
  }
}

export interface ModelCatalogDeps {
  authStore: AuthStore;
  channels: ChannelStore;
  providers?: ProviderRegistry;
}

export class ModelCatalog {
  private memory: { models: ModelDescriptor[]; loadedAt: number } | null = null;
  private loading: {
    generation: number;
    promise: Promise<ModelDescriptor[]>;
  } | null = null;
  private generation = 0;

  constructor(
    private readonly config: GatewayConfig,
    private readonly deps: ModelCatalogDeps
  ) {
    this.providers = deps.providers ?? defaultProviderRegistry;
  }

  private readonly providers: ProviderRegistry;

  async get(): Promise<ModelDescriptor[]> {
    if (
      this.memory &&
      Date.now() - this.memory.loadedAt < this.config.modelCacheTtlMs
    ) {
      return this.memory.models;
    }

    if (this.loading && this.loading.generation === this.generation) {
      return this.loading.promise;
    }

    const generation = this.generation;
    const promise = this.load();
    this.loading = { generation, promise };
    try {
      const models = await promise;
      if (generation === this.generation) {
        this.memory = { models, loadedAt: Date.now() };
      }
      return models;
    } finally {
      if (this.loading?.promise === promise) this.loading = null;
    }
  }

  private async load(): Promise<ModelDescriptor[]> {
    const channels = this.deps.channels.list();
    const providerModels = await Promise.all(
      this.providers.list().map((provider) => this.loadProvider(provider, channels))
    );
    const rawModels: ModelDescriptor[] = [];
    for (const models of providerModels) rawModels.push(...models);

    const counts: { [key: string]: number } = {};
    for (const model of rawModels) {
      counts[model.id] = (counts[model.id] ?? 0) + 1;
    }

    const visible = rawModels.map((model) => {
      const publicId = counts[model.id] > 1
        ? `${model.providerId}/${model.id}`
        : model.id;
      return { ...model, publicId };
    });

    const aliases: ModelDescriptor[] = [];
    const aliasIds = new Set(visible.map((model) => model.publicId ?? model.id));
    for (const channel of channels) {
      if (!channel.enabled) continue;
      const provider = this.providers.get(channel.providerId);
      if (!provider) continue;
      for (const [publicId, upstreamModel] of Object.entries(channel.modelMappings)) {
        if (publicId === "*" || aliasIds.has(publicId)) continue;
        const source = visible.find((model) => (
          model.providerId === provider.id && model.id === upstreamModel
        ));
        aliases.push({
          ...(source ?? {
            id: upstreamModel,
            providerId: provider.id,
            ownedBy: provider.name
          }),
          id: upstreamModel,
          publicId,
          providerId: provider.id
        });
        aliasIds.add(publicId);
      }
    }

    return [...visible, ...aliases];
  }

  private async loadProvider(
    provider: ProviderAdapter,
    channels: ChannelConfig[]
  ): Promise<ModelDescriptor[]> {
    if (!channels.some((channel) => (
      channel.enabled && channel.providerId === provider.id
    ))) {
      return [];
    }
    const ownedBy = provider.name;
    const modelFiles = [
      this.config.modelFiles?.[provider.id] ?? provider.modelFile,
      ...(this.config.modelFileFallbacks?.[provider.id] ?? [])
    ];
    for (const file of modelFiles) {
      const local = readModelsFile(file, ownedBy);
      // Select the source before filtering: an allowlist must not resurrect
      // models removed from the current desktop configuration via a stale file.
      if (local.length > 0) {
        return this.withProvider(filterModels(local, this.config.modelAllowlist), provider);
      }
    }

    if (
      this.config.modelDiscoveryEnabled &&
      (Boolean(provider.discoverModels) || Boolean(provider.modelListUrl))
    ) {
      const remote = filterModels(
        await this.fetchRemote(provider, channels),
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

  private async fetchRemote(
    provider: ProviderAdapter,
    channels: ChannelConfig[]
  ): Promise<ModelDescriptor[]> {
    const authRefs = [
      provider.id,
      ...channels
        .filter((channel) => channel.enabled && channel.providerId === provider.id)
        .map((channel) => channel.authRef)
    ];
    const attempted = new Set<string>();

    for (const authRef of authRefs) {
      if (attempted.has(authRef)) continue;
      attempted.add(authRef);
      const snapshot = this.deps.authStore.get(authRef);
      const auth: AuthHeaders | null = snapshot?.headers ?? null;
      if (!auth) continue;

      const controller = new AbortController();
      const timeoutId = setTimeout(
        () => controller.abort(),
        this.config.modelDiscoveryTimeoutMs
      );
      try {
        const models = provider.discoverModels
          ? await provider.discoverModels(auth, this.config, controller.signal)
          : await this.fetchOpenAiCompatibleModels(provider, auth, controller.signal);
        if (models.length > 0) return models;
      } catch {
        // Try another authenticated channel before falling back to cache.
      } finally {
        clearTimeout(timeoutId);
      }
    }
    return [];
  }

  private async fetchOpenAiCompatibleModels(
    provider: ProviderAdapter,
    auth: AuthHeaders,
    signal: AbortSignal
  ): Promise<ModelDescriptor[]> {
    if (!provider.modelListUrl) return [];
    const response = await fetch(provider.modelListUrl, {
      headers: {
        ...auth,
        accept: "application/json"
      },
      signal
    });
    if (!response.ok) return [];
    return extractModels(await response.json(), provider.name);
  }

  clear(): void {
    this.generation += 1;
    this.memory = null;
  }

}
