// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { GatewayApi } from "../src/api";
import type { ChatStreamUpdate } from "../src/types";

const api = new GatewayApi({ apiKey: "", adminKey: "" }, "http://test.invalid");
function mockStream(text: string) {
  const bytes = new TextEncoder().encode(text);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Exercise UTF-8 and SSE delimiters split across arbitrary network chunks.
      for (let index = 0; index < bytes.length; index += 3)
        controller.enqueue(bytes.slice(index, index + 3));
      controller.close();
    },
  });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream)));
}

describe("gateway data and streaming", () => {
  it("propagates API errors instead of presenting empty results", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () =>
            new Response(JSON.stringify({ error: { message: "Unauthorized" } }), { status: 401 }),
        ),
    );
    await expect(api.models()).rejects.toThrow("Unauthorized");
    await expect(api.metricsSummary({ window: "24h" })).rejects.toThrow("Unauthorized");
  });
  it("parses fragmented UTF-8, CR-only SSE and usage before DONE", async () => {
    mockStream(
      ': heartbeat\r\rdata: {"choices":[{"delta":{"content":"你好"}}]}\r\rdata: {"usage":{"totalTokens":3},"choices":[]}\r\rdata: [DONE]\r\r',
    );
    const updates: ChatStreamUpdate[] = [];
    await api.streamChat({ id: "test" }, "hello", "auto", (update) => updates.push(update));
    expect(updates.map((update) => update.content ?? "").join("")).toBe("你好");
    expect(updates.find((update) => update.usage)?.usage?.totalTokens).toBe(3);
    expect(updates.at(-1)).toEqual({ done: true });
  });
  it("reports a truncated response instead of success", async () => {
    mockStream('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
    await expect(api.streamChat({ id: "test" }, "hello", "auto", () => {})).rejects.toThrow(
      "响应连接提前结束",
    );
  });
  it("surfaces errors sent inside a successful HTTP stream", async () => {
    mockStream('data: {"error":{"message":"upstream unavailable"}}\n\n');
    await expect(api.streamChat({ id: "test" }, "hello", "auto", () => {})).rejects.toThrow(
      "upstream unavailable",
    );
  });
});
