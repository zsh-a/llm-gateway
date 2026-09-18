import {
  exportDeepSeekHarness,
  printModels,
  runDoctor
} from "./management.js";
import { runDesktop } from "./desktop.js";
import { requestHealth } from "./desktop-runtime.js";
import { startGateway, stopGateway } from "../transport/http/server.js";

type GatewayMode = "serve" | "desktop" | "doctor" | "models" | "export";

function printUsage(): void {
  console.log(`用法: llm-gateway <模式>

模式:
  serve    仅启动 OpenAI 兼容网关（默认）
  desktop  启动网关、系统托盘并打开 Web 控制台
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

function isPackagedDesktopLaunch(): boolean {
  return process.platform === "darwin" &&
    process.execPath.includes(".app/Contents/MacOS/");
}

function resolveMode(argument: string | undefined): GatewayMode {
  // LaunchServices starts an .app without the CLI arguments that `npm run
  // desktop` supplies. Treat the packaged macOS executable as desktop mode so
  // Finder/dock launches get the tray, managed Gateway, and console together.
  if (!argument) return isPackagedDesktopLaunch() ? "desktop" : "serve";
  if (argument === "serve") return "serve";
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

async function runMode(): Promise<void> {
  // Internal desktop helper. App() owns the native UI loop, so bounded network
  // probes run in a short-lived CLI process instead of blocking tray actions.
  if (process.argv[2] === "desktop-probe") {
    const url = new URL(process.argv[3]);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
      (!url.pathname.endsWith("/health/live") && !url.pathname.endsWith("/health/ready"))) {
      throw new Error("无效的健康检查地址");
    }
    const timeout = Math.min(5000, Math.max(100, Number(process.argv[4]) || 1500));
    const result = await requestHealth(url.toString(), timeout);
    console.log(JSON.stringify(result));
    return;
  }
  const mode = resolveMode(process.argv[2]);
  if (mode === "serve") {
    const server = startGateway();
    server.once("error", (error) => {
      console.error("Gateway 无法监听：" + error.message);
      process.exit(1);
    });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void stopGateway().then((graceful) => process.exit(graceful ? 0 : 1)).catch((error) => {
        console.error("Gateway 关闭失败：" + String(error));
        process.exit(1);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    return;
  }
  if (mode === "desktop") {
    runDesktop();
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
