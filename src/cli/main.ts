import {
  exportDeepSeekHarness,
  printModels,
  runDoctor
} from "./management.js";
import { runDesktop } from "./desktop.js";
import { startGateway } from "../transport/http/server.js";

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
  const mode = resolveMode(process.argv[2]);
  if (mode === "serve") {
    startGateway();
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
