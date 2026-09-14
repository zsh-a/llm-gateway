import {
  Activity,
  AlertCircle,
  ArrowUpRight,
  BarChart3,
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  Clipboard,
  Copy,
  Database,
  ExternalLink,
  Gauge,
  KeyRound,
  LayoutDashboard,
  Loader2,
  Menu,
  MessageSquareText,
  Moon,
  Network,
  Plus,
  RefreshCw,
  Save,
  Server,
  Settings2,
  ShieldCheck,
  Sun,
  TerminalSquare,
  Trash2,
  TrendingUp,
  Users,
  Wifi,
  X,
  XCircle,
  Zap
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode
} from "react";
import { ApiError, GatewayApi, loadCredentials, saveCredentials } from "./api";
import type {
  ApiKeyRecord,
  AuthProviderStatus,
  ChannelConfig,
  DashboardData,
  GatewayModel,
  MetricGroup,
  MetricsSummary,
  PageKey,
  RecentRequest,
  TimeseriesPoint,
  Usage
} from "./types";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Kbd,
  Label,
  Progress,
  Separator,
  Spinner,
  Textarea
} from "./components/ui";
import { cn } from "./lib/utils";

const emptySummary: MetricsSummary = {
  requests: 0,
  successes: 0,
  errors: 0,
  canceled: 0,
  successRate: null,
  activeRequests: 0,
  latency: { averageMs: null, p50Ms: null, p95Ms: null, maxMs: null },
  tokens: { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cachedTokens: 0, totalTokens: 0, requestsWithUsage: 0 },
  byProvider: [],
  byChannel: [],
  byModel: [],
  byApiKey: []
};

const emptyDashboard: DashboardData = {
  health: { status: "offline" },
  auth: { ready: false, providers: {} },
  models: [],
  summary: emptySummary,
  timeseries: [],
  recent: [],
  channels: [],
  keys: [],
  adminError: ""
};

const pageMeta: Record<PageKey, { label: string; title: string; description: string }> = {
  overview: { label: "概览", title: "网关概览", description: "实时掌握服务状态、模型目录和最近调用" },
  playground: { label: "Playground", title: "模型工作台", description: "直接验证模型、思考强度和响应效果" },
  metrics: { label: "统计分析", title: "流量与用量", description: "请求、Token、延迟和模型路由的完整视图" },
  management: { label: "资源管理", title: "渠道与密钥", description: "管理 Provider 渠道、模型路由和访问权限" },
  settings: { label: "设置", title: "运行设置", description: "控制台凭证、主题和运行时信息" }
};

const navigation: Array<{ key: PageKey; icon: typeof LayoutDashboard }> = [
  { key: "overview", icon: LayoutDashboard },
  { key: "playground", icon: MessageSquareText },
  { key: "metrics", icon: BarChart3 },
  { key: "management", icon: ShieldCheck },
  { key: "settings", icon: Settings2 }
];

function number(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(number(value));
}

function formatCompact(value: number | null | undefined): string {
  const amount = number(value);
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return formatNumber(amount);
}

function formatDuration(value: number | null | undefined): string {
  const amount = number(value);
  if (!amount) return "—";
  if (amount < 1000) return `${Math.round(amount)} ms`;
  return `${(amount / 1000).toFixed(2)} s`;
}

function formatTime(value: number | undefined, withDate = false): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: withDate ? "2-digit" : undefined,
    day: withDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: withDate ? undefined : "2-digit"
  }).format(new Date(value));
}

function usageTotal(usage: Usage | undefined): number {
  return number(usage?.totalTokens) || number(usage?.inputTokens) + number(usage?.outputTokens) + number(usage?.reasoningTokens);
}

function modelEfforts(model: GatewayModel | undefined): Record<string, string | null> {
  return model?.reasoningEfforts ?? model?.reasoning_efforts ?? {};
}

function modelSupportsReasoning(model: GatewayModel | undefined): boolean {
  if (!model) return false;
  return model.reasoning === true || Object.keys(modelEfforts(model)).length > 0;
}

function statusVariant(status: string | undefined): "success" | "warning" | "danger" | "muted" {
  if (status === "success" || status === "ok" || status === "ready") return "success";
  if (status === "error" || status === "offline") return "danger";
  if (status === "pending" || status === "starting") return "warning";
  return "muted";
}

function StatusBadge({ status, label }: { status: string | undefined; label?: string }) {
  const online = status === "ok" || status === "ready" || status === "success";
  return (
    <Badge variant={statusVariant(status)}>
      <span className={cn("size-1.5 rounded-full", online ? "bg-emerald-400" : status === "offline" ? "bg-red-400" : "bg-amber-300")} />
      {label ?? (online ? "在线" : status === "offline" ? "离线" : status ?? "未知")}
    </Badge>
  );
}

function SectionHeading({
  eyebrow,
  title,
  description,
  action
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        {eyebrow && <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">{eyebrow}</div>}
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

function EmptyState({ icon: Icon = CircleDashed, title = "暂无数据", description }: { icon?: typeof CircleDashed; title?: string; description?: string }) {
  return (
    <div className="flex min-h-32 flex-col items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 px-5 text-center">
      <Icon className="mb-2 size-5 text-muted-foreground" />
      <div className="text-sm text-foreground">{title}</div>
      {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "primary"
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  detail: string;
  tone?: "primary" | "cyan" | "green" | "amber";
}) {
  const tones = {
    primary: "bg-primary/12 text-primary",
    cyan: "bg-cyan-400/12 text-cyan-300",
    green: "bg-emerald-400/12 text-emerald-300",
    amber: "bg-amber-400/12 text-amber-300"
  };
  return (
    <Card className="overflow-hidden border-border/80 bg-card/85 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-lg">
      <CardContent className="relative p-5">
        <div className="absolute -right-7 -top-7 size-24 rounded-full bg-primary/5 blur-2xl" />
        <div className="relative flex items-start justify-between gap-3">
          <div>
            <div className="text-xs text-muted-foreground">{label}</div>
            <div className="mt-2 text-2xl font-semibold tracking-tight">{value}</div>
            <div className="mt-1 text-[11px] text-muted-foreground">{detail}</div>
          </div>
          <div className={cn("flex size-9 items-center justify-center rounded-xl", tones[tone])}>
            <Icon className="size-4" />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Sparkline({ values, color = "var(--chart-1)" }: { values: number[]; color?: string }) {
  if (values.length < 2) return <div className="h-8 w-24 rounded-md bg-muted/60" />;
  const max = Math.max(...values, 1);
  const points = values.map((value, index) => `${(index / (values.length - 1)) * 100},${28 - (value / max) * 24}`).join(" ");
  return (
    <svg viewBox="0 0 100 30" className="h-8 w-24 overflow-visible" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} fill="none" stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function MetricChart({ points }: { points: TimeseriesPoint[] }) {
  const width = 820;
  const height = 230;
  const padding = { top: 18, right: 20, bottom: 26, left: 42 };
  const requests = points.map((point) => number(point.requests));
  const tokens = points.map((point) => number(point.tokens?.totalTokens));
  const maxRequest = Math.max(...requests, 1);
  const maxToken = Math.max(...tokens, 1);
  const x = (index: number) => padding.left + (index / Math.max(points.length - 1, 1)) * (width - padding.left - padding.right);
  const y = (value: number, max: number) => padding.top + (1 - value / max) * (height - padding.top - padding.bottom);
  const requestPoints = requests.map((value, index) => `${x(index)},${y(value, maxRequest)}`).join(" ");
  const tokenPoints = tokens.map((value, index) => `${x(index)},${y(value, maxToken)}`).join(" ");

  if (!points.length) return <EmptyState icon={BarChart3} title="暂时没有统计数据" description="产生请求后，趋势会自动出现在这里" />;

  return (
    <div className="space-y-3">
      <div className="h-64 overflow-hidden rounded-xl border border-border/70 bg-background/50 p-2">
        <svg viewBox={`0 0 ${width} ${height}`} className="h-full w-full" role="img" aria-label="请求和 Token 趋势">
          {[0, 1, 2, 3].map((step) => {
            const lineY = padding.top + (step / 3) * (height - padding.top - padding.bottom);
            return <line key={step} x1={padding.left} x2={width - padding.right} y1={lineY} y2={lineY} stroke="var(--border)" strokeOpacity="0.65" strokeDasharray="3 5" />;
          })}
          <polyline points={requestPoints} fill="none" stroke="var(--chart-1)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="3" />
          <polyline points={tokenPoints} fill="none" stroke="var(--chart-2)" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" />
          {points.map((point, index) => (
            <circle key={`${point.start}-${index}`} cx={x(index)} cy={y(requests[index], maxRequest)} r="3" fill="var(--card)" stroke="var(--chart-1)" strokeWidth="2" />
          ))}
          <text x={padding.left} y={height - 7} fill="var(--muted-foreground)" fontSize="10">{formatTime(points[0]?.start)}</text>
          <text x={width - padding.right} y={height - 7} fill="var(--muted-foreground)" fontSize="10" textAnchor="end">{formatTime(points[points.length - 1]?.start)}</text>
        </svg>
      </div>
      <div className="flex items-center gap-5 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-chart-1" />请求</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-2 rounded-full bg-chart-2" />Token</span>
      </div>
    </div>
  );
}

function DistributionList({ groups, label }: { groups: MetricGroup[]; label: string }) {
  const max = Math.max(...groups.map((group) => group.requests), 1);
  return (
    <div className="space-y-3">
      {groups.length === 0 && <EmptyState icon={Database} title={`暂无${label}数据`} />}
      {groups.slice(0, 6).map((group) => (
        <div key={group.key}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-foreground">{group.key || "未标识"}</span>
            <span className="shrink-0 font-mono text-muted-foreground">{formatNumber(group.requests)}</span>
          </div>
          <Progress value={(group.requests / max) * 100} />
        </div>
      ))}
    </div>
  );
}

function RequestTable({ rows }: { rows: RecentRequest[] }) {
  if (!rows.length) return <EmptyState icon={Activity} title="暂无请求记录" description="API 请求完成后会在这里显示" />;
  return (
    <div className="overflow-x-auto rounded-xl border border-border/70">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="bg-muted/45 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="px-3 py-2.5 font-medium">时间</th>
            <th className="px-3 py-2.5 font-medium">模型</th>
            <th className="px-3 py-2.5 font-medium">Provider</th>
            <th className="px-3 py-2.5 font-medium">协议</th>
            <th className="px-3 py-2.5 font-medium">耗时</th>
            <th className="px-3 py-2.5 font-medium">Token</th>
            <th className="px-3 py-2.5 font-medium">状态</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border/70">
          {rows.map((row) => (
            <tr key={row.id} className="transition hover:bg-muted/20">
              <td className="whitespace-nowrap px-3 py-3 font-mono text-muted-foreground">{formatTime(row.startedAt, true)}</td>
              <td className="max-w-48 truncate px-3 py-3 font-medium text-foreground">{row.model || "—"}</td>
              <td className="px-3 py-3 text-muted-foreground">{row.provider || "—"}</td>
              <td className="px-3 py-3"><Badge variant="muted">{row.protocol || "chat"}</Badge></td>
              <td className="px-3 py-3 text-muted-foreground">{formatDuration(row.durationMs)}</td>
              <td className="px-3 py-3 font-mono text-muted-foreground">{formatCompact(usageTotal(row.usage ?? undefined))}</td>
              <td className="px-3 py-3"><StatusBadge status={row.status} label={row.status === "success" ? "成功" : row.status === "error" ? "失败" : "取消"} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverviewPage({ data, onNavigate }: { data: DashboardData; onNavigate: (page: PageKey) => void }) {
  const summary = data.summary;
  const requestValues = data.timeseries.map((point) => point.requests);
  const providerEntries = Object.entries(data.auth.providers);
  return (
    <div className="space-y-6">
      <div className="relative overflow-hidden rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/20 via-card to-cyan-500/5 p-6 panel-shadow">
        <div className="grid-fade pointer-events-none absolute inset-0 opacity-60" />
        <div className="relative flex flex-col justify-between gap-6 lg:flex-row lg:items-end">
          <div className="max-w-2xl">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-primary/25 bg-primary/10 px-2.5 py-1 text-[11px] text-primary">
              <Zap className="size-3" />
              OpenAI-compatible LLM Gateway
            </div>
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">把模型能力，变成稳定的本地接口。</h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">统一管理 Provider、模型路由、访问密钥和调用指标。控制台与 Gateway 共用一个运行时。</p>
          </div>
          <div className="flex shrink-0 items-center gap-3 rounded-xl border border-border/70 bg-background/35 px-4 py-3 backdrop-blur">
            <div className={cn("flex size-9 items-center justify-center rounded-full", data.health.status === "offline" ? "bg-red-400/10 text-red-300" : "bg-emerald-400/10 text-emerald-300")}>
              {data.health.status === "offline" ? <Wifi className="size-4" /> : <CheckCircle2 className="size-4" />}
            </div>
            <div>
              <div className="text-xs text-muted-foreground">Gateway 状态</div>
              <div className="mt-0.5 flex items-center gap-2 text-sm font-medium"><StatusBadge status={data.health.status} /> <span>{data.health.service || "本地服务"}</span></div>
            </div>
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon={Activity} label="24h 请求" value={formatCompact(summary.requests)} detail={`${formatNumber(summary.activeRequests)} 个进行中`} />
        <StatCard icon={TrendingUp} label="成功率" value={summary.successRate === null ? "—" : `${(summary.successRate * 100).toFixed(1)}%`} detail={`${formatNumber(summary.errors)} 个错误`} tone="green" />
        <StatCard icon={Gauge} label="平均延迟" value={formatDuration(summary.latency.averageMs)} detail={`P95 ${formatDuration(summary.latency.p95Ms)}`} tone="cyan" />
        <StatCard icon={Database} label="Token 用量" value={formatCompact(summary.tokens.totalTokens)} detail={`${formatCompact(summary.tokens.reasoningTokens)} reasoning`} tone="amber" />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.45fr_0.85fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div>
              <CardTitle>请求趋势</CardTitle>
              <CardDescription>过去 24 小时的请求和 Token 活跃度</CardDescription>
            </div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("metrics")}>查看详情 <ArrowUpRight className="size-3.5" /></Button>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-xl border border-border/60 bg-muted/20 px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Activity className="size-3.5 text-primary" />请求活跃度</div>
              <Sparkline values={requestValues} />
            </div>
            <div className="mt-4"><MetricChart points={data.timeseries} /></div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>认证状态</CardTitle>
            <CardDescription>认证缓存可被多个 Provider 渠道复用</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {providerEntries.length === 0 && <EmptyState icon={ShieldCheck} title="暂无认证缓存" description="请先执行独立认证流程" />}
            {providerEntries.map(([provider, state]) => <ProviderRow key={provider} provider={provider} state={state} />)}
            <Button variant="outline" className="mt-1 w-full" onClick={() => onNavigate("management")}><ShieldCheck className="size-4" />管理渠道与 Provider</Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div><CardTitle>模型目录</CardTitle><CardDescription>当前 Gateway 可路由模型</CardDescription></div>
            <Badge variant="info">{data.models.length} models</Badge>
          </CardHeader>
          <CardContent className="space-y-2">
            {data.models.length === 0 && <EmptyState icon={Bot} title="没有可用模型" description="认证成功后刷新模型目录" />}
            {data.models.slice(0, 8).map((model) => <ModelRow key={model.id} model={model} onClick={() => onNavigate("playground")} />)}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex-row items-start justify-between">
            <div><CardTitle>最近请求</CardTitle><CardDescription>最新完成的调用记录</CardDescription></div>
            <Button variant="ghost" size="sm" onClick={() => onNavigate("metrics")}>全部记录 <ChevronRight className="size-3.5" /></Button>
          </CardHeader>
          <CardContent><RequestTable rows={data.recent.slice(0, 6)} /></CardContent>
        </Card>
      </div>
    </div>
  );
}

function ProviderRow({ provider, state }: { provider: string; state: AuthProviderStatus }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/20 px-3.5 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Network className="size-4" /></div>
        <div className="min-w-0"><div className="truncate text-sm font-medium">{provider}</div><div className="mt-0.5 text-[11px] text-muted-foreground">{state.source || "认证缓存"} · {state.capturedAt ? formatTime(state.capturedAt, true) : "未记录时间"}</div></div>
      </div>
      <StatusBadge status={state.ready ? "ready" : "error"} label={state.ready ? "已认证" : "待认证"} />
    </div>
  );
}

function ModelRow({ model, onClick }: { model: GatewayModel; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="group flex w-full items-center justify-between rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3 text-left transition hover:border-primary/35 hover:bg-primary/5">
      <div className="flex min-w-0 items-center gap-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300"><Bot className="size-4" /></div><div className="min-w-0"><div className="truncate text-sm font-medium">{model.name || model.id}</div><div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{model.id}{model.provider ? ` · ${model.provider}` : ""}</div></div></div>
      <div className="flex shrink-0 items-center gap-2">{modelSupportsReasoning(model) && <Badge variant="info">thinking</Badge>}<ChevronRight className="size-4 text-muted-foreground transition group-hover:translate-x-0.5 group-hover:text-primary" /></div>
    </button>
  );
}

function PlaygroundPage({ data, api, onRefresh, onNotice }: { data: DashboardData; api: GatewayApi; onRefresh: () => void; onNotice: (message: string) => void }) {
  const [modelId, setModelId] = useState(data.models[0]?.id ?? "");
  const [effort, setEffort] = useState("off");
  const [prompt, setPrompt] = useState("请用一句话介绍当前 Gateway 的能力。");
  const [content, setContent] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [usage, setUsage] = useState<Usage | undefined>();
  const [state, setState] = useState<"idle" | "streaming" | "success" | "error">("idle");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const model = data.models.find((item) => item.id === modelId) ?? data.models[0];
  const efforts = modelEfforts(model);

  useEffect(() => {
    if (!modelId && data.models[0]) setModelId(data.models[0].id);
    if (model && !modelSupportsReasoning(model)) setEffort("off");
  }, [data.models, model, modelId]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!model || !prompt.trim() || state === "streaming") return;
    const controller = new AbortController();
    abortRef.current = controller;
    setState("streaming");
    setContent("");
    setReasoning("");
    setUsage(undefined);
    setError("");
    try {
      await api.streamChat(model, prompt.trim(), effort, (update) => {
        if (update.content) setContent((current) => current + update.content);
        if (update.reasoning) setReasoning((current) => current + update.reasoning);
        if (update.usage) setUsage(update.usage);
      }, controller.signal);
      setState("success");
      onRefresh();
    } catch (caught) {
      if (controller.signal.aborted) return;
      setState("error");
      setError(caught instanceof Error ? caught.message : "请求失败");
    } finally {
      abortRef.current = null;
    }
  };

  const stop = (): void => abortRef.current?.abort();

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
      <Card className="h-fit">
        <CardHeader><div className="flex items-center gap-2"><MessageSquareText className="size-4 text-primary" /><CardTitle>请求配置</CardTitle></div><CardDescription>使用与 OpenAI Chat Completions 兼容的请求格式</CardDescription></CardHeader>
        <CardContent>
          <form className="space-y-5" onSubmit={submit}>
            <div className="space-y-2"><Label htmlFor="playground-model">模型</Label><select id="playground-model" value={model?.id ?? ""} onChange={(event) => setModelId(event.target.value)} className="flex h-10 w-full rounded-lg border border-input bg-background/70 px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={!data.models.length}><option value="">{data.models.length ? "选择模型" : "暂无模型"}</option>{data.models.map((item) => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}</select>{model && <div className="flex items-center gap-2 text-[11px] text-muted-foreground"><span className="font-mono">{model.id}</span>{model.provider && <Badge variant="muted">{model.provider}</Badge>}</div>}</div>
            <div className="space-y-2"><div className="flex items-center justify-between"><Label htmlFor="playground-effort">Reasoning effort</Label>{modelSupportsReasoning(model) ? <Badge variant="info">模型支持</Badge> : <span className="text-[11px] text-muted-foreground">模型未声明</span>}</div><select id="playground-effort" value={effort} onChange={(event) => setEffort(event.target.value)} className="flex h-10 w-full rounded-lg border border-input bg-background/70 px-3 text-sm outline-none focus:border-ring focus:ring-2 focus:ring-ring/20" disabled={!modelSupportsReasoning(model)}><option value="off">关闭思考</option>{Object.keys(efforts).map((key) => <option key={key} value={key}>{key}</option>)}</select></div>
            <div className="space-y-2"><div className="flex items-center justify-between"><Label htmlFor="playground-prompt">Prompt</Label><Kbd>⌘ ↵</Kbd></div><Textarea id="playground-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="输入一条消息..." className="min-h-44" onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") void submit(event as unknown as FormEvent<HTMLFormElement>); }} /></div>
            <div className="flex items-center gap-2"><Button type="submit" className="flex-1" disabled={!model || !prompt.trim() || state === "streaming"}>{state === "streaming" ? <><Spinner className="size-3.5" />生成中</> : <><Zap className="size-4" />发送请求</>}</Button>{state === "streaming" && <Button type="button" variant="outline" onClick={stop}><X className="size-4" />停止</Button>}</div>
          </form>
        </CardContent>
        <CardFooter className="border-t border-border/60 pt-4 text-[11px] text-muted-foreground"><TerminalSquare className="mr-1.5 size-3.5" />响应通过本地 Gateway 流式转发</CardFooter>
      </Card>

      <Card className="min-h-[560px] overflow-hidden">
        <CardHeader className="border-b border-border/60 bg-muted/15"><div className="flex items-center justify-between gap-3"><div><CardTitle>响应预览</CardTitle><CardDescription>{model ? `${model.name || model.id} · ${effort === "off" ? "thinking off" : effort}` : "选择模型开始测试"}</CardDescription></div>{state === "streaming" ? <Badge variant="warning"><Loader2 className="size-3 animate-spin" />流式输出</Badge> : state === "success" ? <Badge variant="success"><Check className="size-3" />完成</Badge> : state === "error" ? <Badge variant="danger"><XCircle className="size-3" />失败</Badge> : <Badge variant="muted">待命</Badge>}</div></CardHeader>
        <CardContent className="space-y-4 p-5">
          {error && <div className="flex items-start gap-2 rounded-xl border border-red-400/25 bg-red-400/10 p-3 text-sm text-red-200"><AlertCircle className="mt-0.5 size-4 shrink-0" />{error}</div>}
          {reasoning && <div className="rounded-xl border border-violet-400/20 bg-violet-400/5"><div className="flex items-center gap-2 border-b border-violet-400/15 px-4 py-3 text-xs font-medium text-violet-200"><CircleDashed className="size-3.5" />Thinking</div><div className="max-h-64 overflow-y-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-6 text-violet-100/70 scrollbar-thin">{reasoning}{state === "streaming" && <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-violet-300" />}</div></div>}
          {content ? <div className="rounded-xl border border-border/70 bg-background/55 p-4"><div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground"><Bot className="size-3.5 text-primary" />Assistant</div><div className="whitespace-pre-wrap text-sm leading-7 text-foreground">{content}{state === "streaming" && <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-primary" />}</div></div> : !reasoning && state === "idle" ? <div className="flex min-h-80 flex-col items-center justify-center text-center"><div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><MessageSquareText className="size-6" /></div><div className="text-sm font-medium">准备好测试了吗？</div><p className="mt-2 max-w-xs text-xs leading-5 text-muted-foreground">选择模型，输入 Prompt，查看真实的流式响应和思考过程。</p></div> : !content && state === "streaming" ? <div className="flex min-h-80 flex-col items-center justify-center text-center text-muted-foreground"><Spinner className="mb-3 size-6 text-primary" /><div className="text-sm">正在等待模型响应...</div></div> : null}
          {usage && <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground"><Badge variant="muted">输入 {formatNumber(usage.inputTokens)} tokens</Badge><Badge variant="muted">输出 {formatNumber(usage.outputTokens)} tokens</Badge>{number(usage.reasoningTokens) > 0 && <Badge variant="muted">思考 {formatNumber(usage.reasoningTokens)} tokens</Badge>}<Badge variant="info">总计 {formatNumber(usageTotal(usage))}</Badge></div>}
        </CardContent>
      </Card>
    </div>
  );
}

function MetricsPage({ data }: { data: DashboardData }) {
  const summary = data.summary;
  return (
    <div className="space-y-6">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4"><StatCard icon={Activity} label="总请求" value={formatNumber(summary.requests)} detail={`${formatNumber(summary.successes)} 成功 / ${formatNumber(summary.errors)} 失败`} /><StatCard icon={Database} label="总 Token" value={formatCompact(summary.tokens.totalTokens)} detail={`${formatCompact(summary.tokens.inputTokens)} 输入 · ${formatCompact(summary.tokens.outputTokens)} 输出`} tone="cyan" /><StatCard icon={Gauge} label="P50 / P95" value={`${formatDuration(summary.latency.p50Ms)} / ${formatDuration(summary.latency.p95Ms)}`} detail={`最大 ${formatDuration(summary.latency.maxMs)}`} tone="amber" /><StatCard icon={ShieldCheck} label="成功率" value={summary.successRate === null ? "—" : `${(summary.successRate * 100).toFixed(2)}%`} detail={`${formatNumber(summary.canceled)} 个请求取消`} tone="green" /></div>
      <Card><CardHeader><CardTitle>请求趋势</CardTitle><CardDescription>按时间桶聚合的请求量和 Token 用量</CardDescription></CardHeader><CardContent><MetricChart points={data.timeseries} /></CardContent></Card>
      <div className="grid gap-6 lg:grid-cols-3"><Card><CardHeader><CardTitle>按模型</CardTitle><CardDescription>模型调用分布</CardDescription></CardHeader><CardContent><DistributionList groups={summary.byModel} label="模型" /></CardContent></Card><Card><CardHeader><CardTitle>按 Provider</CardTitle><CardDescription>Provider 路由分布</CardDescription></CardHeader><CardContent><DistributionList groups={summary.byProvider} label="Provider" /></CardContent></Card><Card><CardHeader><CardTitle>按渠道</CardTitle><CardDescription>实际出站渠道分布</CardDescription></CardHeader><CardContent><DistributionList groups={summary.byChannel} label="渠道" /></CardContent></Card></div>
      <Card><CardHeader><CardTitle>最近请求</CardTitle><CardDescription>包括 Chat Completions 与 Responses 调用</CardDescription></CardHeader><CardContent><RequestTable rows={data.recent} /></CardContent></Card>
    </div>
  );
}

function ManagementPage({ data, api, onRefresh, onNotice }: { data: DashboardData; api: GatewayApi; onRefresh: () => void; onNotice: (message: string) => void }) {
  const [channel, setChannel] = useState({ id: "", name: "", providerId: "", authRef: "", upstreamUrl: "", priority: "100", weight: "1", modelMappings: "" });
  const [key, setKey] = useState({ name: "", allowedModels: "", rpmLimit: "", tpmLimit: "", quotaTokens: "" });
  const [secret, setSecret] = useState("");
  const [saving, setSaving] = useState(false);
  const [copyState, setCopyState] = useState(false);

  const updateChannel = (name: string, value: string): void => setChannel((current) => ({ ...current, [name]: value }));
  const updateKey = (name: string, value: string): void => setKey((current) => ({ ...current, [name]: value }));
  const saveChannel = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!channel.id || !channel.providerId || !channel.authRef) return onNotice("渠道 ID、Provider 和认证引用不能为空");
    setSaving(true);
    try {
      let modelMappings: Record<string, string> | undefined;
      if (channel.modelMappings.trim()) {
        try { modelMappings = JSON.parse(channel.modelMappings) as Record<string, string>; } catch { onNotice("模型映射必须是合法 JSON 对象"); return; }
      }
      await api.saveChannel({ id: channel.id, name: channel.name || channel.id, providerId: channel.providerId, authRef: channel.authRef, upstreamUrl: channel.upstreamUrl || undefined, enabled: true, priority: Number(channel.priority) || 100, weight: Number(channel.weight) || 1, modelMappings });
      onNotice("渠道已保存");
      setChannel({ id: "", name: "", providerId: "", authRef: "", upstreamUrl: "", priority: "100", weight: "1", modelMappings: "" });
      onRefresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : "保存渠道失败"); } finally { setSaving(false); }
  };
  const createKey = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!key.name) return onNotice("请填写 Key 名称");
    setSaving(true);
    try {
      const created = await api.createKey({ name: key.name, allowedModels: key.allowedModels.split(",").map((item) => item.trim()).filter(Boolean), ...(key.rpmLimit ? { rpmLimit: Number(key.rpmLimit) } : {}), ...(key.tpmLimit ? { tpmLimit: Number(key.tpmLimit) } : {}), ...(key.quotaTokens ? { quotaTokens: Number(key.quotaTokens) } : {}) });
      setSecret(created.secret);
      setKey({ name: "", allowedModels: "", rpmLimit: "", tpmLimit: "", quotaTokens: "" });
      onRefresh();
    } catch (error) { onNotice(error instanceof Error ? error.message : "创建 Key 失败"); } finally { setSaving(false); }
  };
  const removeChannel = async (item: ChannelConfig): Promise<void> => { if (!window.confirm(`确认删除渠道「${item.name || item.id}」？`)) return; try { await api.deleteChannel(item.id); onRefresh(); } catch (error) { onNotice(error instanceof Error ? error.message : "删除渠道失败"); } };
  const toggleChannel = async (item: ChannelConfig): Promise<void> => { try { await api.saveChannel({ ...item, enabled: item.enabled === false }); onRefresh(); } catch (error) { onNotice(error instanceof Error ? error.message : "更新渠道失败"); } };
  const revokeKey = async (item: ApiKeyRecord): Promise<void> => { if (!window.confirm(`确认撤销 Key「${item.name}」？`)) return; try { await api.revokeKey(item.id); onRefresh(); } catch (error) { onNotice(error instanceof Error ? error.message : "撤销 Key 失败"); } };
  const copySecret = async (): Promise<void> => { if (!secret) return; await navigator.clipboard?.writeText(secret); setCopyState(true); window.setTimeout(() => setCopyState(false), 1600); };

  return (
    <div className="space-y-6">
      {data.adminError && <div className="flex items-start gap-2 rounded-xl border border-amber-400/25 bg-amber-400/10 p-3 text-sm text-amber-200"><AlertCircle className="mt-0.5 size-4 shrink-0" />{data.adminError}。在设置中保存管理员 API Key 后即可进行写操作。</div>}
      <div className="grid gap-6 xl:grid-cols-2">
        <Card><CardHeader><div className="flex items-center gap-2"><Network className="size-4 text-primary" /><CardTitle>新增渠道</CardTitle></div><CardDescription>通过 Provider、认证引用和优先级组成统一路由。</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={saveChannel}><div className="grid gap-4 sm:grid-cols-2"><Field label="渠道 ID"><Input value={channel.id} onChange={(event) => updateChannel("id", event.target.value)} placeholder="mimo-primary" /></Field><Field label="显示名称"><Input value={channel.name} onChange={(event) => updateChannel("name", event.target.value)} placeholder="MiMo 主渠道" /></Field><Field label="Provider"><Input value={channel.providerId} onChange={(event) => updateChannel("providerId", event.target.value)} placeholder="mimo / workbuddy" /></Field><Field label="认证引用"><Input value={channel.authRef} onChange={(event) => updateChannel("authRef", event.target.value)} placeholder="mimo" /></Field><Field label="优先级"><Input inputMode="numeric" value={channel.priority} onChange={(event) => updateChannel("priority", event.target.value)} placeholder="100" /></Field><Field label="权重"><Input inputMode="numeric" value={channel.weight} onChange={(event) => updateChannel("weight", event.target.value)} placeholder="1" /></Field></div><Field label="上游 URL（可选）"><Input value={channel.upstreamUrl} onChange={(event) => updateChannel("upstreamUrl", event.target.value)} placeholder="留空使用 Provider 默认地址" /></Field><Field label="模型映射 JSON（可选）"><Input value={channel.modelMappings} onChange={(event) => updateChannel("modelMappings", event.target.value)} placeholder={'{"public-model":"upstream-model"}'} /></Field><Button type="submit" disabled={saving || Boolean(data.adminError)}><Save className="size-4" />{saving ? "保存中..." : "保存渠道"}</Button></form></CardContent></Card>
        <Card><CardHeader><div className="flex items-center gap-2"><KeyRound className="size-4 text-cyan-300" /><CardTitle>创建访问 Key</CardTitle></div><CardDescription>为 Cline、Roo、DeepSeek Harness 等客户端分配独立凭证。</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={createKey}><Field label="Key 名称"><Input value={key.name} onChange={(event) => updateKey("name", event.target.value)} placeholder="local-client" /></Field><Field label="允许模型"><Input value={key.allowedModels} onChange={(event) => updateKey("allowedModels", event.target.value)} placeholder="留空表示全部模型，多个模型用逗号分隔" /></Field><div className="grid gap-4 sm:grid-cols-3"><Field label="RPM"><Input inputMode="numeric" value={key.rpmLimit} onChange={(event) => updateKey("rpmLimit", event.target.value)} placeholder="不限" /></Field><Field label="TPM"><Input inputMode="numeric" value={key.tpmLimit} onChange={(event) => updateKey("tpmLimit", event.target.value)} placeholder="不限" /></Field><Field label="Token 配额"><Input inputMode="numeric" value={key.quotaTokens} onChange={(event) => updateKey("quotaTokens", event.target.value)} placeholder="不限" /></Field></div><Button type="submit" disabled={saving || Boolean(data.adminError)}><Plus className="size-4" />创建 Key</Button></form>{secret && <div className="mt-5 rounded-xl border border-emerald-400/25 bg-emerald-400/10 p-3"><div className="mb-2 flex items-center justify-between gap-2"><div className="text-xs font-medium text-emerald-200">Secret 只显示这一次，请立即保存</div><Button variant="ghost" size="sm" onClick={copySecret}>{copyState ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}{copyState ? "已复制" : "复制"}</Button></div><code className="block break-all rounded-lg bg-black/15 p-2 font-mono text-xs text-emerald-100">{secret}</code></div>}</CardContent></Card>
      </div>
      <div className="grid gap-6 xl:grid-cols-2"><Card><CardHeader><CardTitle>渠道列表</CardTitle><CardDescription>{data.channels.length} 个已配置渠道</CardDescription></CardHeader><CardContent className="space-y-2">{data.channels.length === 0 && <EmptyState icon={Network} title="暂无渠道" />}{data.channels.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3"><div className="flex min-w-0 items-center gap-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><Network className="size-4" /></div><div className="min-w-0"><div className="truncate text-sm font-medium">{item.name || item.id}</div><div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{item.id} · {item.providerId} · {item.authRef}</div></div></div><div className="flex shrink-0 items-center gap-2"><StatusBadge status={item.enabled === false ? "offline" : "ready"} label={item.enabled === false ? "停用" : "启用"} /><Button variant="ghost" size="icon" onClick={() => void toggleChannel(item)} title="切换状态"><RefreshCw className="size-3.5" /></Button><Button variant="ghost" size="icon" onClick={() => void removeChannel(item)} title="删除"><Trash2 className="size-3.5 text-red-300" /></Button></div></div>)}</CardContent></Card><Card><CardHeader><CardTitle>虚拟 API Keys</CardTitle><CardDescription>{data.keys.length} 个已管理密钥</CardDescription></CardHeader><CardContent className="space-y-2">{data.keys.length === 0 && <EmptyState icon={KeyRound} title="暂无虚拟 Key" />}{data.keys.map((item) => <div key={item.id} className="flex items-center justify-between gap-3 rounded-xl border border-border/70 bg-muted/15 px-3.5 py-3"><div className="flex min-w-0 items-center gap-3"><div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-cyan-400/10 text-cyan-300"><KeyRound className="size-4" /></div><div className="min-w-0"><div className="truncate text-sm font-medium">{item.name}</div><div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground">{item.prefix}… · 已用 {formatCompact(item.usedTokens)} tokens</div></div></div><div className="flex shrink-0 items-center gap-2">{item.enabled ? <Badge variant="success">启用</Badge> : <Badge variant="muted">已撤销</Badge>}{item.enabled && <Button variant="ghost" size="icon" onClick={() => void revokeKey(item)} title="撤销"><Trash2 className="size-3.5 text-red-300" /></Button>}</div></div>)}</CardContent></Card></div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-2"><Label>{label}</Label>{children}</div>;
}

function SettingsPage({ credentials, onCredentials, theme, onTheme, onNotice }: { credentials: { apiKey: string; adminKey: string }; onCredentials: (next: { apiKey: string; adminKey: string }) => void; theme: "light" | "dark"; onTheme: () => void; onNotice: (message: string) => void }) {
  const [apiKey, setApiKey] = useState(credentials.apiKey);
  const [adminKey, setAdminKey] = useState(credentials.adminKey);
  const save = (event: FormEvent<HTMLFormElement>): void => { event.preventDefault(); const next = { apiKey: apiKey.trim(), adminKey: adminKey.trim() }; saveCredentials(next); onCredentials(next); onNotice("设置已保存"); };
  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <Card><CardHeader><div className="flex items-center gap-2"><KeyRound className="size-4 text-primary" /><CardTitle>访问凭证</CardTitle></div><CardDescription>只保存在当前浏览器 sessionStorage，不会写入 Gateway 配置。</CardDescription></CardHeader><CardContent><form className="space-y-4" onSubmit={save}><Field label="普通调用 API Key"><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="PROXY_API_KEY 或虚拟 Key" /></Field><Field label="管理员 API Key"><Input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} placeholder="PROXY_ADMIN_KEY" /></Field><div className="flex items-center gap-2"><Button type="submit"><Save className="size-4" />保存设置</Button><Button type="button" variant="ghost" onClick={() => { setApiKey(""); setAdminKey(""); saveCredentials({ apiKey: "", adminKey: "" }); onCredentials({ apiKey: "", adminKey: "" }); }}>清除</Button></div></form></CardContent></Card>
      <div className="space-y-6"><Card><CardHeader><div className="flex items-center gap-2"><Settings2 className="size-4 text-cyan-300" /><CardTitle>外观</CardTitle></div><CardDescription>主题设置只影响当前浏览器。</CardDescription></CardHeader><CardContent><div className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/15 p-3.5"><div className="flex items-center gap-3"><div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">{theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}</div><div><div className="text-sm font-medium">{theme === "dark" ? "深色模式" : "浅色模式"}</div><div className="text-[11px] text-muted-foreground">Tailwind design tokens</div></div></div><Button variant="outline" onClick={onTheme}>{theme === "dark" ? "切换浅色" : "切换深色"}</Button></div></CardContent></Card><Card><CardHeader><CardTitle>运行时信息</CardTitle><CardDescription>当前控制台和兼容接口地址</CardDescription></CardHeader><CardContent className="space-y-3 text-xs"><InfoRow label="控制台" value={`${location.origin}/ui`} /><InfoRow label="Chat Completions" value={`${location.origin}/v1/chat/completions`} /><InfoRow label="Responses" value={`${location.origin}/v1/responses`} /><InfoRow label="Models" value={`${location.origin}/v1/models`} /></CardContent><CardFooter className="border-t border-border/60 pt-4 text-[11px] text-muted-foreground"><Server className="mr-1.5 size-3.5" />首次认证独立完成，Gateway 只消费认证缓存。</CardFooter></Card></div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return <div className="flex flex-col gap-1 rounded-lg bg-muted/20 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between"><span className="text-muted-foreground">{label}</span><code className="break-all font-mono text-[11px] text-foreground">{value}</code></div>;
}

export function App() {
  const [page, setPage] = useState<PageKey>(() => resolvePage(window.location.hash));
  const [mobileNav, setMobileNav] = useState(false);
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [credentials, setCredentials] = useState(loadCredentials);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() => document.documentElement.classList.contains("dark") ? "dark" : "light");
  const api = useMemo(() => new GatewayApi(credentials), [credentials]);
  const meta = pageMeta[page];

  const navigate = useCallback((next: PageKey): void => {
    if (window.location.hash !== `#${next}`) window.history.replaceState(null, "", `#${next}`);
    setPage(next);
    setMobileNav(false);
  }, []);

  const refresh = useCallback(async (silent = false): Promise<void> => {
    if (!silent) setLoading(true);
    try {
      setData(await api.dashboard());
    } catch (error) {
      if (error instanceof ApiError) setNotice(error.message);
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    const onHashChange = (): void => setPage(resolvePage(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 10000);
    return () => { window.removeEventListener("hashchange", onHashChange); window.clearInterval(timer); };
  }, [refresh]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("llm-gateway.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {mobileNav && <button type="button" aria-label="关闭导航" className="fixed inset-0 z-20 bg-slate-950/65 backdrop-blur-sm md:hidden" onClick={() => setMobileNav(false)} />}
      <Sidebar page={page} onNavigate={navigate} mobileOpen={mobileNav} />
      <div className="md:pl-64">
        <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur-xl">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileNav(true)}><Menu className="size-4" /></Button><div className="min-w-0"><div className="truncate text-sm font-semibold">{meta.title}</div><div className="hidden truncate text-xs text-muted-foreground sm:block">{meta.description}</div></div></div>
            <div className="flex shrink-0 items-center gap-2"><StatusBadge status={data.health.status} /><Button variant="ghost" size="icon" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} title="切换主题">{theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}</Button><Button variant="outline" size="sm" onClick={() => void refresh()} disabled={loading}><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /><span className="hidden sm:inline">刷新</span></Button></div>
          </div>
        </header>
        <main className="mx-auto min-h-[calc(100vh-4rem)] max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {notice && <div className="mb-5 flex items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/10 px-3.5 py-3 text-sm text-primary"><div className="flex items-center gap-2"><CheckCircle2 className="size-4" />{notice}</div><Button variant="ghost" size="icon" onClick={() => setNotice("")}><X className="size-4" /></Button></div>}
          {page === "overview" && <OverviewPage data={data} onNavigate={navigate} />}
          {page === "playground" && <PlaygroundPage data={data} api={api} onRefresh={() => void refresh(true)} onNotice={setNotice} />}
          {page === "metrics" && <MetricsPage data={data} />}
          {page === "management" && <ManagementPage data={data} api={api} onRefresh={() => void refresh(true)} onNotice={setNotice} />}
          {page === "settings" && <SettingsPage credentials={credentials} onCredentials={setCredentials} theme={theme} onTheme={() => setTheme((current) => current === "dark" ? "light" : "dark")} onNotice={setNotice} />}
        </main>
      </div>
    </div>
  );
}

function Sidebar({ page, onNavigate, mobileOpen }: { page: PageKey; onNavigate: (page: PageKey) => void; mobileOpen: boolean }) {
  return (
    <aside className={cn("fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-border/70 bg-card/95 shadow-2xl backdrop-blur md:flex", mobileOpen ? "flex" : "hidden")}>
      <div className="flex h-16 items-center gap-3 border-b border-border/70 px-5"><div className="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-lg shadow-primary/20"><Zap className="size-4" /></div><div><div className="text-sm font-semibold tracking-tight">LLM Gateway</div><div className="font-mono text-[10px] text-muted-foreground">CONTROL PLANE</div></div></div>
      <div className="flex-1 overflow-y-auto px-3 py-5 scrollbar-thin"><div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Workspace</div><nav className="space-y-1">{navigation.map(({ key, icon: Icon }) => <button key={key} type="button" onClick={() => onNavigate(key)} className={cn("group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition", page === key ? "bg-primary/12 font-medium text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground")}><Icon className={cn("size-4", page === key ? "text-primary" : "text-muted-foreground group-hover:text-foreground")} /><span>{pageMeta[key].label}</span>{page === key && <ChevronRight className="ml-auto size-3.5" />}</button>)}</nav><Separator className="my-5" /><div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">Runtime</div><div className="rounded-xl border border-border/70 bg-muted/20 p-3"><div className="flex items-center gap-2 text-xs font-medium"><span className="size-2 animate-pulse rounded-full bg-emerald-400" />Perry Runtime</div><div className="mt-2 text-[11px] leading-5 text-muted-foreground">Web assets are embedded<br />inside one native binary.</div></div></div>
      <div className="border-t border-border/70 p-4"><div className="flex items-center gap-2 text-[11px] text-muted-foreground"><TerminalSquare className="size-3.5" />localhost control plane</div></div>
    </aside>
  );
}

function resolvePage(hash: string): PageKey {
  const value = hash.replace(/^#/, "") as PageKey;
  return value in pageMeta ? value : "overview";
}
