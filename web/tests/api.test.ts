// @vitest-environment node

import { invoke } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { GatewayApi } from "../src/api";
import { nativeManagement } from "../src/management";
import type { ChatStreamUpdate } from "../src/types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

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
  it("uses native management for desktop statistics without reusing the inference key", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.mocked(invoke).mockResolvedValue({ status: 200, body: { requests: 4 } });
    const desktop = new GatewayApi(
      { apiKey: "business-secret", adminKey: "" },
      undefined,
      nativeManagement,
    );
    await desktop.metricsSummary({ window: "7d", apiKeyId: "key-a" });
    expect(invoke).toHaveBeenLastCalledWith("management_request", {
      request: {
        operation: "metrics",
        view: "summary",
        query: { window: "7d", apiKeyId: "key-a" },
      },
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response('{"choices":[]}')));
    await desktop.chat({ id: "test" }, "hello");
    expect(vi.mocked(fetch).mock.calls[0][0]).toContain("/v1/chat/completions");
    expect(new Headers(vi.mocked(fetch).mock.calls[0][1]?.headers).get("Authorization")).toBe(
      "Bearer business-secret",
    );
  });
  it("keeps remote administrator credentials separate from business credentials", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => new Response("{}")),
    );
    const remote = new GatewayApi({ apiKey: "business", adminKey: "administrator" });
    await remote.metricsSummary({ window: "24h" });
    let [path, options] = vi.mocked(fetch).mock.calls[0];
    expect(path).toContain("/admin/metrics/");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer administrator");
    const client = new GatewayApi({ apiKey: "business", adminKey: "" });
    await client.metricsSummary({ window: "24h" });
    [path, options] = vi.mocked(fetch).mock.calls[1];
    expect(path).toContain("/metrics/summary");
    expect(path).not.toContain("/admin/");
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer business");
  });
  it("preserves native management failure details as an Error", async () => {
    vi.mocked(invoke).mockRejectedValueOnce("服务尚未启动");
    const desktop = new GatewayApi({ apiKey: "", adminKey: "" }, undefined, nativeManagement);
    await expect(desktop.metricsSummary({ window: "24h" })).rejects.toThrow("服务尚未启动");
  });
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
  it("normalizes standard token usage consistently for chat and streaming", async () => {
    const usage = {
      prompt_tokens: 5,
      completion_tokens: 3,
      total_tokens: 8,
      prompt_tokens_details: { cached_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 1 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [], usage }))),
    );
    const result = await api.chat({ id: "test" }, "hello");
    expect(result.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 3,
      totalTokens: 8,
      cachedTokens: 2,
      reasoningTokens: 1,
    });
    mockStream(`data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`);
    const updates: ChatStreamUpdate[] = [];
    await api.streamChat({ id: "test" }, "hello", "auto", (update) => updates.push(update));
    expect(updates.find((update) => update.usage)?.usage).toEqual(result.usage);
  });
  it("surfaces errors sent inside a successful HTTP stream", async () => {
    mockStream('data: {"error":{"message":"upstream unavailable"}}\n\n');
    await expect(api.streamChat({ id: "test" }, "hello", "auto", () => {})).rejects.toThrow(
      "upstream unavailable",
    );
  });
  it("keeps partial output and reports a timed out stream as 504 without a success update", async () => {
    mockStream(
      'data: {"choices":[{"delta":{"content":"partial"}}]}\n\nevent: error\ndata: {"error":{"message":"等待后续数据超时","status":504,"code":"upstream_idle_timeout"}}\n\n',
    );
    const updates: ChatStreamUpdate[] = [];
    await expect(
      api.streamChat({ id: "test" }, "hello", "auto", (update) => updates.push(update)),
    ).rejects.toMatchObject({ status: 504, message: "等待后续数据超时" });
    expect(updates[0].content).toBe("partial");
    expect(updates.some((update) => update.done)).toBe(false);
  });
});
