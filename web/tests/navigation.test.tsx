import { QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { GatewayApi } from "../src/api";
import { emptySummary } from "../src/lib/constants";
import { queryClient } from "../src/lib/query";

vi.mock("../src/lib/desktop-service", () => ({
  useDesktopService: () => ({ native: false, status: null, error: "", busy: false }),
}));
vi.mock("../src/lib/desktop-updates", () => ({
  useDesktopUpdates: () => ({
    native: true,
    status: {
      phase: "available",
      currentVersion: "1.3.1",
      version: "1.3.2",
      downloadedBytes: 0,
      totalBytes: null,
      notes: null,
      lastChecked: null,
      error: null,
    },
    pending: false,
    error: "",
    run: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
  }),
}));

beforeEach(() => {
  queryClient.clear();
  vi.spyOn(GatewayApi.prototype, "health").mockResolvedValue({ status: "ok", providers: ["mimo"] });
  vi.spyOn(GatewayApi.prototype, "auth").mockResolvedValue({ providers: {} });
  vi.spyOn(GatewayApi.prototype, "models").mockResolvedValue([]);
  vi.spyOn(GatewayApi.prototype, "channels").mockResolvedValue([]);
  vi.spyOn(GatewayApi.prototype, "keys").mockResolvedValue([]);
  vi.spyOn(GatewayApi.prototype, "metricsSummary").mockResolvedValue(emptySummary);
  vi.spyOn(GatewayApi.prototype, "metricsTimeseries").mockResolvedValue([]);
  vi.spyOn(GatewayApi.prototype, "metricsRequests").mockResolvedValue({ recent: [], total: 0 });
});
afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "#overview");
});

describe("application navigation and query ownership", () => {
  it("keeps settings, deep links and the update banner on one route state", async () => {
    window.history.replaceState(null, "", "#settings?tab=updates");
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "应用更新" }).getAttribute("aria-selected")).toBe(
        "true",
      ),
    );
    expect(screen.queryByRole("button", { name: "详情" })).toBeNull();
    await user.click(screen.getByRole("link", { name: "设置" }));
    expect(window.location.hash).toBe("#settings");
    expect(screen.getByRole("tab", { name: "连接与凭证" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "详情" }));
    expect(window.location.hash).toBe("#settings?tab=updates");
    expect(screen.getByRole("tab", { name: "应用更新" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    act(() => {
      window.history.replaceState(null, "", "#settings?tab=appearance");
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(screen.getByRole("tab", { name: "外观" }).getAttribute("aria-selected")).toBe("true");
    act(() => {
      window.history.replaceState(null, "", "#settings?tab=updates");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(screen.getByRole("tab", { name: "应用更新" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(GatewayApi.prototype.models).not.toHaveBeenCalled();
    expect(GatewayApi.prototype.metricsSummary).not.toHaveBeenCalled();
  });

  it("mounts only the active feature queries and releases them when leaving", async () => {
    window.history.replaceState(null, "", "#settings");
    render(
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await screen.findByRole("tab", { name: "连接与凭证" });
    await user.click(screen.getByRole("link", { name: "概览" }));
    await waitFor(() => expect(GatewayApi.prototype.metricsSummary).toHaveBeenCalledOnce());
    expect(GatewayApi.prototype.models).toHaveBeenCalledOnce();
    expect(GatewayApi.prototype.auth).toHaveBeenCalledOnce();
    expect(GatewayApi.prototype.channels).not.toHaveBeenCalled();
    await user.click(screen.getByRole("link", { name: "资源管理" }));
    await waitFor(() => expect(GatewayApi.prototype.channels).toHaveBeenCalledOnce());
    expect(GatewayApi.prototype.keys).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("link", { name: "设置" }));
    await screen.findByRole("tab", { name: "连接与凭证" });
    const active = queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.getObserversCount() > 0);
    expect(active.map((query) => query.queryKey.at(-1))).toEqual(["health"]);
  });
});
