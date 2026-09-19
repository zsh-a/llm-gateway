import { QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GatewayApi } from "../src/api";
import { ManagementPage } from "../src/features/management/ManagementPage";
import { emptyDashboard } from "../src/lib/constants";
import { queryClient } from "../src/lib/query";

const loaded = { hasData: true, pending: false, error: "" };
const data = {
  ...emptyDashboard,
  health: { status: "ok", providers: ["mimo"] },
  resources: { ...emptyDashboard.resources, channels: loaded, keys: loaded, models: loaded },
};

afterEach(() => queryClient.clear());

function renderManagement(api: GatewayApi) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ManagementPage data={data} api={api} onNotice={vi.fn()} onNavigate={vi.fn()} />
    </QueryClientProvider>,
  );
}

describe("management sheets", () => {
  it("guards unsaved changes, preserves them when canceled and restores trigger focus", async () => {
    const user = userEvent.setup();
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    const save = vi.spyOn(api, "saveChannel");
    renderManagement(api);
    const trigger = screen.getByRole("button", { name: "新增渠道" });
    await user.click(trigger);
    await user.type(await screen.findByLabelText("显示名称"), "Draft channel");
    await user.keyboard("{Escape}");
    let confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "取消" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect((screen.getByLabelText("显示名称") as HTMLInputElement).value).toBe("Draft channel");
    await user.click(screen.getByRole("button", { name: "关闭面板" }));
    confirmation = await screen.findByRole("alertdialog");
    await user.click(within(confirmation).getByRole("button", { name: "放弃修改" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a newly created secret until the user explicitly acknowledges it", async () => {
    const user = userEvent.setup();
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    vi.spyOn(api, "createKey").mockResolvedValue({ secret: "sk-regression-test-only" } as Awaited<
      ReturnType<GatewayApi["createKey"]>
    >);
    renderManagement(api);
    await user.click(screen.getByRole("tab", { name: /API Keys/ }));
    await user.click(screen.getByRole("button", { name: "创建 Key" }));
    await user.type(await screen.findByLabelText("Key 名称"), "Development");
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "创建 Key" }));
    expect(await screen.findByText("sk-regression-test-only")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.getByText("sk-regression-test-only")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "已保存，关闭" }));
    await waitFor(() => expect(screen.queryByText("sk-regression-test-only")).toBeNull());
  });
});
