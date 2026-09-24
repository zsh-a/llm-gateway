import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { GatewayApi } from "../src/api";
import { emptySummary } from "../src/lib/constants";
import { useGatewayHealth, useMetrics } from "../src/lib/gateway-queries";
import { gatewayQueryKeys } from "../src/lib/query";

function clientWrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60000, gcTime: 0 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("resource queries", () => {
  it("applies request diagnostics filters without refetching or narrowing aggregates", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    const summary = vi
      .spyOn(api, "metricsSummary")
      .mockResolvedValue({ ...emptySummary, requests: 12 });
    const series = vi.spyOn(api, "metricsTimeseries").mockResolvedValue([]);
    const requests = vi
      .spyOn(api, "metricsRequests")
      .mockImplementation(async ({ requestId }) => ({ recent: [], total: requestId ? 1 : 12 }));
    const { client, wrapper } = clientWrapper();
    const { result, rerender, unmount } = renderHook(
      ({ requestId }) => useMetrics(api, { window: "24h", requestId, finishReason: "length" }),
      { wrapper, initialProps: { requestId: "" } },
    );
    await waitFor(() => expect(result.current.data?.total).toBe(12));
    rerender({ requestId: "request-a" });
    await waitFor(() => expect(result.current.data?.total).toBe(1));
    expect(result.current.data?.summary.requests).toBe(12);
    expect(summary).toHaveBeenCalledOnce();
    expect(series).toHaveBeenCalledOnce();
    expect(summary.mock.calls[0][0]).not.toHaveProperty("finishReason");
    expect(requests.mock.calls.at(-1)?.[0]).toMatchObject({
      requestId: "request-a",
      finishReason: "length",
    });
    unmount();
    client.clear();
  });
  it("keeps a complete snapshot until all filtered resources finish", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    vi.spyOn(api, "metricsSummary").mockImplementation(async ({ provider }) => ({
      ...emptySummary,
      requests: provider ? 3 : 12,
    }));
    vi.spyOn(api, "metricsTimeseries").mockResolvedValue([]);
    let finishRequests: ((value: { recent: []; total: number }) => void) | undefined;
    vi.spyOn(api, "metricsRequests").mockImplementation(async ({ provider }) =>
      provider
        ? new Promise((resolve) => {
            finishRequests = resolve;
          })
        : { recent: [], total: 12 },
    );
    const { client, wrapper } = clientWrapper();
    const { result, rerender, unmount } = renderHook(
      ({ provider }) => useMetrics(api, { window: "24h", provider }),
      { wrapper, initialProps: { provider: "" } },
    );
    await waitFor(() => expect(result.current.data?.total).toBe(12));
    rerender({ provider: "mimo" });
    await waitFor(() =>
      expect(
        client.getQueryData(
          gatewayQueryKeys.metric(api.baseUrl, "summary", { window: "24h", provider: "mimo" }),
        ),
      ).toMatchObject({ requests: 3 }),
    );
    expect(result.current.data?.summary.requests).toBe(12);
    expect(result.current.data?.total).toBe(12);
    expect(result.current.isPlaceholderData).toBe(true);
    await act(async () => finishRequests?.({ recent: [], total: 3 }));
    await waitFor(() => expect(result.current.data?.total).toBe(3));
    expect(result.current.data?.summary.requests).toBe(3);
    expect(result.current.isPlaceholderData).toBe(false);
    unmount();
    client.clear();
  });
  it("does not fetch unrelated resources on the settings page and exposes health failures", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    vi.spyOn(api, "health").mockRejectedValue(new Error("Offline"));
    const models = vi.spyOn(api, "models");
    const metrics = vi.spyOn(api, "metricsSummary");
    const channels = vi.spyOn(api, "channels");
    const { client, wrapper } = clientWrapper();
    const { result, unmount } = renderHook(() => useGatewayHealth(api, true), {
      wrapper,
    });
    await waitFor(() => expect(result.current.error).toBe("Offline"));
    expect(result.current.data.status).toBe("offline");
    expect(models).not.toHaveBeenCalled();
    expect(metrics).not.toHaveBeenCalled();
    expect(channels).not.toHaveBeenCalled();
    unmount();
    client.clear();
  });
  it("fetches only the request list on pagination and refreshes the active filtered queries", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    const summary = vi.spyOn(api, "metricsSummary").mockResolvedValue(emptySummary);
    const series = vi.spyOn(api, "metricsTimeseries").mockResolvedValue([]);
    const requests = vi.spyOn(api, "metricsRequests").mockResolvedValue({ recent: [], total: 100 });
    const { client, wrapper } = clientWrapper();
    const { result, rerender, unmount } = renderHook(
      ({ offset }) => useMetrics(api, { window: "24h", provider: "mimo", limit: 50, offset }),
      { wrapper, initialProps: { offset: 0 } },
    );
    await waitFor(() => expect(result.current.data?.total).toBe(100));
    rerender({ offset: 50 });
    await waitFor(() => expect(requests).toHaveBeenCalledTimes(2));
    expect(summary).toHaveBeenCalledTimes(1);
    expect(series).toHaveBeenCalledTimes(1);
    await act(() => client.refetchQueries({ queryKey: gatewayQueryKeys.all, type: "active" }));
    expect(summary).toHaveBeenCalledTimes(2);
    expect(series).toHaveBeenCalledTimes(2);
    expect(requests).toHaveBeenCalledTimes(3);
    expect(requests.mock.calls.at(-1)?.[0]).toMatchObject({ provider: "mimo", offset: 50 });
    unmount();
    client.clear();
  });
  it("retains successful data on refresh failure and exposes the error", async () => {
    const api = new GatewayApi({ apiKey: "", adminKey: "" });
    const summary = vi
      .spyOn(api, "metricsSummary")
      .mockResolvedValue({ ...emptySummary, requests: 12 });
    vi.spyOn(api, "metricsTimeseries").mockResolvedValue([]);
    vi.spyOn(api, "metricsRequests").mockResolvedValue({ recent: [], total: 12 });
    const { client, wrapper } = clientWrapper();
    const { result, unmount } = renderHook(() => useMetrics(api, { window: "24h" }), { wrapper });
    await waitFor(() => expect(result.current.data?.summary.requests).toBe(12));
    summary.mockRejectedValue(new Error("Connection lost"));
    await act(() => result.current.refetch());
    await waitFor(() => expect(result.current.error).toBe("Connection lost"));
    expect(result.current.data?.summary.requests).toBe(12);
    unmount();
    client.clear();
  });
});
