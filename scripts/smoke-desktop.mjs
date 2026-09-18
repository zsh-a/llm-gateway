import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Requires a logged-in macOS GUI session and a built native executable.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binary = resolve(root, process.env.DESKTOP_BINARY || "dist/llm-gateway");
if (process.platform !== "darwin" || !existsSync(binary)) {
  throw new Error("请在 macOS 图形会话中先执行 npm run build:gateway");
}
mkdirSync(join(root, ".build"), { recursive: true });
const directory = mkdtempSync(join(root, ".build", "desktop-smoke-"));
const processes = [];
const delay = (ms) => new Promise((done) => setTimeout(done, ms));

async function waitFor(check, label, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error("等待超时：" + label);
}

function runtime(name) {
  const path = join(directory, name);
  mkdirSync(path);
  writeFileSync(join(path, "desktop-preferences.json"), '{"openOnStartup":false}');
  return path;
}

function start(path, port, remote = "") {
  const env = {
    ...process.env, RUNTIME_DIR: path, PORT: String(port), BIND_HOST: "127.0.0.1",
    MODEL_DISCOVERY: "false", GATEWAY_URL: remote, PROXY_API_KEY: "", PROXY_ADMIN_KEY: ""
  };
  delete env.TRAY_ICON_PATH;
  delete env.LLM_GATEWAY_RESOLVED_CONFIG;
  const child = spawn(binary, ["desktop"], { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const launched = { child, exit: null, output: "" };
  child.stdout.on("data", (chunk) => { launched.output += String(chunk); });
  child.stderr.on("data", (chunk) => { launched.output += String(chunk); });
  child.on("exit", (code, signal) => { launched.exit = { code, signal }; });
  processes.push(launched);
  return launched;
}

function log(path) {
  const file = join(path, "logs", "desktop.log");
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

async function stop(launched) {
  launched.child.kill("SIGTERM");
  await waitFor(() => launched.exit, "桌面正常退出");
  assert.equal(launched.exit.code, 0, launched.output);
}

const external = createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ service: "llm-gateway", mode: req.url.includes("ready") ? "ready" : "live", status: "ok", instanceId: "external", authenticated: true }));
});
let succeeded = false;
try {
  // Let the OS allocate ports rather than touching the user's normal gateway.
  const reservation = createServer();
  await new Promise((done) => reservation.listen(0, "127.0.0.1", done));
  const localPort = reservation.address().port;
  await new Promise((done) => reservation.close(done));
  const local = runtime("local");
  const desktop = start(local, localPort);
  const endpoint = `http://127.0.0.1:${localPort}`;
  await waitFor(async () => {
    if (desktop.exit) throw new Error(desktop.output);
    try {
      const response = await fetch(endpoint + "/health/live", { signal: AbortSignal.timeout(300) });
      return Boolean((await response.json()).instanceId);
    } catch { return false; }
  }, "本地服务可访问");
  await waitFor(() => log(local).includes("managed degraded"), "未认证状态反馈");

  const duplicate = start(local, localPort);
  await waitFor(() => duplicate.exit, "重复实例退出", 5000);
  assert.equal(duplicate.exit.code, 0);
  assert.match(duplicate.output, /已在运行/);
  await stop(desktop);
  assert.equal(existsSync(join(local, "desktop.lock")), false);
  await assert.rejects(fetch(endpoint + "/health/live", { signal: AbortSignal.timeout(300) }));
  writeFileSync(join(local, "desktop.lock"), "2147483647\nstale\n");
  const recovered = start(local, localPort);
  await waitFor(async () => {
    if (recovered.exit) throw new Error("遗留锁恢复失败：" + recovered.output);
    try { return (await fetch(endpoint + "/health/live", { signal: AbortSignal.timeout(300) })).ok; }
    catch { return false; }
  }, "异常退出遗留锁恢复");
  await stop(recovered);
  console.log("✓ 本地启动、状态反馈、单实例和退出清理");

  await new Promise((done) => external.listen(0, "127.0.0.1", done));
  const externalPort = external.address().port;
  const externalEndpoint = `http://127.0.0.1:${externalPort}`;
  for (const mode of ["remote", "external"]) {
    const path = runtime(mode);
    const client = start(path, externalPort, mode === "remote" ? externalEndpoint : "");
    await waitFor(() => log(path).includes(mode + " running"), mode + " 就绪");
    await stop(client);
    assert.equal((await fetch(externalEndpoint + "/health/live")).status, 200);
  }
  console.log("✓ 远程及已有本地网关只连接、不误启停");
  succeeded = true;
} finally {
  external.closeAllConnections();
  external.close();
  // Only process groups created by this test, never a user's existing service.
  for (const { child, output } of processes) {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* Already gone. */ }
    if (!succeeded && output) console.error(output);
  }
  if (succeeded) rmSync(directory, { recursive: true, force: true });
  else console.error("诊断日志保留于：" + directory);
}
