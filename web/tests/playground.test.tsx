import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GatewayApi } from "../src/api";
import { PlaygroundPage } from "../src/features/playground/PlaygroundPage";
import { emptyDashboard } from "../src/lib/constants";

describe("playground request identity", () => {
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
