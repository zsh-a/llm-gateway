import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/app/config.js";
import { GatewayManager, type GatewayManagerOptions, type LiveProbe } from "../src/cli/gateway-manager.js";
import { acquireDesktopLease, desktopEndpoint, desktopLogger, probeLive, probeReady, requestHealth, resolveDesktopConfig } from "../src/cli/desktop-runtime.js";
import { closeGatewayServer } from "../src/transport/http/shutdown.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function harness(overrides: Partial<GatewayManagerOptions> = {}) {
  let live: LiveProbe = { kind: "offline", instanceId: "" };
  let onExit: (reason: string) => void = () => {};
  let spawns = 0;
  let autoExit = true;
  const signals: string[] = [];
  const manager = new GatewayManager({
    remote: false,
    live: async () => live,
    ready: async () => ({ ready: true, detail: "ready" }),
    onChange: () => {},
    spawn: (instanceId, exited) => {
      spawns++;
      onExit = exited;
      live = { kind: "gateway", instanceId };
      return { kill: (signal) => {
        signals.push(signal);
        if (autoExit || signal === "SIGKILL") queueMicrotask(() => onExit("stopped"));
      } };
    },
    ...overrides
  });
  return {
    manager, signals,
    spawns: () => spawns,
    exit: () => { live = { kind: "offline", instanceId: "" }; onExit("unexpected"); },
    delayExit: () => { autoExit = false; }
  };
}

test("stop cancels an in-flight preflight before it can spawn a process", async () => {
  const probe = deferred<LiveProbe>();
  const h = harness({ live: () => probe.promise });
  const starting = h.manager.start();
  await h.manager.stop();
  probe.resolve({ kind: "offline", instanceId: "" });
  await starting;
  assert.equal(h.spawns(), 0);
  assert.equal(h.manager.snapshot().state, "stopped");
});

test("HTTP liveness allows the console before upstream readiness completes", async () => {
  const ready = deferred<{ ready: boolean; detail: string }>();
  const h = harness({ ready: () => ready.promise });
  const starting = h.manager.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h.manager.snapshot().available, true);
  assert.equal(h.manager.snapshot().state, "degraded");
  await h.manager.stop();
  ready.resolve({ ready: true, detail: "stale result" });
  await starting;
  assert.equal(h.manager.snapshot().state, "stopped");
});

test("a later stop cancels queued restarts, including repeated restart clicks", async () => {
  const h = harness();
  await h.manager.start();
  h.delayExit();
  const restart1 = h.manager.restart();
  const restart2 = h.manager.restart();
  const stop = h.manager.stop();
  h.exit();
  await Promise.all([restart1, restart2, stop]);
  assert.equal(h.spawns(), 1);
  assert.deepEqual(h.signals, ["SIGTERM"]);
  assert.equal(h.manager.snapshot().state, "stopped");
});

test("restart starts exactly one new child after the previous child exits", async () => {
  const h = harness();
  await h.manager.start();
  h.delayExit();
  const restarting = h.manager.restart();
  h.exit();
  await restarting;
  assert.equal(h.spawns(), 2);
  assert.equal(h.manager.snapshot().state, "running");
  const stop = h.manager.dispose(); h.exit(); await stop;
});

test("remote and already-running local services are never spawned or killed", async () => {
  for (const remote of [false, true]) {
    const h = harness({ remote, live: async () => ({ kind: "gateway", instanceId: "another-owner" }) });
    await h.manager.start();
    assert.equal(h.manager.snapshot().ownership, remote ? "remote" : "external");
    await h.manager.restart();
    await h.manager.dispose();
    assert.equal(h.spawns(), 0);
    assert.deepEqual(h.signals, []);
  }
});

test("foreign HTTP server is reported as a conflict without starting a child", async () => {
  const h = harness({ live: async () => ({ kind: "foreign", instanceId: "" }) });
  await h.manager.start();
  assert.equal(h.spawns(), 0);
  assert.equal(h.manager.snapshot().available, false);
  assert.match(h.manager.snapshot().detail, /端口/);
});

test("startup cannot mistake an unrelated gateway for its own spawned process", async () => {
  let calls = 0;
  const h = harness({
    startupTimeoutMs: 0,
    live: async () => ++calls === 1 ? { kind: "offline", instanceId: "" } : { kind: "gateway", instanceId: "wrong" }
  });
  await h.manager.start();
  assert.equal(h.manager.snapshot().state, "error");
  assert.equal(h.manager.snapshot().available, false);
  await h.manager.dispose();
});

test("shutdown escalates a stuck child and waits for its exit", async () => {
  const h = harness({ stopTimeoutMs: 15 });
  await h.manager.start();
  h.delayExit();
  await h.manager.dispose();
  assert.deepEqual(h.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(h.manager.snapshot().state, "stopped");
  await h.manager.start();
  assert.equal(h.spawns(), 1);
});

test("unexpected child exit is visible and does not cause an uncontrolled restart loop", async () => {
  const h = harness();
  await h.manager.start();
  h.exit();
  assert.equal(h.manager.snapshot().state, "error");
  assert.equal(h.manager.snapshot().available, false);
  assert.equal(h.spawns(), 1);
});

test("desktop endpoint handles IPv6 and rejects unsafe remote URL components", () => {
  const config = { ...loadConfig(), bindHost: "::1", port: 3000 };
  assert.equal(desktopEndpoint(config), "http://[::1]:3000");
  assert.equal(desktopEndpoint(config, "https://example.com/gateway/"), "https://example.com/gateway");
  for (const url of ["file:///tmp/test", "https://key@example.com", "https://example.com/?key=secret"]) {
    assert.throws(() => desktopEndpoint(config, url));
  }
});

test("desktop resolves all file paths before changing the child working directory", () => {
  const config = resolveDesktopConfig({ ...loadConfig(), runtimeDir: ".runtime", authCacheDir: ".runtime/auth", modelFiles: { demo: "models.json" }, modelFileFallbacks: { demo: ["cache/models.json"] } });
  for (const path of [config.runtimeDir, config.authCacheDir, config.modelCacheDir, config.channelsFile, config.apiKeysFile, config.metricsFile, config.modelFiles!.demo, ...config.modelFileFallbacks!.demo!]) {
    assert.equal(isAbsolute(path), true);
  }
});

test("desktop lock excludes a second owner and release does not delete a replacement", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-lock-"));
  try {
    const owner = acquireDesktopLease(directory);
    assert.equal(owner.acquired, true);
    assert.equal(acquireDesktopLease(directory).acquired, false);
    writeFileSync(join(directory, "desktop.lock"), "replacement");
    owner.release();
    assert.equal(readFileSync(join(directory, "desktop.lock"), "utf8"), "replacement");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("desktop lock can recover a known dead owner", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-lock-"));
  try {
    writeFileSync(join(directory, "desktop.lock"), "2147483647\nstale\n");
    const lease = acquireDesktopLease(directory);
    assert.equal(lease.acquired, true);
    lease.release();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("desktop logs redact credential fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "gateway-log-"));
  try {
    const log = desktopLogger(directory);
    log.write("Authorization: Bearer secret-value\nCookie: session=secret-cookie");
    const text = readFileSync(join(log.directory, "desktop.log"), "utf8");
    assert.ok(!text.includes("secret-value"));
    assert.ok(!text.includes("secret-cookie"));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("health probes distinguish foreign servers from a gateway needing authentication", async () => {
  let foreign = true;
  const server = createServer((req, res) => {
    if (foreign) { res.end("ordinary server"); return; }
    const ready = req.url === "/health/ready";
    res.writeHead(ready ? 503 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ service: "llm-gateway", mode: ready ? "ready" : "live", instanceId: "test", authenticated: false }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await probeLive(endpoint)).kind, "foreign");
    foreign = false;
    assert.deepEqual(await probeLive(endpoint), { kind: "gateway", instanceId: "test" });
    const status = await probeReady(endpoint);
    assert.equal(status.ready, false);
    assert.match(status.detail, /认证/);
  } finally { await closeGatewayServer(server, () => {}); }
});

test("graceful shutdown drains active responses before flushing", async () => {
  const received = deferred<void>();
  let finish = () => {};
  const server = createServer((_req, res) => {
    res.write("begin");
    finish = () => res.end("end");
    received.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = fetch(`http://127.0.0.1:${address.port}`).then((res) => res.text());
  await received.promise;
  let flushed = false;
  const closing = closeGatewayServer(server, () => { flushed = true; }, 1000);
  assert.equal(flushed, false);
  finish();
  assert.equal(await response, "beginend");
  assert.equal(await closing, true);
  assert.equal(flushed, true);
});

test("health probe deadline bounds a server that accepts but never responds", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(requestHealth(`http://127.0.0.1:${address.port}/health/live`, 20), /超时/);
  } finally { server.closeAllConnections(); await closeGatewayServer(server, () => {}); }
});

test("shutdown deadline closes a stuck stream and still flushes", async () => {
  const received = deferred<void>();
  const server = createServer((_req, res) => { res.write("partial"); received.resolve(); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = fetch(`http://127.0.0.1:${address.port}`).then((res) => res.text()).catch(() => "closed");
  await received.promise;
  let flushed = 0;
  assert.equal(await closeGatewayServer(server, () => { flushed++; }, 20), false);
  assert.equal(await response, "closed");
  assert.equal(flushed, 1);
});
