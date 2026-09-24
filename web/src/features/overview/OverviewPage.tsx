import { Activity, ArrowUpRight, Database, Gauge, ShieldCheck, TrendingUp } from "lucide-react";
import type { ComponentProps } from "react";
import type { GatewayApi } from "../../api";
import {
  CopyButton,
  EmptyState,
  MetricChart,
  ResourceContent,
  StatCard,
  StatusBadge,
} from "../../components/common";
import { ModelPicker } from "../../components/ModelPicker";
import { Button, Card, CardContent, CardHeader, CardTitle } from "../../components/ui";
import { RequestTable } from "../../components/usage";
import { emptySummary } from "../../lib/constants";
import { formatCompact, formatDuration, formatNumber, formatTime } from "../../lib/format";
import { useAuth, useMetrics, useModels } from "../../lib/gateway-queries";
import type { DashboardData, Navigate } from "../../types";
import { SetupGuide } from "./SetupGuide";

export function OverviewPage({
  data,
  gatewayUrl,
  onNavigate,
  canManage = false,
}: {
  data: Pick<DashboardData, "auth" | "models" | "summary" | "timeseries" | "recent"> & {
    resources: Pick<DashboardData["resources"], "auth" | "models" | "metrics">;
  };
  gatewayUrl: string;
  onNavigate: Navigate;
  canManage?: boolean;
}) {
  const summary = data.summary;
  const providers = Object.entries(data.auth.providers);
  return (
    <div className="space-y-5">
      {((data.resources.metrics.hasData && !summary.requests) ||
        (data.resources.models.hasData && !data.models.length) ||
        data.resources.models.error) && (
        <SetupGuide
          authenticated={providers.some(([, state]) => state.ready)}
          callable={
            data.resources.models.hasData && !data.resources.models.error && data.models.length > 0
          }
          canManage={canManage}
          onNavigate={onNavigate}
        />
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card px-5 py-4">
        <div className="min-w-0">
          <p className="mb-1 text-xs text-muted-foreground">OpenAI 兼容接口 · API Base URL</p>
          <code className="break-all font-mono text-sm">{gatewayUrl}/v1</code>
        </div>
        <div className="flex items-center gap-3">
          <CopyButton value={`${gatewayUrl}/v1`} label="复制地址" />
          <Button size="sm" onClick={() => onNavigate("playground")}>
            测试模型
            <ArrowUpRight className="size-3.5" />
          </Button>
        </div>
      </div>
      <ResourceContent state={data.resources.metrics} label="统计">
        <p className="mb-3 text-xs text-muted-foreground">
          统计范围：{summary.scope === "admin" ? "全部 Key · 本网关" : "当前 Key"}
        </p>
        {summary.history?.legacyIncomplete &&
          (summary.periodStart ?? 0) < summary.history.completeSince && (
            <p className="mb-3 text-xs text-warning">
              升级前部分请求明细可能已清理；历史数据不完整。
            </p>
          )}
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <StatCard
            icon={Activity}
            label="24h 请求"
            value={formatCompact(summary.requests)}
            detail={`${formatNumber(summary.activeRequests)} 个进行中`}
          />
          <StatCard
            icon={TrendingUp}
            label="成功率"
            value={
              summary.successRate === null ? "—" : `${(summary.successRate * 100).toFixed(1)}%`
            }
            detail={`${formatNumber(summary.errors)} 个错误`}
            tone="green"
          />
          <StatCard
            icon={Gauge}
            label="平均延迟"
            value={formatDuration(summary.latency.averageMs)}
            detail={`P95 约 ${formatDuration(summary.latency.p95Ms)}`}
            tone="cyan"
          />
          <StatCard
            icon={Database}
            label="已知 Token 用量"
            value={
              summary.tokens.totalTokens === undefined
                ? "—"
                : formatCompact(summary.tokens.totalTokens)
            }
            detail={
              Number(summary.tokens.requestsWithoutUsage) > 0
                ? `${String(summary.tokens.requestsWithoutUsage)} 次请求用量未知`
                : "按上游返回用量累计"
            }
            tone="amber"
          />
        </div>
      </ResourceContent>
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <div>
              <CardTitle>请求趋势</CardTitle>
              <p className="mt-1 text-xs text-muted-foreground">最近 24 小时</p>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("metrics")}>
              统计分析
              <ArrowUpRight className="size-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            <ResourceContent state={data.resources.metrics} label="趋势">
              <MetricChart points={data.timeseries} />
            </ResourceContent>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>模型与认证</CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            <ResourceContent state={data.resources.models} label="模型">
              <p className="mb-2 text-sm text-muted-foreground">{data.models.length} 个可用模型</p>
              {data.models.length ? (
                <ModelPicker
                  models={data.models}
                  value=""
                  placeholder="搜索并测试模型"
                  onChange={(modelId) => onNavigate("playground", { modelId })}
                />
              ) : (
                <p className="text-sm text-muted-foreground">认证成功后，模型会显示在这里。</p>
              )}
            </ResourceContent>
            <ResourceContent state={data.resources.auth} label="认证">
              <div className="divide-y border-t">
                {!providers.length && (
                  <EmptyState
                    icon={ShieldCheck}
                    title="暂无认证"
                    description="完成 Provider 认证后刷新。"
                  />
                )}
                {providers.map(([provider, state]) => (
                  <div key={provider} className="flex items-center justify-between gap-3 py-3">
                    <div>
                      <p className="text-sm font-medium">{provider}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {state.capturedAt ? formatTime(state.capturedAt, true) : "尚未认证"}
                      </p>
                    </div>
                    <StatusBadge
                      status={state.ready ? "ready" : "not_ready"}
                      label={state.ready ? "已认证" : "待认证"}
                    />
                  </div>
                ))}
              </div>
            </ResourceContent>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => onNavigate("management")}
            >
              管理渠道
            </Button>
          </CardContent>
        </Card>
      </div>
      <Card>
        <CardHeader className="flex-row items-center justify-between">
          <CardTitle>最近请求</CardTitle>
          <Button variant="ghost" size="sm" onClick={() => onNavigate("metrics")}>
            全部记录
            <ArrowUpRight className="size-3.5" />
          </Button>
        </CardHeader>
        <CardContent>
          <ResourceContent state={data.resources.metrics} label="请求记录">
            <RequestTable rows={data.recent} />
          </ResourceContent>
        </CardContent>
      </Card>
    </div>
  );
}

export function OverviewScreen({
  api,
  enabled,
  ...props
}: Omit<ComponentProps<typeof OverviewPage>, "data"> & { api: GatewayApi; enabled: boolean }) {
  const auth = useAuth(api, enabled);
  const models = useModels(api, enabled, "available");
  const metrics = useMetrics(api, { window: "24h", limit: 6, offset: 0 }, enabled);
  return (
    <OverviewPage
      {...props}
      canManage={api.isAdministrator}
      data={{
        auth: auth.data,
        models: models.data,
        summary: metrics.data?.summary ?? emptySummary,
        timeseries: metrics.data?.timeseries ?? [],
        recent: metrics.data?.recent ?? [],
        resources: {
          auth: auth.resource,
          models: models.resource,
          metrics: {
            pending: metrics.isPending,
            error: metrics.error,
            hasData: Boolean(metrics.data),
          },
        },
      }}
    />
  );
}
