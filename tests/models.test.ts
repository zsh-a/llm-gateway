import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStore } from "../src/auth/auth-store.js";
import { ChannelStore } from "../src/routing/channels.js";
import type { GatewayConfig } from "../src/app/config.js";
import { ModelCatalog } from "../src/routing/model-catalog.js";
import { ProviderRegistry, type ProviderAdapter } from "../src/providers/index.js";

function config(directory: string): GatewayConfig {
  return {
    port: 3000,
    bindHost: "127.0.0.1",
    requestTimeoutMs: 1000,
    maxBodyBytes: 100000,
    apiKey: "",
    corsOrigin: "",
    runtimeDir: directory,
    authCacheDir: join(directory, "auth"),
    modelDiscoveryEnabled: true,
    modelDiscoveryTimeoutMs: 1000,
    modelAllowlist: [],
    modelCacheTtlMs: 60000,
    modelCacheDir: join(directory, "models"),
    modelFiles: {},
    defaultModel: "",
    responseStoreMaxEntries: 128,
    responseStoreTtlMs: 60000,
    responseStoreMaxBytes: 1024 * 1024,
    metricsMaxRecords: 10,
    channelsFile: join(directory, "channels.json"),
    apiKeysFile: join(directory, "keys.json"),
    metricsFile: join(directory, "metrics.json"),
    adminKey: ""
  };
}

function provider(
  discoverModels: ProviderAdapter["discoverModels"] = async () => [{ id: "custom-model" }],
  fallbackModelIds: string[] = []
): ProviderAdapter {
  return {
    id: "custom",
    name: "Custom",
    upstreamUrl: "https://example.test/chat",
    modelListUrl: "",
    modelFile: "",
    fallbackModelIds,
    authHosts: [],
    authPaths: [],
    authMethods: [],
    captureHeaders: [],
    clientCandidates: [],
    discoverModels,
    streamChat: async () => ({ eventCount: 0, sawDone: true, sawFinish: false })
  };
}

test("model catalog supports provider-specific discovery without a model URL", async () => {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-models-"));
  try {
    const value = config(directory);
    writeFileSync(value.channelsFile, JSON.stringify({
      version: 1,
      channels: [{
        id: "custom-default",
        providerId: "custom",
        authRef: "custom",
        enabled: true
      }]
    }));
    const registry = new ProviderRegistry([provider()]);
    const authStore = new AuthStore(value.authCacheDir);
    authStore.save("custom", { authorization: "test" });
    const channels = new ChannelStore(value.channelsFile, registry);
    const catalog = new ModelCatalog(value, { authStore, channels, providers: registry });

    assert.deepEqual((await catalog.get()).map((model) => model.id), ["custom-model"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("model discovery timeout falls back without blocking the catalog", async () => {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-model-timeout-"));
  try {
    const value = config(directory);
    writeFileSync(value.channelsFile, JSON.stringify({
      version: 1,
      channels: [{
        id: "custom-default",
        providerId: "custom",
        authRef: "custom",
        enabled: true
      }]
    }));
    value.modelDiscoveryTimeoutMs = 10;
    const registry = new ProviderRegistry([provider(async (_auth, _config, signal) => (
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      })
    ), ["fallback-model"])]);
    const authStore = new AuthStore(value.authCacheDir);
    authStore.save("custom", { authorization: "test" });
    const channels = new ChannelStore(value.channelsFile, registry);
    const catalog = new ModelCatalog(value, { authStore, channels, providers: registry });

    assert.deepEqual((await catalog.get()).map((model) => model.id), ["fallback-model"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
