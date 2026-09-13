#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { loadConfig, type AppConfig } from "../src/config.js";

interface ManagedProcess {
  label: string;
  child: ChildProcess;
  critical: boolean;
  exited: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
}

interface LaunchOptions {
  startMitm: boolean;
  startDesktop: boolean;
}

let stopping = false;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseOptions(args: string[]): LaunchOptions {
  return {
    startMitm:
      !args.includes("--no-mitm") && booleanEnv("MIMO_AUTO_START_MITM", true),
    startDesktop:
      !args.includes("--no-desktop") &&
      (args.includes("--desktop") || booleanEnv("MIMO_AUTO_START_DESKTOP", false))
  };
}

function printHelp(): void {
  console.log(`MiMo 统一启动器

用法:
  npm run launch                    启动 mitmweb + mimo-server
  npm run launch:desktop            同时启动配置好的客户端
  node dist/scripts/launch.js --no-mitm
                                      使用 MIMO_COOKIE / cookie.txt
  node dist/scripts/launch.js --no-desktop
                                      不启动客户端

环境变量:
  MIMO_CLIENT_BIN          客户端可执行文件路径
  MIMO_CLIENT_ARGS_JSON    额外客户端参数，例如 ["--some-flag"]
  MIMO_AUTO_START_DESKTOP 是否默认启动客户端
  MIMO_AUTO_START_MITM    是否默认启动 mitmweb
  MIMO_SERVER_BIN         服务端可执行文件路径
  RUNTIME_LOG_DIR          子进程日志目录，默认 ./.runtime
`);
}

function logFile(config: AppConfig, name: string): string {
  mkdirSync(config.runtimeLogDir, { recursive: true });
  return resolve(config.runtimeLogDir, `${name}.log`);
}

function executable(value: string): string {
  if (isAbsolute(value) || value.includes("/")) return resolve(value);
  return value;
}

function startProcess(
  command: string,
  args: string[],
  log: string,
  label: string,
  critical: boolean
): ManagedProcess {
  mkdirSync(dirname(log), { recursive: true });
  const logFd = openSync(log, "a");
  let child: ChildProcess;
  try {
    child = spawn(executable(command), args, {
      env: process.env,
      stdio: ["ignore", logFd, logFd]
    });
  } finally {
    closeSync(logFd);
  }

  const managed: ManagedProcess = {
    label,
    child,
    critical,
    exited: false,
    exitCode: null,
    signal: null,
    error: null
  };

  child.once("error", (error) => {
    managed.error = error;
    console.error(`[${label}] 启动失败: ${error.message}`);
  });
  child.once("exit", (code, signal) => {
    managed.exited = true;
    managed.exitCode = code;
    managed.signal = signal;
    if (!stopping) {
      const reason = signal ? `signal=${signal}` : `exitCode=${code}`;
      console.warn(`[${label}] 已退出 (${reason})`);
    }
  });

  console.log(`[${label}] 已启动 pid=${child.pid ?? "?"}`);
  console.log(`[${label}] 日志: ${log}`);
  return managed;
}

function processFailure(process: ManagedProcess): string | null {
  if (process.error) return process.error.message;
  if (!process.exited) return null;
  if (process.signal) return `signal=${process.signal}`;
  return `exitCode=${process.exitCode}`;
}

async function probe(
  url: string,
  headers: Record<string, string>
): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 1000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function waitFor(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  label: string,
  process?: ManagedProcess
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!stopping && Date.now() < deadline) {
    if (process) {
      const failure = processFailure(process);
      if (failure) {
        throw new Error(`${label} 启动失败: ${failure}`);
      }
    }
    if (await probe(url, headers)) return;
    await delay(250);
  }
  if (stopping) throw new Error("启动已取消");
  throw new Error(`${label} 未在 ${timeoutMs}ms 内就绪: ${url}`);
}

function proxyArgs(config: AppConfig): string[] {
  const proxy = `${config.mitmProxyHost}:${config.mitmProxyPort}`;
  return [
    `--proxy-server=http=${proxy};https=${proxy}`,
    `--proxy-bypass-list=${config.clientProxyBypass}`
  ];
}

function clientArgs(config: AppConfig): string[] {
  const managedSwitches = [
    "--proxy-server",
    "--proxy-bypass-list",
    "--no-proxy-server"
  ];
  const extra: string[] = [];

  for (let index = 0; index < config.clientArgs.length; index += 1) {
    const arg = config.clientArgs[index];
    const separateValue = managedSwitches.includes(arg);
    const managed = separateValue ||
      managedSwitches.some((switchName) => arg.startsWith(`${switchName}=`));
    if (managed) {
      if (separateValue) index += 1;
      continue;
    }
    extra.push(arg);
  }

  return [...extra, ...proxyArgs(config)];
}

function startMitm(config: AppConfig): ManagedProcess {
  const args = [
    "--listen-host",
    config.mitmProxyHost,
    "--listen-port",
    String(config.mitmProxyPort),
    "--web-host",
    config.mitmWebHost,
    "--web-port",
    String(config.mitmWebPort),
    "--set",
    `web_password=${config.mitmWebPassword}`,
    "--set",
    "web_open_browser=false"
  ];
  return startProcess(
    config.mitmCommand,
    args,
    logFile(config, "mitmweb"),
    "mitmweb",
    true
  );
}

function startServer(config: AppConfig): ManagedProcess {
  const configured = process.env.MIMO_SERVER_BIN;
  const binary = configured
    ? executable(configured)
    : resolve(process.cwd(), "dist/mimo-server");
  if (binary.includes("/") && !existsSync(binary)) {
    throw new Error(`找不到服务端产物: ${binary}，请先运行 npm run build`);
  }
  return startProcess(
    binary,
    [],
    logFile(config, "mimo-server"),
    "mimo-server",
    true
  );
}

function startDesktop(config: AppConfig): ManagedProcess {
  if (!config.clientBinary) {
    throw new Error("未配置客户端路径，请设置 MIMO_CLIENT_BIN，或仅启动服务端");
  }
  const binary = executable(config.clientBinary);
  if (binary.includes("/") && !existsSync(binary)) {
    throw new Error(`找不到客户端可执行文件: ${binary}`);
  }
  return startProcess(
    binary,
    clientArgs(config),
    logFile(config, "client"),
    "client",
    false
  );
}

async function stopAll(processes: ManagedProcess[]): Promise<void> {
  for (let index = processes.length - 1; index >= 0; index -= 1) {
    const process = processes[index];
    if (!process.exited) process.child.kill("SIGTERM");
  }

  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && processes.some((process) => !process.exited)) {
    await delay(50);
  }

  for (const process of processes) {
    if (!process.exited) process.child.kill("SIGKILL");
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    return;
  }

  const config = loadConfig();
  const options = parseOptions(args);
  const processes: ManagedProcess[] = [];
  const onSignal = (): void => {
    stopping = true;
  };

  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    if (options.startMitm) {
      const mitm = startMitm(config);
      processes.push(mitm);
      await waitFor(
        config.mitmUrl,
        { Authorization: config.mitmAuth },
        10000,
        "mitmweb",
        mitm
      );
    }

    const server = startServer(config);
    processes.push(server);
    const healthHost =
      config.bindHost === "0.0.0.0" || config.bindHost === "::"
        ? "127.0.0.1"
        : config.bindHost;
    await waitFor(
      `http://${healthHost}:${config.port}/health`,
      {},
      10000,
      "mimo-server",
      server
    );

    if (options.startDesktop) processes.push(startDesktop(config));

    console.log("MiMo 统一运行环境已就绪");
    console.log(`- OpenAI API: http://${healthHost}:${config.port}/v1/chat/completions`);
    console.log(`- 认证状态: http://${healthHost}:${config.port}/health/auth`);
    if (options.startMitm) {
      console.log(`- 客户端代理: ${config.mitmProxyHost}:${config.mitmProxyPort}`);
      console.log(`- 凭证 API: ${config.mitmUrl}`);
    }

    while (!stopping) {
      await delay(1000);
      if (stopping) break;
      for (const process of processes) {
        if (!process.exited || !process.critical) continue;
        throw new Error(`${process.label} 已退出 (${processFailure(process)})`);
      }
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
  console.error(`统一启动失败: ${message}`);
  process.exitCode = 1;
});
