import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createGatewayDeps } from "../src/app/deps.js";
import type { GatewayConfig } from "../src/app/config.js";

function configFor(directory: string, providerId: string): GatewayConfig {
  const channelsFile = join(directory, `${providerId}-channels.json`);
  writeFileSync(channelsFile, JSON.stringify({
    version: 1,
    channels: [{
      id: `${providerId}-default`,
      providerId,
      authRef: providerId,
      enabled: true
    }]
  }));
  return {
    port: 3000,
    bindHost: "127.0.0.1",
    requestTimeoutMs: 1000,
    maxBodyBytes: 100000,
    apiKey: "",
    corsOrigin: "*",
    runtimeDir: directory,
    authCacheDir: join(directory, `${providerId}-auth`),
    modelDiscoveryEnabled: false,
    modelDiscoveryTimeoutMs: 1000,
    modelAllowlist: [],
    modelCacheTtlMs: 60_000,
    modelCacheDir: join(directory, `${providerId}-models`),
    modelFiles: {},
    defaultModel: "",
    responseStoreMaxEntries: 128,
    responseStoreTtlMs: 60_000,
    responseStoreMaxBytes: 1024 * 1024,
    metricsMaxRecords: 10,
    channelsFile,
    apiKeysFile: join(directory, `${providerId}-keys.json`),
    metricsFile: join(directory, `${providerId}-metrics.json`),
    adminKey: ""
  };
}

test("GatewayDeps isolates catalogs and channel stores by config", async () => {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-deps-"));
  try {
    const mimo = createGatewayDeps(configFor(directory, "mimo"));
    const workbuddy = createGatewayDeps(configFor(directory, "workbuddy"));
    const [mimoModels, workbuddyModels] = await Promise.all([
      mimo.catalog.get(),
      workbuddy.catalog.get()
    ]);

    assert.deepEqual(
      new Set(mimoModels.map((model) => model.providerId)),
      new Set(["mimo"])
    );
    assert.deepEqual(
      new Set(workbuddyModels.map((model) => model.providerId)),
      new Set(["workbuddy"])
    );
    assert.notEqual(mimo.channels, workbuddy.channels);
    assert.strictEqual(await mimo.catalog.get(), mimoModels);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
