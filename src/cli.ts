import { getAuth } from "./auth.js";
import {
  DEFAULT_MODEL,
  loadConfig,
  normalizeEffort,
  type ReasoningEffort
} from "./config.js";
import { streamViaCdp } from "./cdp.js";
import { streamChat, type UpstreamChunk } from "./mimo.js";
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
    model: args[1] ?? DEFAULT_MODEL,
    effort: normalizeEffort(args[2] ?? "medium")
  };
}

function requestFor(prompt: string, model: string, effort: ReasoningEffort): NormalizedChatRequest {
  return {
    model,
    messages: [{ role: "user", content: prompt }],
    stream: true,
    effort
  };
}

async function main(): Promise<void> {
  const { prompt, model, effort } = parseArgs(process.argv.slice(2));
  const request = requestFor(prompt, model, effort);
  const renderer = new TerminalRenderer();

  console.log(`[目标模型: ${model} | 思考强度: ${effort}]`);
  const authHeaders = await getAuth(config);

  if (authHeaders) {
    try {
      await streamChat(authHeaders, request, config, (chunk) => {
        renderer.chunk(chunk);
      });
      renderer.finish();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[直连上游失败，回退到浏览器通道]:", message);
    }
  }

  const browserRenderer = new TerminalRenderer();
  await streamViaCdp(
    config,
    request.messages,
    request.model,
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
