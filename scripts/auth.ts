#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

import {
  asRecord,
  credentialHeaders,
  AuthStore,
  channelAuthRef,
  defaultCaCertFile,
  getProvider,
  getProviders,
  loadAuthConfig,
  type AuthHeaders,
  type AuthProvider
} from "./auth-support.js";

interface FlowRequest {
  method?: unknown;
  host?: unknown;
  pretty_host?: unknown;
  path?: unknown;
  url?: unknown;
  headers?: unknown;
}

interface ManagedProcess {
  label: string;
  child: ChildProcess;
  exited: boolean;
  error: Error | null;
}

interface BootstrapConfig {
  mitmUrl: string;
  mitmAuth: string;
  mitmCommand: string;
  proxyHost: string;
  proxyPort: number;
  webHost: string;
  webPort: number;
  webPassword: string;
  clientArgs: string[];
  ignoreCertificateErrors: boolean;
  caCertFile: string;
  proxyBypass: string;
  timeoutMs: number;
}

interface AuthOptions {
  providerIds: string[];
  channelId: string;
  force: boolean;
  noClient: boolean;
}

let stopping = false;

function env(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function jsonStringArrayEnv(name: string): string[] {
  const value = process.env[name];
  if (!value || !value.trim()) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function bootstrapConfig(): BootstrapConfig {
  const webHost = env("MITM_WEB_HOST", "127.0.0.1");
  const webPort = positiveInt("MITM_WEB_PORT", 8081);
  const webPassword = env("MITM_WEB_PASSWORD", "123456");
  return {
    mitmUrl: env("MITM_URL", "http://" + webHost + ":" + webPort + "/flows"),
    mitmAuth: env("MITM_AUTH", "Bearer " + webPassword),
    mitmCommand: env("MITM_COMMAND", "mitmweb"),
    proxyHost: env("MITM_PROXY_HOST", "127.0.0.1"),
    proxyPort: positiveInt("MITM_PROXY_PORT", 8080),
    webHost,
    webPort,
    webPassword,
    clientArgs: jsonStringArrayEnv("CLIENT_ARGS_JSON"),
    ignoreCertificateErrors: booleanEnv("CLIENT_IGNORE_CERT_ERRORS", false),
    caCertFile: env(
      "MITM_CA_CERT",
      defaultCaCertFile()
    ),
    proxyBypass: env("CLIENT_PROXY_BYPASS", "<local>;127.0.0.1;localhost"),
    timeoutMs: positiveInt("AUTH_TIMEOUT_MS", 120000)
  };
}

function parseOptions(args: string[]): AuthOptions {
  const providerIds: string[] = [];
  let channelId = "";
  let force = false;
  let noClient = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--no-client") {
      noClient = true;
      continue;
    }
    if (arg === "--channel") {
      const value = args[index + 1];
      if (!value) throw new Error("--channel 需要一个 Channel ID");
      channelId = value.trim();
      index += 1;
      continue;
    }
    if (arg === "--provider" || arg === "-p") {
      const value = args[index + 1];
      if (!value) throw new Error("--provider 需要一个 Provider ID");
      providerIds.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
      index += 1;
    }
  }

  if (channelId && providerIds.length !== 1) {
    throw new Error("--channel 必须和一个 --provider 一起使用");
  }

  return {
    providerIds: providerIds.length > 0
      ? providerIds
      : getProviders().map((provider) => provider.id),
    channelId,
    force,
    noClient
  };
}

function printHelp(): void {
  console.log("认证引导工具\n\n" +
    "用法:\n" +
    "  npm run auth                         依次认证所有已注册 Provider\n" +
    "  npm run auth -- --provider workbuddy 只认证 WorkBuddy\n" +
    "  npm run auth -- --provider mimo --force\n" +
    "  npm run auth -- --provider mimo --channel mimo-secondary\n" +
    "  npm run auth -- --no-client           使用已手动启动的客户端\n\n" +
    "流程:\n" +
    "  1. 启动 mitmweb\n" +
    "  2. 启动对应桌面客户端并注入代理参数\n" +
    "  3. 等待成功的认证或模型请求\n" +
    "  4. 将认证头保存到 .runtime/auth/<provider-or-channel>.json\n" +
    "  5. 退出桌面客户端和 mitmweb\n\n" +
    "认证完成后，网关只读取缓存，不依赖 mitmproxy 或桌面客户端。\n");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function startProcess(
  command: string,
  args: string[],
  label: string,
  environment: NodeJS.ProcessEnv = process.env
): ManagedProcess {
  const managed: ManagedProcess = {
    label,
    child: spawn(command, args, {
      env: environment,
      stdio: "inherit"
    }),
    exited: false,
    error: null
  };

  managed.child.once("error", (error) => {
    managed.error = error;
    console.error("[" + label + "] 启动失败: " + error.message);
  });
  managed.child.once("exit", () => {
    managed.exited = true;
  });
  return managed;
}

function stopProcess(process: ManagedProcess): void {
  if (!process.exited) process.child.kill("SIGTERM");
}

async function stopAll(processes: ManagedProcess[]): Promise<void> {
  for (const process of processes) stopProcess(process);
  await delay(300);
  for (const process of processes) {
    if (!process.exited) process.child.kill("SIGKILL");
  }
}

async function waitForReady(
  config: BootstrapConfig,
  mitm: ManagedProcess
): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!stopping && Date.now() < deadline) {
    if (mitm.error) throw mitm.error;
    if (mitm.exited) throw new Error("mitmweb 提前退出");
    try {
      const response = await fetch(config.mitmUrl, {
        headers: { Authorization: config.mitmAuth }
      });
      if (response.ok) return;
    } catch {
      // Keep polling while mitmweb is starting.
    }
    await delay(250);
  }
  throw new Error("mitmweb 未在 10000ms 内就绪: " + config.mitmUrl);
}

function headerEntries(value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) {
    const entries: Array<[string, string]> = [];
    for (const item of value) {
      if (Array.isArray(item) && item.length >= 2) {
        entries.push([String(item[0]), String(item[1])]);
      }
    }
    return entries;
  }

  const record = asRecord(value);
  const entries: Array<[string, string]> = [];
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (item !== undefined && item !== null) entries.push([key, String(item)]);
  }
  return entries;
}

function wildcardMatch(value: string, pattern: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return value.startsWith(pattern.slice(0, -1));
  return value === pattern;
}

function hostFromRequest(request: FlowRequest): string {
  const direct = request.host ?? request.pretty_host;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim().toLowerCase().split(":")[0];
  }
  if (typeof request.url === "string") {
    try {
      return new URL(request.url).hostname.toLowerCase();
    } catch {
      return "";
    }
  }
  return "";
}

function pathFromRequest(request: FlowRequest): string {
  if (typeof request.path === "string" && request.path) {
    return request.path.split("?", 1)[0];
  }
  if (typeof request.url === "string") {
    try {
      return new URL(request.url).pathname;
    } catch {
      return "";
    }
  }
  return "";
}

function matchesHost(host: string, patterns: string[]): boolean {
  return patterns.length === 0 || patterns.some((pattern) => {
    const normalized = pattern.toLowerCase();
    return wildcardMatch(host, normalized) || host.endsWith("." + normalized);
  });
}

function matchesPath(path: string, patterns: string[]): boolean {
  return patterns.length === 0 ||
    patterns.some((pattern) => wildcardMatch(path, pattern));
}

function capturedHeaders(
  request: FlowRequest,
  configuredHeaders: string[]
): AuthHeaders | null {
  const headers: AuthHeaders = {};
  const cookies: string[] = [];

  for (const [key, value] of headerEntries(request.headers)) {
    const lowerKey = key.toLowerCase();
    const captured = configuredHeaders.some((pattern) => (
      wildcardMatch(lowerKey, pattern.toLowerCase())
    ));
    if (!captured) continue;
    if (lowerKey === "cookie") cookies.push(value);
    else headers[key] = value;
  }

  if (cookies.length > 0) headers.cookie = cookies.join("; ");
  return credentialHeaders(headers);
}

async function findAuth(
  config: BootstrapConfig,
  provider: AuthProvider
): Promise<AuthHeaders | null> {
  const response = await fetch(config.mitmUrl, {
    headers: { Authorization: config.mitmAuth }
  });
  if (!response.ok) return null;

  const flows: unknown = await response.json();
  if (!Array.isArray(flows)) return null;

  for (let index = flows.length - 1; index >= 0; index -= 1) {
    const flow = asRecord(flows[index]);
    const request = asRecord(flow.request) as FlowRequest;
    const responseInfo = asRecord(flow.response);
    const statusCode = Number(responseInfo.status_code);
    const method = String(request.method ?? "").toUpperCase();
    if (
      (provider.authMethods.length === 0 || provider.authMethods.includes(method)) &&
      statusCode >= 200 &&
      statusCode < 300 &&
      matchesHost(hostFromRequest(request), provider.authHosts) &&
      matchesPath(pathFromRequest(request), provider.authPaths)
    ) {
      const headers = capturedHeaders(request, provider.captureHeaders);
      if (headers) return headers;
    }
  }
  return null;
}

function clientArgs(config: BootstrapConfig): string[] {
  const extra = [...config.clientArgs];
  if (
    config.ignoreCertificateErrors &&
    !extra.includes("--ignore-certificate-errors")
  ) {
    extra.push("--ignore-certificate-errors");
  }
  const proxy = config.proxyHost + ":" + config.proxyPort;
  return [
    ...extra,
    "--proxy-server=http=" + proxy + ";https=" + proxy,
    "--proxy-bypass-list=" + config.proxyBypass
  ];
}

function nodeProxyBypass(value: string): string {
  return value
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter((item) => item && item !== "<local>")
    .join(",");
}

function clientEnvironment(config: BootstrapConfig): NodeJS.ProcessEnv {
  const proxy = "http://" + config.proxyHost + ":" + config.proxyPort;
  const noProxy = nodeProxyBypass(config.proxyBypass);
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    ALL_PROXY: proxy,
    http_proxy: proxy,
    https_proxy: proxy,
    all_proxy: proxy,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_USE_ENV_PROXY: "1"
  };

  if (config.caCertFile && existsSync(config.caCertFile)) {
    environment.NODE_EXTRA_CA_CERTS = config.caCertFile;
  }
  if (config.ignoreCertificateErrors) {
    environment.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }
  return environment;
}

function resolveClientBinary(provider: AuthProvider): string {
  const configured = process.env.CLIENT_BIN?.trim();
  if (configured) {
    if (configured.includes("/") && !existsSync(configured)) {
      throw new Error(
        provider.name + " 的 CLIENT_BIN 不存在: " + configured
      );
    }
    return configured;
  }

  const binary = provider.clientCandidates.find((candidate) => (
    !candidate.includes("/") || existsSync(candidate)
  ));
  if (binary) return binary;

  const candidates = provider.clientCandidates.length > 0
    ? provider.clientCandidates.join(", ")
    : "未配置默认入口";
  throw new Error(
    provider.name + " 客户端入口不存在。已尝试: " + candidates +
    "；可设置 CLIENT_BIN，或使用 --no-client 连接已启动的客户端"
  );
}

async function captureProvider(
  config: BootstrapConfig,
  provider: AuthProvider,
  noClient: boolean
): Promise<AuthHeaders> {
  let client: ManagedProcess | null = null;
  if (!noClient) {
    const binary = resolveClientBinary(provider);
    client = startProcess(
      binary,
      clientArgs(config),
      provider.id + "-client",
      clientEnvironment(config)
    );
  }

  try {
    const deadline = Date.now() + config.timeoutMs;
    while (!stopping && Date.now() < deadline) {
      if (client?.error) throw client.error;
      if (client?.exited) {
        throw new Error(provider.name + " 客户端提前退出");
      }
      try {
        const headers = await findAuth(config, provider);
        if (headers) return headers;
      } catch {
        // The flow endpoint can briefly be unavailable while the client starts.
      }
      await delay(500);
    }
    throw new Error(provider.name + " 未捕获到成功的模型请求，请确认客户端已登录");
  } finally {
    if (client) stopProcess(client);
  }
}

function startMitm(config: BootstrapConfig): ManagedProcess {
  return startProcess(config.mitmCommand, [
    "--listen-host",
    config.proxyHost,
    "--listen-port",
    String(config.proxyPort),
    "--web-host",
    config.webHost,
    "--web-port",
    String(config.webPort),
    "--set",
    "web_password=" + config.webPassword,
    "--set",
    "web_open_browser=false"
  ], "mitmweb");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const options = parseOptions(args);
  const config = bootstrapConfig();
  const gatewayConfig = loadAuthConfig();
  const store = new AuthStore(gatewayConfig.authCacheDir);
  const providers: AuthProvider[] = [];
  for (const id of options.providerIds) {
    const provider = getProvider(id);
    if (!provider) throw new Error("未知 Provider: " + id);
    providers.push(provider);
  }

  if (options.channelId) {
    channelAuthRef(gatewayConfig.channelsFile, options.channelId, providers[0].id);
  }

  const authRef = options.channelId
    ? channelAuthRef(gatewayConfig.channelsFile, options.channelId, providers[0].id)
    : "";
  const pendingProviders = providers.filter((provider) => (
    options.force || !store.get(authRef || provider.id)
  ));
  if (pendingProviders.length === 0) {
    for (const provider of providers) {
      console.log(
        "[" + provider.name + "] 已存在认证缓存，跳过（使用 --force 重新捕获）"
      );
    }
    return;
  }

  const processes: ManagedProcess[] = [];
  const onSignal = (): void => {
    stopping = true;
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    const mitm = startMitm(config);
    processes.push(mitm);
    await waitForReady(config, mitm);

    for (const provider of pendingProviders) {
      console.log("[" + provider.name + "] 请保持桌面客户端登录并等待模型请求...");
      const headers = await captureProvider(config, provider, options.noClient);
      store.save(authRef || provider.id, headers);
      console.log(
        "[" + provider.name + "] 认证已保存到 " +
        gatewayConfig.authCacheDir + "/" + (authRef || provider.id) + ".json"
      );
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await stopAll(processes);
  }
}

main().catch((error: unknown) => {
  if (stopping) return;
  const message = error instanceof Error ? error.message : String(error);
  console.error("认证引导失败: " + message);
  process.exitCode = 1;
});
