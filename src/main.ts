import { execFile, spawn, type ChildProcess } from "node:child_process";
import { loadConfig } from "./config.js";
import {
  exportDeepSeekHarness,
  printModels,
  runDoctor
} from "./management.js";
import { startGateway } from "./server.js";

type GatewayMode = "serve" | "desktop" | "doctor" | "models" | "export";

function printUsage(): void {
  console.log(`用法: llm-gateway <模式>

模式:
  serve    仅启动 OpenAI 兼容网关（默认）
  desktop  启动网关并打开 Web 控制台
  doctor   检查配置、认证缓存和模型目录
  models   以 OpenAI /v1/models JSON 输出当前模型目录
  export   导出接入客户端所需的配置片段

示例:
  llm-gateway serve
  llm-gateway desktop
  llm-gateway doctor
  llm-gateway models
  llm-gateway export deepseek-harness`);
}

function resolveMode(argument: string | undefined): GatewayMode {
  if (!argument || argument === "serve") return "serve";
  if (argument === "desktop") return "desktop";
  if (argument === "doctor") return "doctor";
  if (argument === "models") return "models";
  if (argument === "export") return "export";
  if (argument === "--help" || argument === "-h") {
    printUsage();
    process.exit(0);
  }

  console.error(`未知模式: ${argument}`);
  printUsage();
  process.exit(2);
}

// Keep the HTTP loop in a dedicated child process for the desktop launch mode.
function startManagedGateway(): ChildProcess {
  const child = spawn(process.execPath, ["serve"], {
    env: process.env,
    stdio: "inherit"
  });

  child.on("error", (error) => {
    console.error(`无法启动 Gateway 子进程: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (code !== 0 || signal) {
      console.error(
        `Gateway 子进程已退出（code=${String(code)}, signal=${String(signal)}）`
      );
    }
  });

  return child;
}

function attachGatewayLifecycle(child: ChildProcess): void {
  let shuttingDown = false;

  const stopGateway = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (!child.killed) child.kill("SIGTERM");
  };

  process.once("exit", stopGateway);
  process.once("SIGINT", () => {
    stopGateway();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopGateway();
    process.exit(143);
  });
}

function webUiUrl(): string {
  const configured = process.env.GATEWAY_URL?.trim();
  if (configured) return `${configured.replace(/\/$/, "")}/ui`;
  const config = loadConfig();
  const host = config.bindHost === "0.0.0.0" || config.bindHost === "::"
    ? "127.0.0.1"
    : config.bindHost;
  return `http://${host}:${config.port}/ui`;
}

function openWebUi(): void {
  const url = webUiUrl();
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  execFile(command, args, (error) => {
    if (error) console.error(`无法打开 Web 控制台，请手动访问: ${url}`);
  });
}

function runWebMode(): void {
  const child = startManagedGateway();
  attachGatewayLifecycle(child);
  console.log("Web 模式已启动：控制台和 Gateway 由同一命令统一管理");
  setTimeout(openWebUi, 500);
}

async function runMode(): Promise<void> {
  const mode = resolveMode(process.argv[2]);
  if (mode === "serve") {
    startGateway();
    return;
  }
  if (mode === "desktop") {
    runWebMode();
    return;
  }
  if (mode === "doctor") {
    process.exit(await runDoctor());
    return;
  }
  if (mode === "models") {
    await printModels();
    return;
  }

  if (process.argv[3] !== "deepseek-harness") {
    console.error("export 目前支持: deepseek-harness");
    printUsage();
    process.exit(2);
  }
  await exportDeepSeekHarness();
}

void runMode().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`命令执行失败: ${message}`);
  process.exit(1);
});
