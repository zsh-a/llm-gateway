import { getAuthStore } from "./auth-store.js";
import { loadConfig, normalizeEffort, type ReasoningEffort } from "./config.js";
import { streamViaCdp } from "./cdp.js";
import { type UpstreamChunk } from "./provider.js";
import { getModels, resolveModel } from "./models.js";
import type { NormalizedChatRequest } from "./types.js";

const config = loadConfig();

class TerminalRenderer {
  private reasoningStarted: boolean;
  private contentStarted: boolean;

  constructor() {
    this.reasoningStarted = false;
    this.contentStarted = false;
  }

  reason(text: string): void {
    if (!this.reasoningStarted) {
      process.stdout.write("\x1b[33m=== 🧠 思维链 ===\x1b[0m\n");
      this.reasoningStarted = true;
    }
    process.stdout.write(`\x1b[33m${text}\x1b[0m`);
  }

  content(text: string): void {
    if (!this.contentStarted) {
      if (this.reasoningStarted) process.stdout.write("\n\n");
      process.stdout.write("\x1b[32m=== 💬 回答正文 ===\x1b[0m\n");
      this.contentStarted = true;
    }
    process.stdout.write(`\x1b[32m${text}\x1b[0m`);
  }

  chunk(chunk: UpstreamChunk): void {
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.reasoning_content) this.reason(delta.reasoning_content);
    if (delta?.content) this.content(delta.content);
  }

  finish(): void {
    process.stdout.write("\n\n");
  }
}

function parseArgs(args: string[]): {
  prompt: string;
  model: string;
  effort: ReasoningEffort;
} {
  return {
    prompt: args[0] ?? "9.11 和 9.8 哪个大？为什么？",
    model: args[1] ?? "",
    effort: normalizeEffort(args[2] ?? "medium")
  };
}

function requestFor(prompt: string, model: string, effort: ReasoningEffort): NormalizedChatRequest {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    effort,
    options: {}
  };
}

async function main(): Promise<void> {
  const { prompt, model, effort } = parseArgs(process.argv.slice(2));
  const route = await resolveModel(config, model || config.defaultModel);
  if (!route) {
    const available = (await getModels(config)).map((item) => item.publicId ?? item.id);
    throw new Error(
      `未找到模型 ${model || "(默认)"}${available.length > 0 ? `，可用模型: ${available.join(", ")}` : ""}`
    );
  }

  const request = requestFor(prompt, route.upstreamModel, effort);
  const renderer = new TerminalRenderer();

  console.log(
    `[提供方: ${route.provider.name} | 目标模型: ${route.publicModel} | 思考强度: ${effort}]`
  );
  const authSnapshot = getAuthStore(config).get(route.provider.id);

  if (authSnapshot) {
    try {
      await route.provider.streamChat(
        authSnapshot.headers,
        request,
        config,
        (chunk) => {
          renderer.chunk(chunk);
        }
      );
      renderer.finish();
      return;
    } catch (error) {
      if (!route.provider.supportsBrowserFallback) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[直连上游失败，回退到浏览器通道]:", message);
    }
  }

  if (!route.provider.supportsBrowserFallback) {
    throw new Error(`未找到 ${route.provider.name} 认证，请先执行 npm run auth -- --provider ${route.provider.id}`);
  }

  const browserRenderer = new TerminalRenderer();
  await streamViaCdp(
    config,
    request.messages,
    route.upstreamModel,
    (text) => browserRenderer.reason(text),
    (text) => browserRenderer.content(text)
  );
  browserRenderer.finish();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error("运行失败:", message);
  process.exitCode = 1;
});
