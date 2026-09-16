import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AuthStore } from "../src/auth-store.js";
import type { ChannelConfig } from "../src/channels.js";
import type { GatewayConfig } from "../src/config.js";
import type { ModelRoute } from "../src/model-router.js";
import {
  UpstreamNetworkError,
  type ProviderAdapter
} from "../src/provider.js";
import {
  streamUpstream,
  UpstreamTimeoutError
} from "../src/upstream.js";

function config(requestTimeoutMs: number): GatewayConfig {
  return {
    port: 3000,
    bindHost: "127.0.0.1",
    requestTimeoutMs,
    maxBodyBytes: 100000,
    apiKey: "",
    corsOrigin: "",
    runtimeDir: ".runtime",
    authCacheDir: ".runtime/auth",
    modelDiscoveryEnabled: false,
    modelDiscoveryTimeoutMs: 1000,
    modelAllowlist: [],
    modelCacheTtlMs: 60000,
    modelCacheDir: ".runtime/models",
    modelFiles: {},
    defaultModel: "",
    responseStoreMaxEntries: 128,
    responseStoreTtlMs: 60000,
    responseStoreMaxBytes: 1024 * 1024,
    metricsMaxRecords: 10,
    channelsFile: ".runtime/channels.json",
    apiKeysFile: ".runtime/api-keys.json",
    metricsFile: ".runtime/metrics.json",
    adminKey: ""
  };
}

function channel(id: string, authRef = id): ChannelConfig {
  return {
    id,
    name: id,
    providerId: "fake",
    authRef,
    enabled: true,
    priority: 100,
    weight: 1,
    modelMappings: {}
  };
}

function route(provider: ProviderAdapter, channels: ChannelConfig[]): ModelRoute {
  return {
    provider,
    channel: channels[0],
    candidates: channels.map((item) => ({ channel: item, upstreamModel: "demo" })),
    model: { id: "demo", providerId: "fake", publicId: "demo", ownedBy: "Fake" },
    upstreamModel: "demo",
    publicModel: "demo"
  };
}

function provider(
  streamChat: ProviderAdapter["streamChat"]
): ProviderAdapter {
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
    streamChat
  };
}

test("upstream failover retries typed network errors", async () => {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-upstream-"));
  try {
    const authStore = new AuthStore(join(directory, "auth"));
    authStore.save("a", { authorization: "a" });
    authStore.save("b", { authorization: "b" });
    let attempts = 0;
    const fake = provider(async (_headers, _request, _config, onChunk) => {
      attempts += 1;
      if (attempts === 1) throw new UpstreamNetworkError("offline");
      onChunk({ choices: [{ delta: { content: "ok" } }] });
      return { eventCount: 1, sawDone: true, sawFinish: false };
    });
    const result = await streamUpstream(
      { authStore, config: config(1000) },
      route(fake, [channel("a"), channel("b")]),
      { model: "demo", messages: [], stream: true, effort: "none", reasoningEffortExplicit: false, options: {} },
      () => undefined,
      undefined,
      () => undefined
    );

    assert.equal(result.channel.id, "b");
    assert.equal(attempts, 2);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("upstream timeout is a total deadline and does not try every channel", async () => {
  const directory = mkdtempSync(join(tmpdir(), "llm-gateway-upstream-"));
  try {
    const authStore = new AuthStore(join(directory, "auth"));
    authStore.save("a", { authorization: "a" });
    authStore.save("b", { authorization: "b" });
    let attempts = 0;
    const fake = provider(async (_headers, _request, _config, _onChunk, signal) => {
      attempts += 1;
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("aborted", "AbortError");
    });

    await assert.rejects(
      streamUpstream(
        { authStore, config: config(20) },
        route(fake, [channel("a"), channel("b")]),
        { model: "demo", messages: [], stream: true, effort: "none", reasoningEffortExplicit: false, options: {} },
        () => undefined,
        undefined,
        () => undefined
      ),
      UpstreamTimeoutError
    );
    assert.equal(attempts, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
