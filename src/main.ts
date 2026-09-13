import { spawn, type ChildProcess } from "node:child_process";
import { startDashboard } from "./dashboard.js";
import { startGateway } from "./server.js";

type GatewayMode = "serve" | "desktop";

function printUsage(): void {
  console.log(`用法: llm-gateway <模式>

模式:
  serve    仅启动 OpenAI 兼容网关（默认）
  desktop  启动网关并打开 Perry 原生控制面板

示例:
  llm-gateway serve
  llm-gateway desktop`);
}

function resolveMode(argument: string | undefined): GatewayMode {
  if (!argument || argument === "serve") return "serve";
  if (argument === "desktop") return "desktop";
  if (argument === "--help" || argument === "-h") {
    printUsage();
    process.exit(0);
  }

  console.error(`未知模式: ${argument}`);
  printUsage();
  process.exit(2);
}

// Perry's macOS AppKit loop and node:http currently use different async pumps.
// Keep the HTTP loop in a normal Perry process while this process owns the UI.
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

function runDesktopMode(): void {
  const child = startManagedGateway();
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

  console.log("桌面模式已启动：控制面板和 Gateway 由同一命令统一管理");
  startDashboard();
}

const mode = resolveMode(process.argv[2]);
if (mode === "serve") {
  startGateway();
} else {
  runDesktopMode();
}
