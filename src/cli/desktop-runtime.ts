import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { execFile } from "node:child_process";
import type { GatewayConfig } from "../app/config.js";
import type { LiveProbe } from "./gateway-manager.js";

export function resolveDesktopConfig(config: GatewayConfig): GatewayConfig {
  const modelFiles: { [providerId: string]: string } = {};
  for (const [provider, file] of Object.entries(config.modelFiles || {})) {
    modelFiles[provider] = file ? resolve(file) : "";
  }
  return {
    ...config, runtimeDir: resolve(config.runtimeDir),
    authCacheDir: resolve(config.authCacheDir), modelCacheDir: resolve(config.modelCacheDir),
    channelsFile: resolve(config.channelsFile), apiKeysFile: resolve(config.apiKeysFile),
    metricsFile: resolve(config.metricsFile), modelFiles
  };
}

export function desktopEndpoint(config: GatewayConfig, remote = ""): string {
  if (remote.trim()) {
    const url = new URL(remote.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error("GATEWAY_URL 必须是无凭证、查询参数和片段的 HTTP(S) 网关根地址");
    }
    return url.toString().replace(/\/+$/, "");
  }
  let host = config.bindHost;
  if (host === "0.0.0.0") host = "127.0.0.1";
  if (host === "::") host = "::1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${config.port}`;
}

export function requestHealth(url: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = url.startsWith("https:") ? httpsRequest : httpRequest;
    let finished = false;
    const timer = setTimeout(() => {
      finish(new Error("健康检查超时"));
      req.destroy();
    }, timeoutMs);
    function finish(error: Error | null, status = 0, text = ""): void {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) { reject(error); return; }
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text) as Record<string, unknown>; } catch { /* Foreign HTTP service. */ }
      resolve({ status, body: body || {} });
    }
    const req = request(url, { method: "GET", agent: false, headers: { Connection: "close" } }, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        text += chunk;
        if (text.length > 64 * 1024) {
          finish(null, response.statusCode || 0);
          req.destroy();
        }
      });
      response.on("end", () => finish(null, response.statusCode || 0, text));
      response.on("error", (error) => finish(error));
    });
    req.on("error", (error) => finish(error));
    req.end();
  });
}

/** Perry's App loop pumps JS callbacks but does not drive its current-thread
 * network runtime. A short-lived copy of the same binary performs bounded I/O
 * with the normal CLI event loop, without curl or a separate Node installation. */
function healthViaChild(url: string, timeoutMs: number): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("健康检查超时")); }, timeoutMs + 2000);
    const child = execFile(process.execPath, ["desktop-probe", url, String(timeoutMs)], { maxBuffer: 128 * 1024 }, (error, stdout) => {
      clearTimeout(timer);
      if (error) { reject(error); return; }
      try { resolve(JSON.parse(String(stdout))); } catch (failure) { reject(failure); }
    });
  });
}

export async function probeLive(endpoint: string, nativeDesktop = false): Promise<LiveProbe> {
  try {
    const response = nativeDesktop ? await healthViaChild(endpoint + "/health/live", 1500) : await requestHealth(endpoint + "/health/live", 1500);
    return {
      kind: response.status === 200 && response.body.service === "llm-gateway" && response.body.mode === "live"
        ? "gateway" : "foreign",
      instanceId: typeof response.body.instanceId === "string" ? response.body.instanceId : ""
    };
  } catch {
    return { kind: "offline", instanceId: "" };
  }
}

export async function probeReady(endpoint: string, nativeDesktop = false): Promise<{ ready: boolean; detail: string }> {
  const response = nativeDesktop ? await healthViaChild(endpoint + "/health/ready", 4000) : await requestHealth(endpoint + "/health/ready", 4000);
  if (response.body.service !== "llm-gateway" || response.body.mode !== "ready") {
    return { ready: false, detail: "服务可访问，就绪检查响应异常" };
  }
  const ready = response.status === 200 && response.body.status === "ok";
  return {
    ready,
    detail: ready ? "认证缓存与模型目录已就绪（不代表上游实时连通性）"
      : response.body.authenticated === false ? "尚无认证缓存，请在控制台查看认证指引"
        : "模型目录暂未就绪，请打开控制台检查"
  };
}

/** Private, bounded logs. Never write resolved configuration or credentials here. */
export function desktopLogger(runtimeDir: string): { directory: string; write: (message: string) => void } {
  const directory = join(runtimeDir, "logs");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = join(directory, "desktop.log");
  return {
    directory,
    write(message: string): void {
      try {
        if (existsSync(file) && statSync(file).size > 2 * 1024 * 1024) {
          const previous = file + ".1";
          if (existsSync(previous)) unlinkSync(previous);
          renameSync(file, previous);
        }
        const clean = message.replace(/(bearer\s+)\S+/gi, "$1[REDACTED]")
          .replace(/((?:authorization|cookie|api[-_]?key)\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]");
        const fd = openSync(file, "a", 0o600);
        try {
          chmodSync(file, 0o600);
          writeSync(fd, `${new Date().toISOString()} ${clean.slice(0, 8192)}\n`);
        } finally { closeSync(fd); }
      } catch {
        // A full/read-only disk must not break lifecycle callbacks.
      }
    }
  };
}

export interface DesktopLease { acquired: boolean; release: () => void; }

/** Exclusive creation prevents two live desktop owners for the same data directory.
 * Empty/malformed locks are left alone: another process may still be writing them. */
export function acquireDesktopLease(runtimeDir: string): DesktopLease {
  mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
  const file = join(runtimeDir, "desktop.lock");
  const owner = `${process.pid}\n${Date.now()}-${Math.random()}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try { chmodSync(file, 0o600); writeSync(fd, owner); } finally { closeSync(fd); }
      return {
        acquired: true,
        release(): void {
          try { if (readFileSync(file, "utf8") === owner) unlinkSync(file); } catch { /* Already released. */ }
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readFileSync(file, "utf8");
      const pid = Number(previous.split("\n")[0]);
      if (!Number.isInteger(pid) || pid <= 0) break;
      try { process.kill(pid, 0); break; } catch (failure) {
        if ((failure as NodeJS.ErrnoException).code !== "ESRCH") break;
      }
      // Recheck ownership before reclaiming a lock left by a dead process.
      if (readFileSync(file, "utf8") === previous) unlinkSync(file);
    }
  }
  return { acquired: false, release(): void {} };
}
