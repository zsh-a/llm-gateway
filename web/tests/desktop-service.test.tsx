import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ServiceBanner } from "../src/components/ServiceBanner";
import { type DesktopService, useDesktopService } from "../src/lib/desktop-service";
import type { ServiceStatus } from "../src/service-settings";

const bridge = vi.hoisted(() => ({
  native: vi.fn(),
  listen: vi.fn(),
  status: vi.fn(),
  control: vi.fn(),
  force: vi.fn(),
  notices: vi.fn(),
}));
vi.mock("../src/platform", () => ({ isTauriRuntime: bridge.native }));
vi.mock("../src/service-settings", () => ({
  listenServiceStatus: bridge.listen,
  getServiceStatus: bridge.status,
  controlService: bridge.control,
  forceQuit: bridge.force,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.notices }));

const running: ServiceStatus = {
  phase: "running",
  baseUrl: "http://127.0.0.1:3456",
  activeRequests: 0,
  error: null,
  canForceExit: false,
};
const notice = vi.fn();
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.resetAllMocks();
  bridge.native.mockReturnValue(true);
  bridge.listen.mockResolvedValue(vi.fn());
  bridge.notices.mockResolvedValue(vi.fn());
  bridge.status.mockResolvedValue(running);
  bridge.control.mockResolvedValue(undefined);
  bridge.force.mockResolvedValue(undefined);
});

describe("desktop status bridge", () => {
  it("does not access native APIs in a browser", () => {
    bridge.native.mockReturnValue(false);
    const { result } = renderHook(() => useDesktopService(notice));
    expect(result.current.native).toBe(false);
    expect(bridge.listen).not.toHaveBeenCalled();
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"])(
    "keeps newer events when the initial snapshot ends in %s",
    async (outcome) => {
      const initial = deferred<ServiceStatus>();
      bridge.status.mockReturnValue(initial.promise);
      const { result } = renderHook(() => useDesktopService(notice));
      await waitFor(() => expect(bridge.status).toHaveBeenCalledOnce());
      const stopping = { ...running, phase: "stopping" as const, activeRequests: 2 };
      act(() => bridge.listen.mock.calls[0][0](stopping));
      await act(async () => {
        if (outcome === "success") initial.resolve(running);
        else initial.reject(new Error("stale IPC failure"));
      });
      expect(result.current.status).toEqual(stopping);
      expect(result.current.error).toBe("");
    },
  );

  it("cleans up a subscription that completes after unmount", async () => {
    const pending = deferred<() => void>();
    const cleanup = vi.fn();
    bridge.listen.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() => useDesktopService(notice));
    unmount();
    await act(async () => pending.resolve(cleanup));
    expect(cleanup).toHaveBeenCalledOnce();
    expect(bridge.status).not.toHaveBeenCalled();
  });

  it("reconnects after a failed snapshot and removes the old listener", async () => {
    const cleanup = vi.fn();
    bridge.listen.mockResolvedValue(cleanup);
    bridge.status.mockRejectedValueOnce(new Error("IPC unavailable"));
    const { result } = renderHook(() => useDesktopService(notice));
    await waitFor(() => expect(result.current.error).toBe("IPC unavailable"));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toEqual(running));
    expect(result.current.error).toBe("");
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("reports control failures and clears busy state", async () => {
    bridge.control.mockRejectedValue(new Error("服务正在处理上一项操作"));
    const { result } = renderHook(() => useDesktopService(notice));
    await act(async () => result.current.control("restart"));
    expect(notice).toHaveBeenCalledWith("服务正在处理上一项操作", "error");
    expect(result.current.busy).toBe(false);
  });
});

function service(status: ServiceStatus): DesktopService {
  return {
    native: true,
    status,
    error: "",
    busy: false,
    control: vi.fn(),
    force: vi.fn(),
    retry: vi.fn(),
  };
}

describe("service availability banner", () => {
  it("offers recovery for a stopped or failed service and hides when running", async () => {
    const current = service({ ...running, phase: "failed", error: "无法监听 127.0.0.1:3000" });
    const { rerender } = render(<ServiceBanner service={current} />);
    expect(screen.getByRole("alert").textContent).toContain("无法监听");
    await userEvent.setup().click(screen.getByRole("button", { name: "启动服务" }));
    expect(current.control).toHaveBeenCalledWith("start");
    rerender(<ServiceBanner service={service({ ...running, phase: "stopped" })} />);
    expect(screen.getByText(/本机网关已停止/)).toBeTruthy();
    rerender(<ServiceBanner service={service(running)} />);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("requires explicit confirmation before interrupting active requests", async () => {
    const current = service({
      ...running,
      phase: "stopping",
      activeRequests: 2,
      canForceExit: true,
    });
    render(<ServiceBanner service={current} />);
    const user = userEvent.setup();
    expect(screen.getByText(/等待 2 个请求完成/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "强制退出" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(current.force).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(current.force).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "强制退出" }));
    await user.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "中断请求并退出",
      }),
    );
    expect(current.force).toHaveBeenCalledOnce();
  });
});
