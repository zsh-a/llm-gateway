import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GatewayApi } from "../src/api";
import { PlaygroundPage } from "../src/features/playground/PlaygroundPage";
import { emptyDashboard } from "../src/lib/constants";

describe("playground request identity", () => {
  it.each([
    ["length", "达到输出上限"],
    ["content_filter", "内容被过滤"],
  ])("retains partial output and explains %s", async (finishReason, label) => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    vi.spyOn(api, "streamChat").mockImplementation(async (_model, _prompt, _effort, update) => {
      update({ requestId: "request-test", content: "保留的输出", finishReason });
    });
    const navigate = vi.fn();
    render(
      <PlaygroundPage
        data={{
          ...emptyDashboard,
          models: [{ id: "test" }],
          resources: {
            ...emptyDashboard.resources,
            models: { hasData: true, pending: false, error: "" },
          },
        }}
        api={api}
        onNavigate={navigate}
        onRefresh={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("消息"), "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByText(label)).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull();
    expect(screen.getByText("保留的输出")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "查看请求记录" }));
    expect(navigate).toHaveBeenCalledWith("metrics", { requestId: "request-test" });
  });
  it("validates budgets and retries the original budget after editing", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    const stream = vi.spyOn(api, "streamChat").mockResolvedValue(undefined);
    render(
      <PlaygroundPage
        data={{
          ...emptyDashboard,
          models: [{ id: "test" }],
          resources: {
            ...emptyDashboard.resources,
            models: { hasData: true, pending: false, error: "" },
          },
        }}
        api={api}
        onNavigate={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("消息"), "hello");
    await user.click(screen.getByText("高级参数"));
    const input = screen.getByLabelText("最大输出 Token");
    await user.type(input, "0");
    expect(screen.getByRole("alert").textContent).toContain("大于 0");
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    await user.clear(input);
    await user.type(input, "128");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("已完成");
    expect(stream.mock.calls[0][5]).toBe(128);
    await user.clear(input);
    await user.type(input, "256");
    await user.click(screen.getByRole("button", { name: "重试原请求" }));
    expect(stream.mock.calls[1][5]).toBe(128);
  });
  it("clears a removed selection when the catalog becomes empty and recovers on refresh", async () => {
    const data = {
      ...emptyDashboard,
      models: [{ id: "a", name: "Alpha" }],
      resources: {
        ...emptyDashboard.resources,
        models: { hasData: true, pending: false, error: "" },
      },
    };
    const props = {
      data,
      api: new GatewayApi({ apiKey: "", adminKey: "" }),
      initialModelId: "a",
      onNavigate: vi.fn(),
      onRefresh: vi.fn(),
    };
    const { rerender } = render(<PlaygroundPage {...props} />);
    expect(screen.getByRole("combobox").textContent).toContain("Alpha");

    rerender(<PlaygroundPage {...props} data={{ ...data, models: [] }} />);
    expect(await screen.findByText("暂无可用模型")).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText("Alpha")).toBeNull();

    rerender(<PlaygroundPage {...props} data={{ ...data, models: [{ id: "b", name: "Beta" }] }} />);
    await waitFor(() => expect(screen.getByRole("combobox").textContent).toContain("Beta"));
    expect((screen.getByRole("combobox") as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables sends and retries when the desktop service stops", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    const stream = vi.spyOn(api, "streamChat").mockResolvedValue(undefined);
    const data = {
      ...emptyDashboard,
      models: [{ id: "a", name: "Alpha" }],
      resources: {
        ...emptyDashboard.resources,
        models: { hasData: true, pending: false, error: "" },
      },
    };
    const props = { data, api, onNavigate: vi.fn(), onRefresh: vi.fn() };
    const { rerender } = render(<PlaygroundPage {...props} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("消息"), "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await screen.findByText("已完成");
    rerender(<PlaygroundPage {...props} serviceAvailable={false} />);
    expect((screen.getByRole("button", { name: "发送" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "重试原请求" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await user.click(screen.getByLabelText("消息"));
    await user.keyboard("{Control>}{Enter}{/Control}");
    expect(stream).toHaveBeenCalledOnce();
  });

  it("keeps the current stream alive while the service drains", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    let signal: AbortSignal | undefined;
    let finish!: () => void;
    vi.spyOn(api, "streamChat").mockImplementation(
      (_model, _prompt, _effort, _update, nextSignal) => {
        signal = nextSignal;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    const data = {
      ...emptyDashboard,
      models: [{ id: "a", name: "Alpha" }],
      resources: {
        ...emptyDashboard.resources,
        models: { hasData: true, pending: false, error: "" },
      },
    };
    const props = { data, api, onNavigate: vi.fn(), onRefresh: vi.fn() };
    const { rerender } = render(<PlaygroundPage {...props} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("消息"), "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));
    rerender(<PlaygroundPage {...props} serviceAvailable={false} />);
    expect(signal?.aborted).toBe(false);
    expect((screen.getByRole("button", { name: "停止生成" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    finish();
    await screen.findByText("已完成");
    expect(signal?.aborted).toBe(false);
  });

  it("renders Markdown and retains the original model for preview and retry", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    const stream = vi
      .spyOn(api, "streamChat")
      .mockImplementation(async (_model, _prompt, _effort, onUpdate) => {
        onUpdate({ content: "# Rendered answer\n\n**Hello**" });
      });
    const data = {
      ...emptyDashboard,
      models: [
        { id: "a", name: "Alpha" },
        { id: "b", name: "Beta" },
      ],
      resources: {
        ...emptyDashboard.resources,
        models: { hasData: true, pending: false, error: "" },
      },
    };
    render(<PlaygroundPage data={data} api={api} onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("消息"), "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));
    expect(await screen.findByRole("heading", { name: "Rendered answer" })).toBeTruthy();
    expect(screen.getByText("Alpha · 自动")).toBeTruthy();
    await user.click(screen.getByRole("combobox"));
    await user.click(await screen.findByRole("option", { name: /Beta/ }));
    expect(screen.getByText("Alpha · 自动")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "重试原请求" }));
    await waitFor(() => expect(stream).toHaveBeenCalledTimes(2));
    expect(stream.mock.calls[1][0].id).toBe("a");
    expect(stream.mock.calls[1][1]).toBe("hello");
  });
  it("aborts a pending stream and lets the user submit again", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    let signal: AbortSignal | undefined;
    vi.spyOn(api, "streamChat").mockImplementation(
      (_model, _prompt, _effort, _update, nextSignal) =>
        new Promise((_resolve, reject) => {
          signal = nextSignal;
          nextSignal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const data = {
      ...emptyDashboard,
      models: [{ id: "a", name: "Alpha" }],
      resources: {
        ...emptyDashboard.resources,
        models: { hasData: true, pending: false, error: "" },
      },
    };
    render(<PlaygroundPage data={data} api={api} onNavigate={vi.fn()} onRefresh={vi.fn()} />);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("消息"), "hello");
    await user.click(screen.getByRole("button", { name: "发送" }));
    await user.click(screen.getByRole("button", { name: "停止生成" }));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText("已停止")).toBeTruthy();
    expect(
      (
        within(screen.getByRole("form", { name: "模型请求" })).getByRole("button", {
          name: "发送",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
});
