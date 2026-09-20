import { Activity, Database, Gauge, ShieldCheck } from "lucide-react";
import { useState } from "react";
import type { GatewayApi } from "../../api";
import {
  DistributionList,
  EmptyState,
  Field,
  MetricChart,
  ResourceContent,
  StatCard,
} from "../../components/common";
import { ModelPicker } from "../../components/ModelPicker";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Select,
  Spinner,
} from "../../components/ui";
import { RequestTable } from "../../components/usage";
import { emptySummary } from "../../lib/constants";
import { formatCompact, formatDuration, formatNumber } from "../../lib/format";
import { useMetrics } from "../../lib/gateway-queries";
import type { DashboardData, MetricsQuery, MetricsWindow } from "../../types";

export function MetricsPage({
  data,
  api,
  enabled = true,
}: {
  data: DashboardData;
  api: GatewayApi;
  enabled?: boolean;
}) {
  const [filters, setFilters] = useState<MetricsQuery>({ window: "24h", limit: 50, offset: 0 });
  const query = useMetrics(api, filters, enabled);
  const metrics = query.data ?? { summary: emptySummary, timeseries: [], recent: [], total: 0 };
  const summary = metrics.summary;
  const providers = Array.from(
    new Set([...(data.health.providers ?? []), ...summary.byProvider.map((group) => group.key)]),
  ).filter(Boolean);
  const knownModels = new Map(data.models.map((model) => [model.id, model]));
  for (const group of summary.byModel)
    if (!knownModels.has(group.key)) knownModels.set(group.key, { id: group.key });
  const models = [{ id: "", name: "全部模型" }, ...knownModels.values()];
  const hasFilters =
    filters.window !== "24h" || Boolean(filters.provider || filters.model || filters.status);
  const reset = () => setFilters({ window: "24h", limit: 50, offset: 0 });
  const offset = filters.offset ?? 0;
  const limit = filters.limit ?? 50;
  const update = (next: Partial<MetricsQuery>) =>
    setFilters((current) => ({ ...current, ...next, offset: 0 }));
  const state = { pending: query.isPending, error: query.error, hasData: Boolean(query.data) };

  return (
    <div className="space-y-5">
      <div className="grid items-end gap-3 rounded-xl border bg-card p-4 sm:grid-cols-2 xl:grid-cols-[10rem_1fr_1.5fr_9rem_auto]">
        <Field label="时间范围" htmlFor="metrics-window">
          <Select
            id="metrics-window"
            value={filters.window}
            onChange={(event) => update({ window: event.target.value as MetricsWindow })}
          >
            <option value="1h">最近 1 小时</option>
            <option value="24h">最近 24 小时</option>
            <option value="7d">最近 7 天</option>
            <option value="30d">最近 30 天</option>
          </Select>
        </Field>
        <Field label="Provider" htmlFor="metrics-provider">
          <Select
            id="metrics-provider"
            value={filters.provider ?? ""}
            onChange={(event) => update({ provider: event.target.value || undefined })}
          >
            <option value="">全部 Provider</option>
            {providers.map((provider) => (
              <option key={provider} value={provider}>
                {provider}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="模型" htmlFor="metrics-model">
          <ModelPicker
            id="metrics-model"
            models={models}
            value={filters.model ?? ""}
            onChange={(model) => update({ model: model || undefined })}
          />
        </Field>
        <Field label="状态" htmlFor="metrics-status">
          <Select
            id="metrics-status"
            value={filters.status ?? ""}
            onChange={(event) =>
              update({ status: (event.target.value as MetricsQuery["status"]) || undefined })
            }
          >
            <option value="">全部状态</option>
            <option value="success">成功</option>
            <option value="error">失败</option>
            <option value="canceled">已取消</option>
          </Select>
        </Field>
        <Button variant="ghost" disabled={!hasFilters} onClick={reset}>
          重置
        </Button>
      </div>
      <div
        role="status"
        className="flex items-center justify-between gap-3 text-xs text-muted-foreground"
      >
        <span>
          {query.isPlaceholderData
            ? query.error
              ? "筛选更新失败，当前显示上次结果。"
              : "正在应用筛选，暂时显示上次结果…"
            : query.data
              ? `共 ${formatNumber(metrics.total)} 条记录`
              : "请求统计"}
        </span>
        {query.isFetching ? (
          <span className="inline-flex items-center gap-2">
            <Spinner className="size-3" />
            更新中
          </span>
        ) : query.error ? (
          <Button
            variant="outline"
            size="sm"
            disabled={!enabled}
            onClick={() => void query.refetch()}
          >
            重新加载
          </Button>
        ) : (
          <span>{enabled ? "每 10 秒自动更新" : "服务未运行，已暂停更新"}</span>
        )}
      </div>
      <ResourceContent state={state} label="统计">
        <div className="space-y-5" aria-busy={query.isFetching}>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
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
              detail={`${formatCompact(summary.tokens.inputTokens)} 输入 · ${formatCompact(summary.tokens.outputTokens)} 输出`}
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
              value={
                summary.successRate === null ? "—" : `${(summary.successRate * 100).toFixed(1)}%`
              }
              detail={`${formatNumber(summary.canceled)} 个请求取消`}
              tone="green"
            />
          </div>
          {!summary.requests ? (
            <div className="rounded-xl border bg-card p-6">
              <EmptyState
                icon={Activity}
                title={hasFilters ? "没有符合筛选条件的请求" : "还没有请求记录"}
                description={
                  hasFilters
                    ? "调整时间范围或清除筛选条件。"
                    : "在工作台发送消息，或通过 API 调用模型后，这里会显示用量和趋势。"
                }
              />
              <div className="mt-4 text-center">
                {hasFilters ? (
                  <Button variant="outline" onClick={reset}>
                    清除筛选
                  </Button>
                ) : (
                  <a
                    href="#playground"
                    className="text-sm text-primary underline-offset-4 hover:underline"
                  >
                    打开工作台 →
                  </a>
                )}
              </div>
            </div>
          ) : (
            <>
              <Card>
                <CardHeader>
                  <CardTitle>请求趋势</CardTitle>
                </CardHeader>
                <CardContent>
                  <MetricChart points={metrics.timeseries} />
                </CardContent>
              </Card>
              <div className="grid gap-4 lg:grid-cols-3">
                {[
                  { label: "模型", groups: summary.byModel },
                  { label: "Provider", groups: summary.byProvider },
                  { label: "渠道", groups: summary.byChannel },
                ].map(({ label, groups }) => (
                  <Card key={label}>
                    <CardHeader>
                      <CardTitle>按{label}</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <DistributionList groups={groups} label={label} />
                    </CardContent>
                  </Card>
                ))}
              </div>
              <Card>
                <CardHeader className="flex-row items-center justify-between">
                  <CardTitle>请求记录</CardTitle>
                  <Badge variant="muted">{limit} 条 / 页</Badge>
                </CardHeader>
                <CardContent>
                  <RequestTable rows={metrics.recent} />
                  <div className="mt-4 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span>
                      {query.isPlaceholderData
                        ? "等待筛选结果…"
                        : metrics.total
                          ? `${Math.min(offset + 1, metrics.total)}–${Math.min(offset + metrics.recent.length, metrics.total)} / ${metrics.total}`
                          : "暂无记录"}
                    </span>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={offset === 0 || query.isFetching}
                        onClick={() =>
                          setFilters((current) => ({
                            ...current,
                            offset: Math.max(0, offset - limit),
                          }))
                        }
                      >
                        上一页
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={offset + limit >= metrics.total || query.isFetching}
                        onClick={() =>
                          setFilters((current) => ({ ...current, offset: offset + limit }))
                        }
                      >
                        下一页
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </>
          )}
        </div>
      </ResourceContent>
    </div>
  );
}
