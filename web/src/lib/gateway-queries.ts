import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { ApiError, type GatewayApi } from "../api";
import type {
  DashboardData,
  MetricsQuery,
  MetricsSnapshot,
  PageKey,
  ResourceState,
} from "../types";
import { emptyDashboard } from "./constants";
import { gatewayQueryKeys, queryErrorMessage } from "./query";

const overviewMetrics: MetricsQuery = { window: "24h", limit: 6, offset: 0 };

function resourceState(query: {
  isPending: boolean;
  error: unknown;
  data: unknown;
}): ResourceState {
  return {
    pending: query.isPending,
    error: query.error ? queryErrorMessage(query.error, "加载失败，请重试") : "",
    hasData: query.data !== undefined,
  };
}

export function useMetrics(api: GatewayApi, filters: MetricsQuery, enabled = true) {
  // Pagination changes only the request list, not the chart or summary.
  const { limit: _limit, offset: _offset, ...aggregate } = filters;
  const options = {
    enabled,
    refetchInterval: enabled ? 10000 : false,
    refetchIntervalInBackground: false,
    placeholderData: keepPreviousData,
  } as const;
  const summary = useQuery({
    ...options,
    queryKey: gatewayQueryKeys.metric(api.baseUrl, "summary", aggregate),
    queryFn: ({ signal }) => api.metricsSummary(aggregate, signal),
  });
  const timeseries = useQuery({
    ...options,
    queryKey: gatewayQueryKeys.metric(api.baseUrl, "timeseries", aggregate),
    queryFn: ({ signal }) => api.metricsTimeseries(aggregate, signal),
  });
  const requests = useQuery({
    ...options,
    queryKey: gatewayQueryKeys.metric(api.baseUrl, "requests", filters),
    queryFn: ({ signal }) => api.metricsRequests(filters, signal),
  });
  const nextData: MetricsSnapshot | undefined =
    summary.data && timeseries.data && requests.data
      ? { summary: summary.data, timeseries: timeseries.data, ...requests.data }
      : undefined;
  const placeholder =
    summary.isPlaceholderData || timeseries.isPlaceholderData || requests.isPlaceholderData;
  const previous = useRef<{ api: GatewayApi; data: MetricsSnapshot } | null>(null);
  useEffect(() => {
    if (nextData && !placeholder) previous.current = { api, data: nextData };
  }, [api, nextData, placeholder]);
  // Keep one complete snapshot while filters change; never mix a new summary
  // with an old request list. Credential changes must not retain this snapshot.
  const currentData = !placeholder ? nextData : undefined;
  const data = currentData ?? (previous.current?.api === api ? previous.current.data : undefined);
  const error = [summary, timeseries, requests].find((query) => query.error)?.error;
  return {
    data,
    authError: error instanceof ApiError && [401, 403, 503].includes(error.status),
    lastUpdated: Math.min(summary.dataUpdatedAt, timeseries.dataUpdatedAt, requests.dataUpdatedAt),
    error: error ? queryErrorMessage(error, "统计数据加载失败") : "",
    isPending: !data && !error,
    isFetching: summary.isFetching || timeseries.isFetching || requests.isFetching,
    isPlaceholderData: Boolean(data && !currentData),
    refetch: () => Promise.all([summary.refetch(), timeseries.refetch(), requests.refetch()]),
  };
}

export function useGatewayDashboard(api: GatewayApi, enabled: boolean, page: PageKey) {
  const health = useQuery({
    queryKey: gatewayQueryKeys.resource(api.baseUrl, "health"),
    queryFn: ({ signal }) => api.health(signal),
    enabled,
    refetchInterval: enabled ? 10000 : false,
  });
  const auth = useQuery({
    queryKey: gatewayQueryKeys.resource(api.baseUrl, "auth"),
    queryFn: ({ signal }) => api.auth(signal),
    enabled: enabled && (page === "overview" || page === "management"),
    staleTime: 30000,
    refetchInterval: page === "overview" || page === "management" ? 30000 : false,
  });
  const models = useQuery({
    queryKey: gatewayQueryKeys.resource(api.baseUrl, "models"),
    queryFn: ({ signal }) => api.models(signal),
    enabled: enabled && page !== "settings",
    staleTime: 60000,
    refetchInterval: page !== "settings" ? 60000 : false,
  });
  const channels = useQuery({
    queryKey: gatewayQueryKeys.resource(api.baseUrl, "channels"),
    queryFn: ({ signal }) => api.channels(signal),
    enabled: enabled && page === "management",
    staleTime: 30000,
  });
  const keys = useQuery({
    queryKey: gatewayQueryKeys.resource(api.baseUrl, "keys"),
    queryFn: ({ signal }) => api.keys(signal),
    enabled: enabled && (page === "management" || (page === "metrics" && api.isAdministrator)),
    staleTime: 30000,
  });
  const metrics = useMetrics(api, overviewMetrics, enabled && page === "overview");
  const data: DashboardData = {
    ...emptyDashboard,
    health: health.isError ? { status: "offline" } : (health.data ?? { status: "starting" }),
    auth: auth.data ?? emptyDashboard.auth,
    models: models.data ?? [],
    channels: channels.data ?? [],
    keys: keys.data ?? [],
    summary: metrics.data?.summary ?? emptyDashboard.summary,
    timeseries: metrics.data?.timeseries ?? [],
    recent: metrics.data?.recent ?? [],
    adminError: [channels.error, keys.error]
      .filter(Boolean)
      .map((error) => queryErrorMessage(error, "管理接口不可用"))
      .join("；"),
    resources: {
      auth: resourceState(auth),
      models: resourceState(models),
      channels: resourceState(channels),
      keys: resourceState(keys),
      metrics: { pending: metrics.isPending, error: metrics.error, hasData: Boolean(metrics.data) },
    },
  };
  return {
    data,
    healthError: health.error ? queryErrorMessage(health.error, "无法连接网关") : "",
    lastUpdated: health.dataUpdatedAt || null,
  };
}
