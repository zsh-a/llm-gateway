import { Activity, Database, Gauge, ShieldCheck } from "lucide-react";
import { DistributionList, MetricChart, StatCard } from "../components/common";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui";
import { RequestTable } from "../components/usage";
import { formatCompact, formatDuration, formatNumber } from "../lib/format";
import type { DashboardData } from "../types";

export function MetricsPage({ data }: { data: DashboardData }) {
  const summary = data.summary;
  const tokenDetail = [
    `${formatCompact(summary.tokens.inputTokens)} 输入`,
    `${formatCompact(summary.tokens.outputTokens)} 输出`,
    `${formatCompact(summary.tokens.cachedTokens)} cached`,
  ].join(" · ");
  return (
    <div className="space-y-6">
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
          <CardDescription>按时间桶聚合的请求量和 Token 用量</CardDescription>
        </CardHeader>
        <CardContent>
          <MetricChart points={data.timeseries} />
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
          <CardDescription>包括 Chat Completions 与 Responses 调用</CardDescription>
        </CardHeader>
        <CardContent>
          <RequestTable rows={data.recent} />
        </CardContent>
      </Card>
    </div>
  );
}
