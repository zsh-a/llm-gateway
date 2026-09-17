import {
  Activity,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  ChevronRight,
  Database,
  Gauge,
  Network,
  Play,
  Settings2,
  ShieldCheck,
  TrendingUp,
  Wifi,
  Zap,
} from "lucide-react";
import { EmptyState, MetricChart, Sparkline, StatCard, StatusBadge } from "../components/common";
import { Badge, Button, Card, CardContent, CardDescription, CardHeader } from "../components/ui";
import { RequestTable } from "../components/usage";
import { formatCompact, formatDuration, formatNumber, formatTime } from "../lib/format";
import { modelSupportsReasoning } from "../lib/models";
import { cn } from "../lib/utils";
import type { AuthProviderStatus, DashboardData, GatewayModel, Navigate } from "../types";

export function OverviewPage({ data, onNavigate }: { data: DashboardData; onNavigate: Navigate }) {
  const summary = data.summary;
  const requestValues = data.timeseries.map((point) => point.requests);
  const providerEntries = Object.entries(data.auth.providers);
  const tokenDetail = [
    `${formatCompact(summary.tokens.cachedTokens)} 缓存`,
    `${formatCompact(summary.tokens.reasoningTokens)} 思考`,
  ].join(" · ");
  const heroDescription = "统一管理 Provider、模型路由、访问密钥和调用指标。";
  const gatewayOnline = data.health.status === "ok" || data.health.status === "ready";
  return (
    <div className="space-y-6">
      <div
        className={cn(
          "relative overflow-hidden rounded-2xl border border-primary/20",
          "bg-gradient-to-br from-primary/20 via-card to-cyan-500/5 p-6 panel-shadow",
        )}
      >
        <div className="grid-fade pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div className="max-w-2xl">
            <div
              className={cn(
                "mb-3 inline-flex items-center gap-2 rounded-full border border-primary/25",
                "bg-primary/10 px-2.5 py-1 text-[11px] text-primary",
              )}
            >
              <Zap className="size-3" />
              OpenAI-compatible LLM Gateway
            </div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              把模型能力，变成稳定的本地接口。
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              {heroDescription}
            </p>
            <div className="mt-5 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onNavigate("playground")}>
                <Play className="size-3.5" />
                打开工作台
              </Button>
              <Button variant="outline" size="sm" onClick={() => onNavigate("management")}>
                <Settings2 className="size-3.5" />
                管理资源
              </Button>
            </div>
          </div>
          <div
            className={cn(
              "flex shrink-0 items-center gap-3 rounded-xl border border-border/70",
              "bg-background/35 px-4 py-3 backdrop-blur",
            )}
          >
            <div
              className={cn(
                "flex size-9 items-center justify-center rounded-full",
                !gatewayOnline
                  ? "bg-red-400/10 text-red-300"
                  : "bg-emerald-400/10 text-emerald-300",
              )}
            >
              {!gatewayOnline ? <Wifi className="size-4" /> : <CheckCircle2 className="size-4" />}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Gateway 状态</div>
              <div className="mt-0.5 flex items-center gap-2 text-sm font-medium">
                <StatusBadge status={data.health.status} />
                <span>{data.health.service || "本地服务"}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Activity}
          label="24h 请求"
          value={formatCompact(summary.requests)}
          detail={`${formatNumber(summary.activeRequests)} 个进行中`}
        />
        <StatCard
          icon={TrendingUp}
          label="成功率"
          value={summary.successRate === null ? "—" : `${Number(summary.successRate).toFixed(1)}%`}
          detail={`${formatNumber(summary.errors)} 个错误`}
          tone="green"
        />
        <StatCard
          icon={Gauge}
          label="平均延迟"
          value={formatDuration(summary.latency.averageMs)}
          detail={`P95 ${formatDuration(summary.latency.p95Ms)}`}
          tone="cyan"
        />
        <StatCard
          icon={Database}
          label="Token 用量"
          value={formatCompact(summary.tokens.totalTokens)}
          detail={tokenDetail}
          tone="amber"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold tracking-tight">请求趋势</h3>
              <CardDescription>过去 24 小时的请求和 Token 活跃度</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("metrics")}>
              查看详情
              <ArrowUpRight className="size-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            <div
              className={cn(
                "flex items-center justify-between rounded-xl border border-border/60",
                "bg-muted/20 px-3 py-2.5",
              )}
            >
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Activity className="size-3.5 text-primary" />
                请求活跃度
              </div>
              <Sparkline values={requestValues} />
            </div>
            <div className="mt-4">
              <MetricChart points={data.timeseries} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h3 className="text-sm font-semibold tracking-tight">认证状态</h3>
            <CardDescription>认证缓存可被多个 Provider 渠道复用</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {providerEntries.length === 0 && (
              <EmptyState
                icon={ShieldCheck}
                title="暂无认证缓存"
                description="请先执行独立认证流程"
              />
            )}
            {providerEntries.map(([provider, state]) => (
              <ProviderRow key={provider} provider={provider} state={state} />
            ))}
            <Button
              variant="outline"
              className="mt-1 w-full"
              onClick={() => onNavigate("management")}
            >
              <ShieldCheck className="size-4" />
              管理渠道与 Provider
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold tracking-tight">模型目录</h3>
              <CardDescription>当前 Gateway 可路由模型</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="info">{data.models.length} 个</Badge>
              <Button variant="ghost" size="sm" onClick={() => onNavigate("playground")}>
                去使用
                <ArrowUpRight className="size-3.5" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.models.length === 0 && (
              <EmptyState icon={Bot} title="没有可用模型" description="认证成功后刷新模型目录" />
            )}
            {data.models.slice(0, 8).map((model) => (
              <ModelRow
                key={model.id}
                model={model}
                onClick={() => onNavigate("playground", { modelId: model.id })}
              />
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <h3 className="text-sm font-semibold tracking-tight">最近请求</h3>
              <CardDescription>最新完成的调用记录</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("metrics")}>
              全部记录
              <ChevronRight className="size-3.5" />
            </Button>
          </CardHeader>
          <CardContent>
            <RequestTable rows={data.recent.slice(0, 6)} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProviderRow({ provider, state }: { provider: string; state: AuthProviderStatus }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/20 px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Network className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{provider}</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">
            {state.source || "认证缓存"} ·{" "}
            {state.capturedAt ? formatTime(state.capturedAt, true) : "未记录时间"}
          </div>
        </div>
      </div>
      <StatusBadge
        status={state.ready ? "ready" : "error"}
        label={state.ready ? "已认证" : "待认证"}
      />
    </div>
  );
}

function ModelRow({ model, onClick }: { model: GatewayModel; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex w-full items-center justify-between rounded-xl",
        "border border-border/70 bg-muted/15 px-3.5 py-3 text-left transition",
        "hover:border-primary/35 hover:bg-primary/5",
      )}
    >
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300">
          <Bot className="size-4" />
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{model.name || model.id}</div>
          <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">
            {model.id}
            {model.provider ? ` · ${model.provider}` : ""}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {modelSupportsReasoning(model) && <Badge variant="info">思考</Badge>}
        <ChevronRight
          className={cn(
            "size-4 text-muted-foreground transition",
            "group-hover:translate-x-0.5 group-hover:text-primary",
          )}
        />
      </div>
    </button>
  );
}
