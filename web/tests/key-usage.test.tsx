import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { GatewayApi } from "../src/api";
import { KeyUsageTable } from "../src/features/metrics/KeyUsageTable";
import { MetricsPage } from "../src/features/metrics/MetricsPage";
import { emptyDashboard, emptySummary } from "../src/lib/constants";
import type { ApiKeyRecord, KeyUsage } from "../src/types";

const key: ApiKeyRecord = {
  id: "key-a",
  name: "Client A",
  prefix: "sk-gw-test",
  enabled: true,
  allowedModels: [],
  rpmLimit: null,
  tpmLimit: null,
  quotaTokens: 100,
  usedTokens: 7,
  remainingTokens: 93,
};
const entry: KeyUsage = {
  key,
  activeRequests: 1,
  usage: {
    key: key.id,
    requests: 2,
    successes: 1,
    errors: 1,
    successRate: 0.5,
    averageMs: 100,
    tokens: { totalTokens: 7, inputTokens: 5, outputTokens: 2, requestsWithoutUsage: 1 },
  },
};

describe("administrator key usage", () => {
  it("filters all metric views by key and links management to the selected key", async () => {
    const user = userEvent.setup();
    const api = new GatewayApi({ apiKey: "", adminKey: "admin" });
    const summary = vi.spyOn(api, "metricsSummary").mockImplementation(async ({ apiKeyId }) => ({
      ...emptySummary,
      requests: apiKeyId ? 2 : 5,
      keyUsage: [entry],
    }));
    const series = vi.spyOn(api, "metricsTimeseries").mockResolvedValue([]);
    const requests = vi.spyOn(api, "metricsRequests").mockResolvedValue({ recent: [], total: 0 });
    const navigate = vi.fn();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const view = render(
      <QueryClientProvider client={client}>
        <MetricsPage data={{ ...emptyDashboard, keys: [key] }} api={api} onNavigate={navigate} />
      </QueryClientProvider>,
    );
    const table = await screen.findByRole("table", { name: "Key 用量" });
    await user.click(within(table).getByRole("button", { name: "Client A" }));
    await waitFor(() => expect(summary.mock.calls.at(-1)?.[0].apiKeyId).toBe("key-a"));
    expect(series.mock.calls.at(-1)?.[0].apiKeyId).toBe("key-a");
    expect(requests.mock.calls.at(-1)?.[0].apiKeyId).toBe("key-a");
    await user.click(within(table).getByRole("button", { name: "管理" }));
    expect(navigate).toHaveBeenCalledWith("management", { apiKeyId: "key-a" });
    await user.click(screen.getByRole("button", { name: "返回全部 Key" }));
    await waitFor(() =>
      expect((screen.getByLabelText("API Key") as HTMLSelectElement).value).toBe(""),
    );
    view.unmount();
    client.clear();
  });
  it("keeps revoked keys visible, disables management, and marks missing usage", async () => {
    const user = userEvent.setup();
    const revoked = { ...entry, key: { ...key, id: "revoked", name: "Old client", revokedAt: 1 } };
    render(<KeyUsageTable items={[entry, revoked]} onSelect={vi.fn()} onManage={vi.fn()} />);
    await user.selectOptions(screen.getByLabelText("Key 状态"), "已撤销");
    expect(screen.queryByRole("button", { name: "Client A" })).toBeNull();
    expect(screen.getByRole("button", { name: "Old client" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "管理" })).toBeNull();
    expect(screen.getByText("1 次用量未知")).toBeTruthy();
  });
});
