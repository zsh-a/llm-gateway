import {
  Activity,
  AlertCircle,
  ChevronLeft,
  ChevronRight,
  Database,
  Gauge,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { GatewayApi } from "../api";
import { DistributionList, Field, MetricChart, StatCard } from "../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Select,
  Spinner,
} from "../components/ui";
import { RequestTable } from "../components/usage";
import { formatCompact, formatDuration, formatNumber } from "../lib/format";
import type {
  DashboardData,
  MetricsQuery,
  MetricsSnapshot,
  MetricsStatus,
  MetricsWindow,
} from "../types";

const windowOptions: Array<{ value: MetricsWindow; label: string }> = [
  { value: "1h", label: "最近 1 小时" },
  { value: "24h", label: "最近 24 小时" },
  { value: "7d", label: "最近 7 天" },
  { value: "30d", label: "最近 30 天" },
];

const statusOptions: Array<{ value: MetricsStatus; label: string }> = [
  { value: "all", label: "全部状态" },
  { value: "success", label: "成功" },
  { value: "error", label: "失败" },
  { value: "canceled", label: "已取消" },
];

function snapshotFromDashboard(data: DashboardData): MetricsSnapshot {
  return {
    summary: data.summary,
    timeseries: data.timeseries,
    recent: data.recent,
    total: data.recent.length,
  };
}

export function MetricsPage({
  data,
  api,
  refreshKey,
}: {
  data: DashboardData;
  api: GatewayApi;
  refreshKey: number;
}) {
  const [filters, setFilters] = useState<MetricsQuery>({
    window: "24h",
    limit: 50,
    offset: 0,
  });
  const [metrics, setMetrics] = useState<MetricsSnapshot>(() => snapshotFromDashboard(data));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retryKey, setRetryKey] = useState(0);
  const reloadToken = `${refreshKey}:${retryKey}`;

  useEffect(() => {
    void reloadToken;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    void api
      .metrics(filters, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setMetrics(next);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "统计数据加载失败");
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [api, filters, reloadToken]);

  const providers = useMemo(
    () =>
      Array.from(
        new Set([
          ...(data.health.providers ?? []),
          ...metrics.summary.byProvider.map((group) => group.key).filter(Boolean),
        ]),
      ).sort(),
    [data.health.providers, metrics.summary.byProvider],
  );
  const models = useMemo(
    () =>
      Array.from(
        new Set([
          ...data.models.map((model) => model.id),
          ...metrics.summary.byModel.map((group) => group.key).filter(Boolean),
        ]),
      ).sort(),
    [data.models, metrics.summary.byModel],
  );
  const hasFilters =
    filters.window !== "24h" || Boolean(filters.provider || filters.model || filters.status);
  const summary = metrics.summary;
  const tokenDetail = [
    `${formatCompact(summary.tokens.inputTokens)} 输入`,
    `${formatCompact(summary.tokens.outputTokens)} 输出`,
    `${formatCompact(summary.tokens.cachedTokens)} 缓存`,
  ].join(" · ");

  const resetFilters = (): void => {
    setFilters({ window: "24h", limit: 50, offset: 0 });
  };
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  const firstRecord = metrics.total === 0 ? 0 : offset + 1;
  const lastRecord = Math.min(offset + metrics.recent.length, metrics.total);

  return (
    <div className="space-y-6" aria-busy={loading}>
      <Card className="border-primary/15 bg-card/80">
        <CardContent className="p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-full sm:w-44">
              <Field label="时间范围" htmlFor="metrics-window">
                <Select
                  id="metrics-window"
                  value={filters.window}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      window: event.target.value as MetricsWindow,
                      offset: 0,
                    }))
                  }
                >
                  {windowOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-full sm:w-44">
              <Field label="Provider" htmlFor="metrics-provider">
                <Select
                  id="metrics-provider"
                  value={filters.provider ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      provider: event.target.value || undefined,
                      offset: 0,
                    }))
                  }
                >
                  <option value="">全部 Provider</option>
                  {providers.map((provider) => (
                    <option key={provider} value={provider}>
                      {provider}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-full sm:w-52">
              <Field label="模型" htmlFor="metrics-model">
                <Select
                  id="metrics-model"
                  value={filters.model ?? ""}
                  onChange={(event) =>
                    setFilters((current) => ({
                      ...current,
                      model: event.target.value || undefined,
                      offset: 0,
                    }))
                  }
                >
                  <option value="">全部模型</option>
                  {models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="w-full sm:w-36">
              <Field label="状态" htmlFor="metrics-status">
                <Select
                  id="metrics-status"
                  value={filters.status ?? "all"}
                  onChange={(event) => {
                    const value = event.target.value as MetricsStatus;
                    setFilters((current) => ({
                      ...current,
                      status: value === "all" ? undefined : value,
                      offset: 0,
                    }));
                  }}
                >
                  {statusOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {hasFilters && (
              <Button variant="ghost" size="sm" onClick={resetFilters}>
                清除筛选
              </Button>
            )}
            <div className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground">
              {loading ? (
                <Spinner className="size-3.5" />
              ) : error ? (
                <Badge variant="warning">数据过期</Badge>
              ) : (
                <Badge variant="success">已同步</Badge>
              )}
              {error ? "当前显示上一次结果" : `共 ${formatNumber(metrics.total)} 条记录`}
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-400/25 bg-red-400/10 px-3.5 py-3 text-sm text-red-200"
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="size-4 shrink-0" />
            统计加载失败：{error}
          </div>
          <Button variant="outline" size="sm" onClick={() => setRetryKey((value) => value + 1)}>
            <RefreshCw className="size-3.5" />
            重试
          </Button>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Activity}
          label="总请求"
          value={formatNumber(summary.requests)}
          detail={`${formatNumber(summary.successes)} 成功 / ${formatNumber(summary.errors)} 失败`}
        />
        <StatCard
          icon={Database}
          label="总 Token"
          value={formatCompact(summary.tokens.totalTokens)}
          detail={tokenDetail}
          tone="cyan"
        />
        <StatCard
          icon={Gauge}
          label="P50 / P95"
          value={`${formatDuration(summary.latency.p50Ms)} / ${formatDuration(summary.latency.p95Ms)}`}
          detail={`最大 ${formatDuration(summary.latency.maxMs)}`}
          tone="amber"
        />
        <StatCard
          icon={ShieldCheck}
          label="成功率"
          value={summary.successRate === null ? "—" : `${Number(summary.successRate).toFixed(2)}%`}
          detail={`${formatNumber(summary.canceled)} 个请求取消`}
          tone="green"
        />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>请求趋势</CardTitle>
          <CardDescription>按当前筛选条件聚合的请求量和 Token 用量</CardDescription>
        </CardHeader>
        <CardContent>
          <MetricChart points={metrics.timeseries} />
        </CardContent>
      </Card>
      <div className="grid gap-6 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>按模型</CardTitle>
            <CardDescription>模型调用分布</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionList groups={summary.byModel} label="模型" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>按 Provider</CardTitle>
            <CardDescription>Provider 路由分布</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionList groups={summary.byProvider} label="Provider" />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>按渠道</CardTitle>
            <CardDescription>实际出站渠道分布</CardDescription>
          </CardHeader>
          <CardContent>
            <DistributionList groups={summary.byChannel} label="渠道" />
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>最近请求</CardTitle>
          <CardDescription>当前筛选条件下的最近调用记录</CardDescription>
        </CardHeader>
        <CardContent>
          <RequestTable rows={metrics.recent} />
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              {metrics.total === 0
                ? "暂无记录"
                : `显示 ${firstRecord}-${lastRecord} / ${metrics.total}`}
            </span>
            {metrics.total > limit && (
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      offset: Math.max(0, (current.offset ?? 0) - limit),
                    }))
                  }
                  disabled={offset === 0 || loading}
                >
                  <ChevronLeft className="size-3.5" />
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setFilters((current) => ({
                      ...current,
                      offset: (current.offset ?? 0) + limit,
                    }))
                  }
                  disabled={offset + metrics.recent.length >= metrics.total || loading}
                >
                  下一页
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
