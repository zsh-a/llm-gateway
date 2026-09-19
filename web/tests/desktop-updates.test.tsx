import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateStatus } from "../src/app-updates";
import { UpdateBanner } from "../src/components/UpdateBanner";
import { ApplicationUpdateCard } from "../src/features/settings/ApplicationUpdateCard";
import { SettingsPage } from "../src/features/settings/SettingsPage";
import { type DesktopUpdates, useDesktopUpdates } from "../src/lib/desktop-updates";

const bridge = vi.hoisted(() => ({
  native: vi.fn(),
  listen: vi.fn(),
  status: vi.fn(),
  run: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("../src/remote-sync", () => ({ isTauriRuntime: bridge.native }));
vi.mock("../src/app-updates", () => ({
  listenUpdateStatus: bridge.listen,
  getUpdateStatus: bridge.status,
  runUpdateAction: bridge.run,
  cancelUpdate: bridge.cancel,
}));

const initial: UpdateStatus = {
  phase: "idle",
  currentVersion: "1.2.3",
  version: null,
  notes: null,
  downloadedBytes: 0,
  totalBytes: null,
  lastChecked: null,
  error: null,
};
const notice = vi.fn();
function controller(overrides: Partial<UpdateStatus> = {}): DesktopUpdates {
  return {
    native: true,
    status: { ...initial, ...overrides },
    error: "",
    pending: false,
    run: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks();
  window.history.replaceState(null, "", "#settings");
  bridge.native.mockReturnValue(true);
  bridge.listen.mockResolvedValue(vi.fn());
  bridge.status.mockResolvedValue(initial);
  bridge.run.mockResolvedValue(undefined);
  bridge.cancel.mockResolvedValue(undefined);
});

describe("desktop updater bridge", () => {
  it("never invokes native update APIs in the web console", () => {
    bridge.native.mockReturnValue(false);
    const { result } = renderHook(() => useDesktopUpdates(notice));
    expect(result.current.native).toBe(false);
    expect(bridge.listen).not.toHaveBeenCalled();
    expect(bridge.status).not.toHaveBeenCalled();
  });
  it.each(["success", "failure"])(
    "keeps newer progress when a stale snapshot ends in %s",
    async (outcome) => {
      const pending = deferred<UpdateStatus>();
      bridge.status.mockReturnValue(pending.promise);
      const { result } = renderHook(() => useDesktopUpdates(notice));
      await waitFor(() => expect(bridge.status).toHaveBeenCalledOnce());
      const downloading = { ...initial, phase: "downloading" as const, downloadedBytes: 2048 };
      act(() => bridge.listen.mock.calls[0][0](downloading));
      await act(async () => {
        if (outcome === "success") pending.resolve(initial);
        else pending.reject(new Error("stale"));
      });
      expect(result.current.status).toEqual(downloading);
      expect(result.current.error).toBe("");
    },
  );
  it("unsubscribes after unmount without cancelling the backend download", async () => {
    const pending = deferred<() => void>();
    const cleanup = vi.fn();
    bridge.listen.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() => useDesktopUpdates(notice));
    unmount();
    await act(async () => pending.resolve(cleanup));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(bridge.status).not.toHaveBeenCalled();
  });
  it("reports command failures and permits retry", async () => {
    bridge.run.mockRejectedValueOnce(new Error("签名验证失败"));
    const { result } = renderHook(() => useDesktopUpdates(notice));
    await act(async () => result.current.run("download_update"));
    expect(notice).toHaveBeenCalledWith("签名验证失败", "error");
    expect(result.current.pending).toBe(false);
    await act(async () => result.current.run("download_update"));
    expect(bridge.run).toHaveBeenCalledTimes(2);
  });
});

describe("application update UI", () => {
  it("separates downloading from installation", async () => {
    const updates = controller({ phase: "available", version: "1.2.4", notes: "修复长对话" });
    const { rerender } = render(<ApplicationUpdateCard updates={updates} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "下载更新" }));
    expect(updates.run).toHaveBeenCalledWith("download_update");
    expect(screen.queryByRole("button", { name: "更新并重启" })).toBeNull();
    const ready = controller({ phase: "ready", version: "1.2.4" });
    rerender(<ApplicationUpdateCard updates={ready} />);
    await user.click(screen.getByRole("button", { name: "更新并重启" }));
    expect(ready.run).toHaveBeenCalledWith("install_update");
  });
  it("allows cancelling a drain but not an installer handoff", async () => {
    const draining = controller({ phase: "draining", version: "1.2.4" });
    const { rerender } = render(<ApplicationUpdateCard updates={draining} activeRequests={2} />);
    expect(screen.getByText(/等待 2 个请求完成/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole("button", { name: "稍后更新，恢复服务" }));
    expect(draining.cancel).toHaveBeenCalledOnce();
    for (const phase of ["stopping", "installing"] as const) {
      rerender(<ApplicationUpdateCard updates={controller({ phase, version: "1.2.4" })} />);
      expect(screen.queryByRole("button", { name: /稍后更新/ })).toBeNull();
      expect(screen.getByRole("button", { name: "检查更新" }).hasAttribute("disabled")).toBe(true);
    }
  });
  it("shows indeterminate progress until content length is known", () => {
    const { rerender } = render(
      <ApplicationUpdateCard
        updates={controller({ phase: "downloading", downloadedBytes: 1024 })}
      />,
    );
    expect(screen.getByRole("progressbar").hasAttribute("value")).toBe(false);
    rerender(
      <ApplicationUpdateCard
        updates={controller({ phase: "downloading", downloadedBytes: 1024, totalBytes: 2048 })}
      />,
    );
    expect(screen.getByRole("progressbar").getAttribute("value")).toBe("1024");
  });
  it("dismissing an available update does not trigger installation", async () => {
    const updates = controller({ phase: "available", version: "1.2.4" });
    render(<UpdateBanner updates={updates} activeRequests={0} />);
    await userEvent.setup().click(screen.getByRole("button", { name: "稍后提醒" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(updates.run).not.toHaveBeenCalled();
  });
  it("opens the update tab from the tray deep link", () => {
    window.history.replaceState(null, "", "#settings?tab=updates");
    render(
      <SettingsPage
        credentials={{ apiKey: "", adminKey: "" }}
        onCredentials={vi.fn()}
        themePreference="system"
        onThemePreference={vi.fn()}
        onNotice={notice}
        gatewayUrl=""
        updates={controller()}
      />,
    );
    expect(screen.getByRole("tab", { name: "应用更新" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByText("v1.2.3")).toBeTruthy();
  });
});
