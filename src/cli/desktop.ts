import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  App,
  Window,
  Text,
  menuAddItem,
  menuAddSeparator,
  menuCreate,
  onActivate,
  onTerminate,
  trayAttachMenu,
  trayCreate,
  trayDestroy,
  trayOnClick,
  traySetTooltip,
  type Widget
} from "perry/ui";
import { loadConfig, type GatewayConfig } from "../app/config.js";

type GatewayManager = {
  start: () => void;
  stop: () => void;
  restart: () => void;
  isRunning: () => boolean;
};

type DesktopWindow = {
  setBody: (body: Widget) => void;
  show: () => void;
  close: () => void;
};

function defaultRuntimeDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "LLM Gateway");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return join(appData || join(homedir(), "AppData", "Roaming"), "LLM Gateway");
  }
  const dataHome = process.env.XDG_DATA_HOME?.trim();
  return join(dataHome || join(homedir(), ".local", "share"), "llm-gateway");
}

function loadDesktopConfig(): GatewayConfig {
  if (!process.env.RUNTIME_DIR?.trim()) {
    const localRuntime = resolve(process.cwd(), ".runtime");
    process.env.RUNTIME_DIR = existsSync(localRuntime)
      ? localRuntime
      : defaultRuntimeDir();
  }
  return loadConfig();
}

function webUiUrl(config: GatewayConfig): string {
  const configured = process.env.GATEWAY_URL?.trim();
  if (configured) return configured.replace(/\/$/, "") + "/ui";
  const host = config.bindHost === "0.0.0.0" || config.bindHost === "::"
    ? "127.0.0.1"
    : config.bindHost;
  return "http://" + host + ":" + String(config.port) + "/ui";
}

function openWebUi(config: GatewayConfig): void {
  const url = webUiUrl(config);
  const configured = process.platform === "darwin"
    ? process.env.BROWSER_BUNDLE_ID?.trim()
    : "";
  const command = process.platform === "darwin"
    ? "open"
    : process.platform === "win32"
      ? "cmd"
      : "xdg-open";
  const args = process.platform === "darwin" && configured
    ? ["-b", configured, url]
    : process.platform === "win32"
      ? ["/c", "start", "", url]
      : [url];
  execFile(command, args, (error) => {
    if (error) console.error("无法打开 Web 控制台，请手动访问: " + url);
  });
}

function trayIconPath(): string {
  const configured = process.env.TRAY_ICON_PATH?.trim();
  if (configured) return configured;
  if (process.platform !== "darwin") return "";

  const resourcesDir = resolve(dirname(process.execPath), "..", "Resources");
  const png = join(resourcesDir, "tray.png");
  if (existsSync(png)) return png;
  const icns = join(resourcesDir, "tray.icns");
  if (existsSync(icns)) return icns;
  const ico = join(resourcesDir, "tray.ico");
  return existsSync(ico) ? ico : "";
}

function createGatewayManager(config: GatewayConfig): GatewayManager {
  let child: ChildProcess | null = null;
  let stopping = false;
  let restartRequested = false;

  function start(): void {
    if (child !== null) {
      console.log("Gateway 已在运行");
      return;
    }

    stopping = false;
    const nextChild = spawn(process.execPath, ["serve"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        LLM_GATEWAY_RESOLVED_CONFIG: JSON.stringify(config)
      },
      stdio: "inherit"
    });
    child = nextChild;

    nextChild.on("error", (error) => {
      if (child !== nextChild) return;
      child = null;
      console.error("无法启动 Gateway 子进程: " + error.message);
      if (restartRequested) {
        restartRequested = false;
        setTimeout(start, 250);
      }
    });
    nextChild.on("exit", (code, signal) => {
      if (child !== nextChild) return;
      child = null;
      const shouldRestart = restartRequested;
      restartRequested = false;
      const wasStopping = stopping;
      stopping = false;
      if (!wasStopping && (code !== 0 || signal)) {
        console.error(
          "Gateway 子进程已退出（code=" + String(code) +
          ", signal=" + String(signal) + "）"
        );
      }
      if (shouldRestart) setTimeout(start, 250);
    });
  }

  function stop(): void {
    restartRequested = false;
    if (child === null) return;
    stopping = true;
    child.kill("SIGTERM");
  }

  function restart(): void {
    restartRequested = true;
    if (child === null) {
      restartRequested = false;
      start();
      return;
    }
    stopping = true;
    child.kill("SIGTERM");
  }

  return {
    start,
    stop,
    restart,
    isRunning: () => child !== null
  };
}

export function runDesktop(): void {
  const config = loadDesktopConfig();
  const gateway = createGatewayManager(config);
  let tray: Widget | null = null;
  let launchWindow: DesktopWindow | null = null;
  let quitting = false;

  function showLaunchWindow(): void {
    if (launchWindow === null) {
      launchWindow = Window("LLM Gateway", 460, 180);
      launchWindow.setBody(Text(
        "LLM Gateway 已启动\n\n" +
        "控制台地址：" + webUiUrl(config) + "\n" +
        "可从菜单栏托盘图标管理 Gateway"
      ));
    }
    launchWindow.show();
  }

  function openConsole(): void {
    if (!gateway.isRunning()) {
      gateway.start();
      setTimeout(() => openWebUi(config), 500);
      return;
    }
    openWebUi(config);
  }

  function requestQuit(): void {
    if (quitting) return;
    quitting = true;
    gateway.stop();
    if (!gateway.isRunning()) {
      process.exit(0);
      return;
    }
    setTimeout(() => process.exit(0), 750);
  }

  function cleanup(): void {
    if (tray !== null) {
      trayDestroy(tray);
      tray = null;
    }
    if (launchWindow !== null) {
      launchWindow.close();
      launchWindow = null;
    }
    gateway.stop();
  }

  function ensureTray(): void {
    if (tray !== null) return;

    // Empty path uses Perry's documented placeholder icon. Packaged builds
    // can provide a real PNG/ICNS/ICO through TRAY_ICON_PATH.
    const created = trayCreate(trayIconPath());
    if (created === 0) return;
    tray = created;
    traySetTooltip(tray, "LLM Gateway");

    const menu = menuCreate();
    menuAddItem(menu, "打开控制台", openConsole);
    menuAddSeparator(menu);
    menuAddItem(menu, "启动 Gateway", gateway.start);
    menuAddItem(menu, "停止 Gateway", gateway.stop);
    menuAddItem(menu, "重启 Gateway", gateway.restart);
    menuAddSeparator(menu);
    menuAddItem(menu, "退出", requestQuit);
    trayAttachMenu(tray, menu);
    trayOnClick(tray, openConsole);
  }

  gateway.start();
  process.once("exit", cleanup);
  process.once("SIGINT", () => {
    cleanup();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    cleanup();
    process.exit(143);
  });
  onTerminate(cleanup);

  // Windows needs the App-created HWND before trayCreate can succeed.
  // Deferred initialization also handles backends that start their event loop
  // after App() is evaluated.
  setTimeout(ensureTray, 0);
  onActivate(ensureTray);
  setTimeout(() => {
    showLaunchWindow();
    openWebUi(config);
  }, 500);

  App({
    title: "LLM Gateway",
    width: 1,
    height: 1,
    activationPolicy: "accessory",
    body: Text("LLM Gateway")
  });
}
