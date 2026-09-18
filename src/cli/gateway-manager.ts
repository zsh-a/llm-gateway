export type GatewayState = "stopped" | "starting" | "running" | "degraded" | "stopping" | "error";
export type GatewayOwnership = "managed" | "external" | "remote";

export interface GatewaySnapshot {
  state: GatewayState;
  ownership: GatewayOwnership;
  available: boolean;
  detail: string;
}

export interface LiveProbe {
  kind: "offline" | "foreign" | "gateway";
  instanceId: string;
}

export interface ManagedProcess {
  kill(signal: "SIGTERM" | "SIGKILL"): void;
}

export interface GatewayManagerOptions {
  remote: boolean;
  live: () => Promise<LiveProbe>;
  ready: () => Promise<{ ready: boolean; detail: string }>;
  spawn: (instanceId: string, onExit: (reason: string) => void) => ManagedProcess;
  onChange: (snapshot: GatewaySnapshot) => void;
  startupTimeoutMs?: number;
  stopTimeoutMs?: number;
  pollIntervalMs?: number;
}

/** Owns process lifecycle independently of native UI. Each user command invalidates
 * pending probes/restarts, so an old async completion cannot undo a later stop. */
export class GatewayManager {
  private value: GatewaySnapshot;
  private child: ManagedProcess | null = null;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private killTimer: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private stopped: (() => void) | null = null;
  private disposed = false;
  private instanceId = "";
  private deadline = 0;

  constructor(private readonly options: GatewayManagerOptions) {
    this.value = {
      state: "stopped", ownership: options.remote ? "remote" : "managed",
      available: false, detail: "尚未连接"
    };
  }

  snapshot(): GatewaySnapshot { return { ...this.value }; }
  hasProcess(): boolean { return this.child !== null; }

  private publish(state: GatewayState, available: boolean, detail: string): void {
    if (this.value.state === state && this.value.available === available && this.value.detail === detail) return;
    this.value = { ...this.value, state, available, detail };
    this.options.onChange(this.snapshot());
  }

  private cancelPoll(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private current(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  async start(): Promise<void> {
    if (this.disposed || this.child || this.stopping || this.value.state === "starting") return;
    const generation = ++this.generation;
    this.cancelPoll();
    this.publish("starting", false, this.options.remote ? "正在连接远程网关" : "正在检查服务地址");
    let live: LiveProbe;
    try {
      live = await this.options.live();
    } catch {
      live = { kind: "offline", instanceId: "" };
    }
    if (!this.current(generation)) return;
    if (this.options.remote || live.kind === "gateway") {
      this.value.ownership = this.options.remote ? "remote" : "external";
      await this.poll(generation);
      return;
    }
    this.value.ownership = "managed";
    if (live.kind === "foreign") {
      this.publish("error", false, "目标端口被其他服务占用，请修改端口或关闭占用程序");
      return;
    }
    this.instanceId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.deadline = Date.now() + (this.options.startupTimeoutMs ?? 30_000);
    this.publish("starting", false, "正在启动 Gateway");
    try {
      const child = this.options.spawn(this.instanceId, (reason) => this.exited(child, reason));
      this.child = child;
    } catch (error) {
      this.publish("error", false, "启动失败：" + String(error));
      return;
    }
    await this.poll(generation);
  }

  private exited(child: ManagedProcess, reason: string): void {
    if (this.child !== child) return;
    this.child = null;
    if (this.killTimer !== null) clearTimeout(this.killTimer);
    this.killTimer = null;
    if (this.stopped) {
      const resolve = this.stopped;
      this.stopped = null;
      this.stopping = null;
      this.publish("stopped", false, "服务已停止");
      resolve();
    } else {
      ++this.generation;
      this.cancelPoll();
      this.publish("error", false, reason || "Gateway 意外退出，请查看日志后重试");
    }
  }

  private async poll(generation: number): Promise<void> {
    if (!this.current(generation)) return;
    let live: LiveProbe;
    try {
      live = await this.options.live();
    } catch {
      live = { kind: "offline", instanceId: "" };
    }
    if (!this.current(generation)) return;
    const matches = live.kind === "gateway" &&
      (this.value.ownership !== "managed" || live.instanceId === this.instanceId);
    if (matches) {
      // Console access depends on HTTP liveness, not upstream authentication.
      if (!this.value.available) this.publish("degraded", true, "服务已启动，正在检查认证与模型目录");
      let readiness: { ready: boolean; detail: string };
      try {
        readiness = await this.options.ready();
      } catch {
        readiness = { ready: false, detail: "服务可访问，就绪检查暂未完成" };
      }
      if (!this.current(generation)) return;
      this.publish(readiness.ready ? "running" : "degraded", true, readiness.detail);
    } else if (this.value.ownership === "managed" && this.value.state === "starting" && Date.now() < this.deadline) {
      // Keep waiting for our own instance; another service on this port is not readiness.
    } else {
      const detail = live.kind !== "offline"
        ? "目标端口的服务与当前网关不匹配，请查看日志"
        : this.value.ownership === "managed"
          ? "Gateway 未能响应健康检查，请查看日志或重启服务"
          : "无法连接网关，请检查地址和服务状态";
      this.publish("error", false, detail);
    }
    if (this.current(generation)) {
      const delay = this.value.state === "starting" ? 250 : (this.options.pollIntervalMs ?? 5000);
      this.timer = setTimeout(() => { this.timer = null; void this.poll(generation); }, delay);
    }
  }

  stop(): Promise<void> {
    ++this.generation;
    this.cancelPoll();
    if (this.stopping) return this.stopping;
    if (!this.child) {
      this.publish("stopped", false, "已停止连接");
      return Promise.resolve();
    }
    this.publish("stopping", false, "正在等待请求结束并保存数据");
    const child = this.child;
    this.stopping = new Promise<void>((resolve) => { this.stopped = resolve; });
    const pending = this.stopping;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (this.child === child) child.kill("SIGKILL");
    }, this.options.stopTimeoutMs ?? 12_000);
    child.kill("SIGTERM");
    return pending;
  }

  async restart(): Promise<void> {
    if (this.disposed || this.value.ownership !== "managed") return;
    const stopped = this.stop();
    const generation = this.generation;
    await stopped;
    if (this.current(generation)) await this.start();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.stop();
  }

  /** Synchronous fallback for OS termination callbacks that cannot await. */
  terminate(): void {
    this.disposed = true;
    ++this.generation;
    this.cancelPoll();
    if (this.child) this.child.kill("SIGTERM");
  }
}
