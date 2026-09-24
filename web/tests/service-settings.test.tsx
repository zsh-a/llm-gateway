import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ServiceSettingsCard } from "../src/features/settings/ServiceSettingsCard";
import { getServiceSettings, saveServiceSettings } from "../src/service-settings";

vi.mock("../src/platform", () => ({ isTauriRuntime: () => true }));
vi.mock("../src/service-settings", () => ({
  getServiceSettings: vi.fn(),
  saveServiceSettings: vi.fn(),
}));

describe("service configuration recovery", () => {
  it("blocks default values after load failure and requires valid changed settings", async () => {
    vi.mocked(getServiceSettings)
      .mockRejectedValueOnce(new Error("IPC unavailable"))
      .mockResolvedValue({
        host: "127.0.0.1",
        port: 4567,
        corsOrigin: "",
        connectTimeoutMs: 15000,
        firstByteTimeoutMs: 180000,
        idleTimeoutMs: 180000,
      });
    vi.mocked(saveServiceSettings).mockResolvedValue(undefined);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const view = render(
      <QueryClientProvider client={client}>
        <ServiceSettingsCard onNotice={vi.fn()} />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    expect((await screen.findByRole("alert")).textContent).toContain("IPC unavailable");
    const save = screen.getByRole("button", { name: "保存并重启" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await user.click(save);
    expect(saveServiceSettings).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "重新加载配置" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Port") as HTMLInputElement).value).toBe("4567"),
    );
    expect(save.disabled).toBe(true);
    const port = screen.getByLabelText("Port");
    await user.clear(port);
    await user.type(port, "0");
    await user.click(save);
    expect(await screen.findByText("端口必须是 1–65535 的整数")).toBeTruthy();
    expect(document.activeElement).toBe(port);
    expect(saveServiceSettings).not.toHaveBeenCalled();
    await user.clear(port);
    await user.type(port, "4568");
    await user.click(save);
    await waitFor(() =>
      expect(saveServiceSettings).toHaveBeenCalledWith(expect.objectContaining({ port: 4568 })),
    );
    view.unmount();
    client.clear();
  });
});
