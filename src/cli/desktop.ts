import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  App, Window, Text, clipboardWrite, menuAddItem, menuAddSeparator, menuCreate,
  onActivate, onTerminate, setText, trayAttachMenu, trayCreate, trayDestroy,
  trayOnClick, traySetTooltip, type Widget, type WindowHandle
} from "perry/ui";
import { loadConfig, type GatewayConfig } from "../app/config.js";
import { readJsonFile, writeJsonFileAtomic } from "../infrastructure/file-store.js";
import { GatewayManager, type GatewaySnapshot } from "./gateway-manager.js";
import { acquireDesktopLease, desktopEndpoint, desktopLogger, probeLive, probeReady, resolveDesktopConfig } from "./desktop-runtime.js";

function defaultRuntimeDir(): string {
  if (process.platform === "darwin") return join(homedir(), "Library", "Application Support", "LLM Gateway");
  if (process.platform === "win32") return join(process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming"), "LLM Gateway");
  return join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"), "llm-gateway");
}

function loadDesktopConfig(): GatewayConfig {
  if (!process.env.RUNTIME_DIR?.trim()) {
    const localRuntime = resolve(process.cwd(), ".runtime");
    process.env.RUNTIME_DIR = existsSync(localRuntime) ? localRuntime : defaultRuntimeDir();
  }
  return resolveDesktopConfig(loadConfig());
}

function trayIconPath(): string {
  const configured = process.env.TRAY_ICON_PATH?.trim();
  if (configured) {
    const file = resolve(configured);
    if (!existsSync(file)) throw new Error("托盘图标不存在：" + file);
    return file;
  }
  const resourcesDir = resolve(dirname(process.execPath), "..", "Resources");
  for (const name of ["tray.png", "tray.icns", "tray.ico"]) {
    const file = join(resourcesDir, name);
    if (existsSync(file)) return file;
  }
  return "";
}

const stateLabels = {
  stopped: "已停止", starting: "启动 / 连接中", running: "已就绪",
  degraded: "需要处理", stopping: "正在停止", error: "连接 / 服务异常"
};

export function runDesktop(): void {
  const config = loadDesktopConfig();
  const remote = Boolean(process.env.GATEWAY_URL?.trim());
  const endpoint = desktopEndpoint(config, process.env.GATEWAY_URL);
  const icon = trayIconPath();
  const lease = acquireDesktopLease(config.runtimeDir);
  const activationFile = join(config.runtimeDir, "desktop.activate");
  if (!lease.acquired) {
    writeFileSync(activationFile, String(Date.now()));
    chmodSync(activationFile, 0o600);
    console.log("桌面实例已在运行，已请求显示状态窗口");
    return;
  }
  process.once("exit", lease.release);

  const log = desktopLogger(config.runtimeDir);
  const preferencesFile = join(config.runtimeDir, "desktop-preferences.json");
  const firstLaunch = !existsSync(preferencesFile);
  const stored = readJsonFile(preferencesFile) as { openOnStartup?: boolean } | null;
  let openOnStartup = stored?.openOnStartup === true;
  if (firstLaunch) writeJsonFileAtomic(preferencesFile, { openOnStartup });
  let pendingOpen = firstLaunch || openOnStartup;
  let tray: Widget | null = null;
  let statusWindow: WindowHandle | null = null;
  let quitting = false;
  let lastError = "";
  let activationTimer: ReturnType<typeof setInterval> | null = null;
  const menus = new Map<string, Widget>();

  function openTarget(target: string, browser = false): void {
    const bundle = browser ? process.env.BROWSER_BUNDLE_ID?.trim() : "";
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer.exe" : "xdg-open";
    const args = process.platform === "darwin" && bundle ? ["-b", bundle, target] : [target];
    execFile(command, args, (error) => {
      if (error) {
        log.write("打开失败：" + error.message);
        showStatus("无法打开，请手动访问：\n" + target);
      }
    });
  }

  const gateway = new GatewayManager({
    remote,
    live: () => probeLive(endpoint, true),
    ready: () => probeReady(endpoint, true),
    spawn: (instanceId, onExit) => {
      const child = spawn(process.execPath, ["serve"], {
        cwd: config.runtimeDir,
        env: { ...process.env, LLM_GATEWAY_RESOLVED_CONFIG: JSON.stringify(config), LLM_GATEWAY_INSTANCE_ID: instanceId },
        stdio: ["ignore", "pipe", "pipe"]
      });
      let reason = "";
      let finished = false;
      function finish(message: string): void {
        if (finished) return;
        finished = true;
        onExit(message);
      }
      child.stdout?.on("data", (chunk) => log.write(String(chunk).trim()));
      child.stderr?.on("data", (chunk) => {
        const text = String(chunk).trim();
        log.write(text);
        if (text.includes("EADDRINUSE") || text.includes("address already in use")) reason = "端口已被占用，请修改端口或关闭占用程序";
      });
      child.on("error", (error) => finish("无法启动 Gateway：" + error.message));
      child.on("exit", (code, signal) => finish(reason || `Gateway 已退出（code=${code}, signal=${signal}），请查看日志`));
      return { kill: (signal) => { child.kill(signal); } };
    },
    onChange: (snapshot) => {
      log.write(`${snapshot.ownership} ${snapshot.state}: ${snapshot.detail}`);
      render(snapshot);
      if (!quitting && pendingOpen && snapshot.available) {
        pendingOpen = false;
        openTarget(endpoint + "/ui", true);
      }
      if (!quitting && snapshot.state === "error" && snapshot.detail !== lastError) {
        lastError = snapshot.detail;
        pendingOpen = false;
        showStatus();
      }
      if (snapshot.available) lastError = "";
    }
  });

  function statusText(snapshot: GatewaySnapshot): string {
    const mode = snapshot.ownership === "remote" ? "远程连接" : snapshot.ownership === "external" ? "连接已有服务（只读管理）" : "本地托管";
    return `LLM Gateway · ${stateLabels[snapshot.state]}\n\n${mode}\n${endpoint}\n\n${snapshot.detail}\n\n日志：${log.directory}`;
  }

  function showStatus(message = ""): void {
    if (quitting) return;
    if (!statusWindow) {
      statusWindow = Window("LLM Gateway 状态", 620, 280);
      statusWindow.setBody(Text("", "gateway-status"));
    }
    setText("gateway-status", message || statusText(gateway.snapshot()));
    statusWindow.show();
  }

  function openConsole(): void {
    if (quitting) return;
    const snapshot = gateway.snapshot();
    if (snapshot.available) { openTarget(endpoint + "/ui", true); return; }
    pendingOpen = true;
    if (snapshot.state !== "stopping") void gateway.start();
    showStatus();
  }

  function stop(): void { pendingOpen = false; void gateway.stop(); }

  function toggleOpenOnStartup(): void {
    const next = !openOnStartup;
    try {
      writeJsonFileAtomic(preferencesFile, { openOnStartup: next });
      openOnStartup = next;
      render(gateway.snapshot());
    } catch {
      showStatus("无法保存启动偏好，请检查数据目录写入权限");
    }
  }

  function render(snapshot: GatewaySnapshot): void {
    if (statusWindow) setText("gateway-status", statusText(snapshot));
    if (tray === null) return;
    traySetTooltip(tray, `LLM Gateway · ${stateLabels[snapshot.state]}\n${endpoint}\n${snapshot.detail}`);
    // Cache finite state menus: this backend retains native callback objects.
    const hasProcess = gateway.hasProcess();
    const key = `${snapshot.ownership}:${snapshot.state}:${hasProcess}:${openOnStartup}`;
    let menu = menus.get(key);
    if (menu === undefined) {
      menu = menuCreate();
      menuAddItem(menu, `LLM Gateway · ${stateLabels[snapshot.state]}`, () => showStatus());
      menuAddItem(menu, snapshot.ownership === "managed" ? "本地托管 · 查看状态" : "外部连接 · 查看状态", () => showStatus());
      menuAddSeparator(menu);
      if (snapshot.state !== "stopping") menuAddItem(menu, "打开控制台", openConsole);
      menuAddItem(menu, "复制 API 地址", () => { clipboardWrite(endpoint + "/v1"); });
      menuAddSeparator(menu);
      if (snapshot.ownership === "managed") {
        if (!hasProcess && (snapshot.state === "stopped" || snapshot.state === "error")) menuAddItem(menu, "启动 / 重试 Gateway", () => { void gateway.start(); });
        if (snapshot.state !== "stopped" && snapshot.state !== "stopping") menuAddItem(menu, "停止 Gateway", stop);
        if (["running", "degraded", "error"].includes(snapshot.state)) menuAddItem(menu, "重启 Gateway", () => { void gateway.restart(); });
      } else {
        if (snapshot.state === "stopped" || snapshot.state === "error") menuAddItem(menu, "重新连接", () => { void gateway.start(); });
        if (snapshot.state !== "stopped") menuAddItem(menu, "断开连接（保留服务）", stop);
      }
      menuAddSeparator(menu);
      menuAddItem(menu, "查看状态与诊断", () => { showStatus(); });
      menuAddItem(menu, "打开日志目录", () => openTarget(log.directory));
      menuAddItem(menu, "打开数据目录", () => openTarget(config.runtimeDir));
      menuAddItem(menu, `${openOnStartup ? "✓ " : ""}启动时打开控制台`, toggleOpenOnStartup);
      menuAddSeparator(menu);
      menuAddItem(menu, snapshot.ownership === "managed" ? "退出并停止 Gateway" : "退出（保留外部服务）", () => { void requestQuit(); });
      menus.set(key, menu);
    }
    trayAttachMenu(tray, menu);
  }

  function ensureTray(): void {
    if (tray !== null || quitting) return;
    const created = trayCreate(icon);
    if (created === 0) { showStatus("托盘创建失败，可关闭应用后重新启动；服务状态可在控制台查看"); return; }
    tray = created;
    if (process.platform !== "darwin") trayOnClick(tray, openConsole);
    render(gateway.snapshot());
  }

  function cleanup(): void {
    if (activationTimer !== null) clearInterval(activationTimer);
    gateway.terminate();
    lease.release();
    if (tray !== null) { trayDestroy(tray); tray = null; }
    if (statusWindow) { statusWindow.close(); statusWindow = null; }
  }

  async function requestQuit(): Promise<void> {
    if (quitting) return;
    quitting = true;
    pendingOpen = false;
    await gateway.dispose();
    cleanup();
    process.exit(0);
  }

  process.once("exit", cleanup);
  process.once("SIGINT", () => { void requestQuit(); });
  process.once("SIGTERM", () => { void requestQuit(); });
  onTerminate(cleanup);
  onActivate(ensureTray);
  setTimeout(() => {
    ensureTray();
    activationTimer = setInterval(() => {
      if (existsSync(activationFile)) {
        try { unlinkSync(activationFile); } catch { return; }
        showStatus();
      }
    }, 1000);
    void gateway.start();
  }, 0);
  App({ title: "LLM Gateway", width: 1, height: 1, activationPolicy: "accessory", body: Text("LLM Gateway") });
}
