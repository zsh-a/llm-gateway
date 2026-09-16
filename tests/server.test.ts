import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStore } from "../src/auth/auth-store.js";
import { ChannelStore } from "../src/routing/channels.js";
import type { GatewayConfig } from "../src/app/config.js";
import { ApiKeyStore } from "../src/auth/api-key-store.js";
import { MetricsStore } from "../src/observability/metrics.js";
import { ModelCatalog } from "../src/routing/model-catalog.js";
import { ModelRouter } from "../src/routing/model-router.js";
import type { ProviderAdapter } from "../src/providers/index.js";
import { ProviderRegistry } from "../src/providers/index.js";
import { InMemoryResponseStore } from "../src/infrastructure/response-store.js";
import { createGatewayApp } from "../src/transport/http/server.js";

function config(directory: string, bindHost = "127.0.0.1"): GatewayConfig {
  return {
    port: 3000,
    bindHost,
    requestTimeoutMs: 1000,
    maxBodyBytes: 100000,
    apiKey: "",
    corsOrigin: "",
    runtimeDir: directory,
    authCacheDir: join(directory, "auth"),
    modelDiscoveryEnabled: false,
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

function fakeProvider(): ProviderAdapter {
  return {
    id: "fake",
    name: "Fake",
    upstreamUrl: "https://example.test/chat",
    modelListUrl: "",
    modelFile: "",
    fallbackModelIds: ["demo"],
    authHosts: [],
    authPaths: [],
    authMethods: [],
    captureHeaders: [],
    clientCandidates: [],
    streamChat: async (_auth, _request, _config, onChunk) => {
      onChunk({ choices: [{ delta: { role: "assistant" } }] });
      onChunk({ choices: [{ delta: { content: "ok" } }] });
      onChunk({ choices: [{ finish_reason: "stop" }] });
      return { eventCount: 3, sawDone: true, sawFinish: true };
    }
  };
}

function depsFor(directory: string, bindHost = "127.0.0.1") {
  const configValue = config(directory, bindHost);
  const providers = new ProviderRegistry([fakeProvider()]);
  writeFileSync(configValue.channelsFile, JSON.stringify({
    version: 1,
    channels: [{
      id: "fake-default",
      providerId: "fake",
      authRef: "fake",
      enabled: true,
      priority: 100,
      weight: 1
    }]
  }));
  const authStore = new AuthStore(configValue.authCacheDir);
  authStore.save("fake", { authorization: "test" });
  const channels = new ChannelStore(configValue.channelsFile, providers);
  const catalog = new ModelCatalog(configValue, { authStore, channels, providers });
  return {
    config: configValue,
    providers,
    authStore,
    channels,
    catalog,
    router: new ModelRouter(catalog, channels, providers),
    apiKeys: new ApiKeyStore(configValue.apiKeysFile, configValue.apiKey),
    metrics: new MetricsStore(configValue.metricsMaxRecords, configValue.metricsFile),
    responseStore: new InMemoryResponseStore()
  };
}

test("HTTP app serves models and executes a non-streaming Chat request", async () => {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-http-"));
  const deps = depsFor(directory);
  try {
    const app = createGatewayApp(deps);
    const health = await app.request("http://localhost/health");
    assert.equal(health.status, 200);

    const models = await app.request("http://localhost/v1/models");
    assert.equal(models.status, 200);
    assert.deepEqual((await models.json()).data.map((item: { id: string }) => item.id), ["demo"]);

    const response = await app.request("http://localhost/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "demo",
        messages: [{ role: "user", content: "hello" }],
        stream: false
      })
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.choices[0].message.content, "ok");
  } finally {
    deps.metrics.flush();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("remote HTTP listeners reject unauthenticated gateway traffic", async () => {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-http-"));
  const deps = depsFor(directory, "0.0.0.0");
  try {
    const response = await createGatewayApp(deps).request("http://localhost/v1/models");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.type, "configuration_error");
  } finally {
    deps.metrics.flush();
    rmSync(directory, { recursive: true, force: true });
  }
});
