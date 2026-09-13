import { WebSocket } from "ws";

import type { AppConfig } from "./config.js";

interface CdpTarget {
  type?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpReply {
  id?: number;
  result?: {
    result?: {
      value?: unknown;
    };
    exceptionDetails?: {
      text?: string;
      exception?: {
        description?: string;
      };
    };
  };
  error?: {
    message?: string;
  };
}

interface PendingCall {
  resolve: (reply: CdpReply) => void;
  reject: (error: Error) => void;
}

function asRecord(value: unknown): { [key: string]: unknown } {
  return value !== null && typeof value === "object"
    ? value as { [key: string]: unknown }
    : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : String(value);
}

function json(value: unknown): string {
  return JSON.stringify(value) ?? "null";
}

class CdpClient {
  private socket: WebSocket;
  private nextId: number;
  private pending: Map<number, PendingCall>;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();

    this.socket.on("message", (data: unknown) => {
      this.onMessage(data);
    });
    this.socket.on("error", (error: Error) => {
      this.rejectAll(error);
    });
    this.socket.on("close", () => {
      this.rejectAll(new Error("Chrome CDP 连接已关闭"));
    });
  }

  private onMessage(data: unknown): void {
    let message: CdpReply;
    try {
      message = JSON.parse(asText(data)) as CdpReply;
    } catch {
      return;
    }

    if (typeof message.id !== "number") return;
    const call = this.pending.get(message.id);
    if (!call) return;
    this.pending.delete(message.id);
    call.resolve(message);
  }

  private rejectAll(error: Error): void {
    for (const call of this.pending.values()) call.reject(error);
    this.pending.clear();
  }

  call(method: string, params: { [key: string]: unknown }): Promise<CdpReply> {
    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let settled = false;

    socket.on("open", () => {
      if (settled) return;
      settled = true;
      resolve(socket);
    });
    socket.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on("close", () => {
      if (settled) return;
      settled = true;
      reject(new Error("Chrome CDP 连接在建立前关闭"));
    });
  });
}

async function evaluate(
  client: CdpClient,
  expression: string
): Promise<unknown> {
  const reply = await client.call("Runtime.evaluate", {
    expression,
    returnByValue: true
  });
  if (reply.error) {
    throw new Error(reply.error.message ?? "Chrome Runtime.evaluate 失败");
  }
  if (reply.result?.exceptionDetails) {
    throw new Error(
      reply.result.exceptionDetails.text ??
        reply.result.exceptionDetails.exception?.description ??
        "Chrome Runtime.evaluate 执行异常"
    );
  }
  return reply.result?.result?.value;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function firstTarget(value: unknown): CdpTarget | null {
  if (!Array.isArray(value)) return null;

  let fallback: CdpTarget | null = null;
  for (const item of value) {
    const record = asRecord(item);
    const target: CdpTarget = {
      type: typeof record.type === "string" ? record.type : undefined,
      webSocketDebuggerUrl:
        typeof record.webSocketDebuggerUrl === "string"
          ? record.webSocketDebuggerUrl
          : undefined
    };
    if (!target.webSocketDebuggerUrl) continue;
    if (!fallback) fallback = target;
    if (target.type === "page") return target;
  }
  return fallback;
}

export async function streamViaCdp(
  config: AppConfig,
  messages: unknown[],
  model: string,
  onReason: (text: string) => void,
  onContent: (text: string) => void
): Promise<void> {
  const targetsResponse = await fetch(config.cdpJsonUrl);
  if (!targetsResponse.ok) {
    throw new Error(`无法访问 Chrome CDP: HTTP ${targetsResponse.status}`);
  }

  const target = firstTarget(await targetsResponse.json());
  if (!target?.webSocketDebuggerUrl) {
    throw new Error("Chrome CDP 没有找到可用的页面目标");
  }

  const client = new CdpClient(await connect(target.webSocketDebuggerUrl));
  const origin = `cli-${Date.now()}`;
  const streamKey = "__mimoCliStream";

  try {
    const setup = `(() => {
      window.${streamKey} = { reasons: [], deltas: [], done: false, error: null };
      window.mimo.onChatReason((origin, chunk) => {
        if (origin === ${json(origin)}) window.${streamKey}.reasons.push(chunk);
      });
      window.mimo.onChatDelta((origin, chunk) => {
        if (origin === ${json(origin)}) window.${streamKey}.deltas.push(chunk);
      });
      window.mimo.onChatDone((origin) => {
        if (origin === ${json(origin)}) window.${streamKey}.done = true;
      });
      window.mimo.onChatError((origin, error) => {
        if (origin === ${json(origin)}) {
          window.${streamKey}.error = String(error);
          window.${streamKey}.done = true;
        }
      });
      window.mimo.chat(${json(messages)}, ${json(model)}, ${json(origin)});
      return true;
    })()`;

    await evaluate(client, setup);

    let reasonCursor = 0;
    let contentCursor = 0;
    let done = false;

    while (!done) {
      await delay(100);
      const state = asRecord(await evaluate(client, `({
        reasons: window.${streamKey}.reasons.slice(${reasonCursor}),
        deltas: window.${streamKey}.deltas.slice(${contentCursor}),
        done: window.${streamKey}.done,
        error: window.${streamKey}.error
      })`));

      const reasons = Array.isArray(state.reasons) ? state.reasons : [];
      for (const reason of reasons) {
        if (typeof reason === "string") onReason(reason);
      }
      reasonCursor += reasons.length;

      const deltas = Array.isArray(state.deltas) ? state.deltas : [];
      for (const delta of deltas) {
        if (typeof delta === "string") onContent(delta);
      }
      contentCursor += deltas.length;

      done = state.done === true;
      if (done && state.error) throw new Error(String(state.error));
    }
  } finally {
    client.close();
  }
}
