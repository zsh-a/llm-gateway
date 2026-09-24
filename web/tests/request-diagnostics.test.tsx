import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { RequestTable } from "../src/components/usage";
import type { RecentRequest } from "../src/types";

describe("request failure diagnostics", () => {
  it("shows token truncation, forwarded budgets and failed attempts", async () => {
    const user = userEvent.setup();
    render(
      <RequestTable
        rows={[
          {
            id: "limited",
            startedAt: 1,
            status: "success",
            finishReason: "length",
            diagnostics: {
              attempts: 2,
              responseHeadersMs: 1,
              firstByteMs: 2,
              lastByteMs: 3,
              receivedBytes: 42,
              receivedChunks: 2,
              error: null,
              outputBudget: {
                requested: { max_output_tokens: 128 },
                upstream: { max_completion_tokens: 128 },
              },
              attemptDetails: [
                {
                  channelId: "primary",
                  provider: "mimo",
                  model: "test",
                  error: { message: "上游请求限流" },
                },
                { channelId: "backup", provider: "mimo", model: "test", error: null },
              ],
            },
          },
        ]}
      />,
    );
    expect(screen.getByText("达到输出上限")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "展开请求详情" }));
    expect(screen.getByText("max_output_tokens: 128")).toBeTruthy();
    expect(screen.getByText("max_completion_tokens: 128")).toBeTruthy();
    expect(screen.getByText(/primary.*上游请求限流/)).toBeTruthy();
    expect(screen.getByText(/backup.*已接收上游响应/)).toBeTruthy();
  });
  it("distinguishes connection, first-data and idle timeouts and keeps legacy uncertainty", async () => {
    const user = userEvent.setup();
    const rows: RecentRequest[] = [
      ["connect", "upstream_connect_timeout", "建立连接超时", 0, null],
      ["first_byte", "upstream_first_byte_timeout", "尚无首个数据", 0, 12],
      ["stream_idle", "upstream_idle_timeout", "后续数据超时", 120, 12],
    ].map(([stage, code, message, bytes, headers], index) => ({
      id: `request-${index}`,
      startedAt: 1,
      status: "error",
      statusCode: 504,
      diagnostics: {
        attempts: 1,
        responseHeadersMs: headers as number | null,
        firstByteMs: bytes ? 20 : null,
        lastByteMs: bytes ? 30 : null,
        receivedBytes: bytes as number,
        receivedChunks: bytes ? 2 : 0,
        error: {
          stage: stage as string,
          code: code as string,
          message: message as string,
          status: 504,
          timeoutMs: 180000,
        },
      },
    }));
    rows.push({ id: "legacy", startedAt: 1, status: "error" });
    render(<RequestTable rows={rows} />);
    expect(screen.getByText("连接超时")).toBeTruthy();
    expect(screen.getByText("首包超时")).toBeTruthy();
    expect(screen.getByText("数据中断超时")).toBeTruthy();
    for (const button of screen.getAllByRole("button", { name: "展开请求详情" }))
      await user.click(button);
    const alerts = screen.getAllByRole("alert");
    expect(within(alerts[0]).getByText("尚未收到上游响应头或响应体数据。")).toBeTruthy();
    expect(within(alerts[1]).getByText("已收到上游响应头，但尚未收到响应体数据。")).toBeTruthy();
    expect(within(alerts[2]).getByText(/中断前已收到上游数据/)).toBeTruthy();
    expect(screen.getByText("120 字节 / 2 块")).toBeTruthy();
    expect(screen.getByText(/此历史记录未保存错误阶段/)).toBeTruthy();
  });
});
