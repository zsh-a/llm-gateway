import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStore } from "../src/auth/auth-store.js";
import { ChannelStore } from "../src/routing/channels.js";
import { loadConfig, type GatewayConfig } from "../src/app/config.js";
import { ModelCatalog } from "../src/routing/model-catalog.js";
import { defaultProviderRegistry, ProviderRegistry, type ProviderAdapter } from "../src/providers/index.js";
import { extractModels } from "../src/routing/model-descriptor.js";

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

function workbuddyFixture(t: test.TestContext) {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-workbuddy-models-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const value = config(directory);
  const dynamicFile = join(directory, "acc-product-config-v3.json");
  const staticFile = join(directory, "product.json");
  value.modelFileFallbacks = { workbuddy: [dynamicFile, staticFile] };
  const workbuddy = defaultProviderRegistry.get("workbuddy");
  assert.ok(workbuddy);
  const providers = new ProviderRegistry([workbuddy]);
  writeFileSync(value.channelsFile, JSON.stringify({ version: 1, channels: [
    { id: "workbuddy-default", providerId: "workbuddy", authRef: "workbuddy", enabled: true }
  ] }));
  writeFileSync(staticFile, JSON.stringify({ models: [{ id: "hy3" }] }));
  const catalog = new ModelCatalog(value, {
    authStore: new AuthStore(value.authCacheDir),
    channels: new ChannelStore(value.channelsFile, providers),
    providers
  });
  return { value, dynamicFile, staticFile, catalog };
}

test("default WorkBuddy sources include desktop cache before the bundled product", () => {
  const previous = process.env.LLM_GATEWAY_RESOLVED_CONFIG;
  delete process.env.LLM_GATEWAY_RESOLVED_CONFIG;
  try {
    const sources = loadConfig().modelFileFallbacks?.workbuddy;
    assert.equal(sources?.[0], join(homedir(), ".workbuddy", "cache", "acc-product-config-v3.json"));
    if (process.platform === "darwin") {
      assert.equal(sources?.[1], "/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/product.json");
    }
  } finally {
    if (previous === undefined) delete process.env.LLM_GATEWAY_RESOLVED_CONFIG;
    else process.env.LLM_GATEWAY_RESOLVED_CONFIG = previous;
  }
});

test("WorkBuddy discovers HY4 from desktop config with its supported reasoning effort", async (t) => {
  const { dynamicFile, catalog } = workbuddyFixture(t);
  writeFileSync(dynamicFile, JSON.stringify({ models: ["hy4-preview", "hy4-preview-f"].map((id) => ({
    id, name: "Hy4 preview", supportsReasoning: true, supportsToolCall: true,
    onlyReasoning: true, maxInputTokens: 300000,
    reasoning: { supportedEfforts: ["high"], canDisableThinking: false, defaultEffort: "high" }
  })) }));
  const models = await catalog.get();
  assert.deepEqual(models.map((model) => model.id), ["hy4-preview", "hy4-preview-f"]);
  for (const model of models) {
    assert.equal(model.providerId, "workbuddy");
    assert.equal(model.publicId, model.id);
    assert.equal(model.capabilities?.chat, true);
    assert.equal(model.capabilities?.toolCalling, true);
    assert.equal(model.maxInputTokens, 300000);
    assert.deepEqual(model.reasoningEfforts, { high: "high" });
    assert.equal(model.defaultReasoningEffort, "high");
  }
});

test("WorkBuddy falls back from missing, invalid or empty desktop config", async (t) => {
  const { dynamicFile, catalog } = workbuddyFixture(t);
  for (const content of [undefined, "{broken", '{"models":[]}', '{"models":[{}]}']) {
    if (content !== undefined) writeFileSync(dynamicFile, content);
    catalog.clear();
    assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy3"]);
  }
});

test("an explicit WorkBuddy model file wins over desktop config", async (t) => {
  const { value, dynamicFile, staticFile, catalog } = workbuddyFixture(t);
  writeFileSync(dynamicFile, JSON.stringify({ models: [{ id: "hy4-preview" }] }));
  value.modelFiles = { workbuddy: staticFile };
  assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy3"]);
  value.modelFiles.workbuddy = join(value.runtimeDir, "missing.json");
  catalog.clear();
  assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy4-preview"]);
});

test("WorkBuddy rechecks sources after cache expiry and explicit invalidation", async (t) => {
  const { value, dynamicFile, catalog } = workbuddyFixture(t);
  assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy3"]);
  writeFileSync(dynamicFile, JSON.stringify({ models: [{ id: "hy4-preview" }] }));
  assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy3"]);
  value.modelCacheTtlMs = 0;
  assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy4-preview"]);
  value.modelCacheTtlMs = 60000;
  writeFileSync(dynamicFile, JSON.stringify({ models: [{ id: "hy4-preview-f" }] }));
  catalog.clear();
  assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy4-preview-f"]);
});

test("allowlist cannot revive models absent from the selected WorkBuddy source", async (t) => {
  const { value, dynamicFile, catalog } = workbuddyFixture(t);
  writeFileSync(dynamicFile, JSON.stringify({ models: [{ id: "hy4-preview" }] }));
  value.modelAllowlist = ["hy3"];
  assert.deepEqual(await catalog.get(), []);
  value.modelAllowlist = ["hy4-preview"];
  catalog.clear();
  assert.deepEqual((await catalog.get()).map((model) => model.id), ["hy4-preview"]);
});

test("reasoning metadata preserves explicit mappings and optional thinking", () => {
  const models = extractModels({ models: [
    { id: "optional", reasoning: { supportedEfforts: ["low", "high"], canDisableThinking: true } },
    { id: "required", onlyReasoning: true, reasoning: { supportedEfforts: ["high"], canDisableThinking: true } },
    { id: "explicit", reasoningEfforts: { medium: "high" }, reasoning: { supportedEfforts: ["high"] } },
    { id: "deepseek-v4-pro", supportsReasoning: true }
  ] }, "WorkBuddy");
  assert.deepEqual(models[0]?.reasoningEfforts, { low: "low", high: "high", off: null });
  assert.deepEqual(models[1]?.reasoningEfforts, { high: "high" });
  assert.deepEqual(models[2]?.reasoningEfforts, { medium: "high" });
  assert.equal(models[3]?.reasoningEfforts?.medium, "high");
});
