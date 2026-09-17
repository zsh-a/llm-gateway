import type { LucideIcon } from "lucide-react";
import { BarChart3, Check, CircleDashed, Copy, Database } from "lucide-react";
import type { ReactNode } from "react";
import { useState } from "react";
import { formatCompact, formatNumber, formatTime, toFiniteNumber } from "../lib/format";
import { cn } from "../lib/utils";
import type { MetricGroup, TimeseriesPoint } from "../types";
import { Badge, Card, CardContent, Progress } from "./ui";

export function statusVariant(
  status: string | undefined,
): "success" | "warning" | "danger" | "muted" {
  if (status === "success" || status === "ok" || status === "ready") return "success";
  if (status === "error" || status === "offline") return "danger";
  if (status === "pending" || status === "starting" || status === "not_ready") return "warning";
  return "muted";
}

export function StatusBadge({ status, label }: { status: string | undefined; label?: string }) {
  const online = status === "ok" || status === "ready" || status === "success";
  const statusLabels: Record<string, string> = {
    canceled: "已取消",
    error: "失败",
    not_ready: "未就绪",
    offline: "离线",
    pending: "等待中",
    ready: "就绪",
    starting: "启动中",
    success: "成功",
    unknown: "未知",
  };
  return (
    <Badge variant={statusVariant(status)}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          online ? "bg-emerald-400" : status === "offline" ? "bg-red-400" : "bg-amber-300",
        )}
      />
      {label ?? (online ? "在线" : (statusLabels[status ?? "unknown"] ?? status ?? "未知"))}
    </Badge>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-4 flex items-end justify-between gap-4">
      <div>
        {eyebrow && (
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-primary">
            {eyebrow}
          </div>
        )}
        <h2 className="text-base font-semibold tracking-tight text-foreground">{title}</h2>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function EmptyState({
  icon: Icon = CircleDashed,
  title = "暂无数据",
  description,
}: {
  icon?: LucideIcon;
  title?: string;
  description?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-36 flex-col items-center justify-center rounded-xl",
        "border border-dashed border-border/80 bg-muted/15 px-5 text-center",
      )}
    >
      <div className="mb-3 flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div className="text-sm text-foreground">{title}</div>
      {description && <div className="mt-1 text-xs text-muted-foreground">{description}</div>}
    </div>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  tone = "primary",
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  detail: string;
  tone?: "primary" | "cyan" | "green" | "amber";
}) {
  const tones = {
    primary: "bg-primary/12 text-primary",
    cyan: "bg-cyan-400/12 text-cyan-300",
    green: "bg-emerald-400/12 text-emerald-300",
    amber: "bg-amber-400/12 text-amber-300",
  };
  return (
    <Card className="overflow-hidden border-border/70 bg-card/85 transition-colors hover:border-primary/25">
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

export function Sparkline({
  values,
  color = "var(--chart-1)",
}: {
  values: number[];
  color?: string;
}) {
  if (values.length < 2) return <div className="h-8 w-24 rounded-md bg-muted/60" />;
  const max = Math.max(...values, 1);
  const points = values
    .map((value, index) => `${(index / (values.length - 1)) * 100},${28 - (value / max) * 24}`)
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 30"
      className="h-8 w-24 overflow-visible"
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function MetricChart({ points }: { points: TimeseriesPoint[] }) {
  const width = 820;
  const height = 230;
  const padding = { top: 18, right: 20, bottom: 26, left: 42 };
  const requests = points.map((point) => toFiniteNumber(point.requests));
  const tokens = points.map((point) => toFiniteNumber(point.tokens?.totalTokens));
  const maxRequest = Math.max(...requests, 1);
  const maxToken = Math.max(...tokens, 1);
  const x = (index: number) =>
    padding.left +
    (index / Math.max(points.length - 1, 1)) * (width - padding.left - padding.right);
  const y = (value: number, max: number) =>
    padding.top + (1 - value / max) * (height - padding.top - padding.bottom);
  const requestPoints = requests
    .map((value, index) => `${x(index)},${y(value, maxRequest)}`)
    .join(" ");
  const tokenPoints = tokens.map((value, index) => `${x(index)},${y(value, maxToken)}`).join(" ");
  const baseline = height - padding.bottom;
  const lastRequest = requests[requests.length - 1] ?? 0;
  const lastToken = tokens[tokens.length - 1] ?? 0;
  const chartLabel = [
    "请求和 Token 趋势，最近一个时间桶请求 ",
    formatNumber(lastRequest),
    "，Token ",
    formatNumber(lastToken),
  ].join("");

  if (!points.length)
    return (
      <EmptyState
        icon={BarChart3}
        title="暂时没有统计数据"
        description="产生请求后，趋势会自动出现在这里"
      />
    );

  return (
    <div className="space-y-3">
      <div className="h-64 overflow-hidden rounded-xl border border-border/70 bg-background/50 p-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-full w-full"
          role="img"
          aria-label={chartLabel}
        >
          {[0, 1, 2, 3].map((step) => {
            const lineY = padding.top + (step / 3) * (height - padding.top - padding.bottom);
            return (
              <g key={step}>
                <line
                  x1={padding.left}
                  x2={width - padding.right}
                  y1={lineY}
                  y2={lineY}
                  stroke="var(--border)"
                  strokeOpacity="0.65"
                  strokeDasharray="3 5"
                />
                <text
                  x={padding.left - 8}
                  y={lineY + 3}
                  fill="var(--muted-foreground)"
                  fontSize="9"
                  textAnchor="end"
                >
                  {formatCompact(maxRequest * (1 - step / 3))}
                </text>
                <text
                  x={width - padding.right + 8}
                  y={lineY + 3}
                  fill="var(--muted-foreground)"
                  fontSize="9"
                >
                  {formatCompact(maxToken * (1 - step / 3))}
                </text>
              </g>
            );
          })}
          <polygon
            points={`${padding.left},${baseline} ${requestPoints} ${width - padding.right},${baseline}`}
            fill="var(--chart-1)"
            fillOpacity="0.08"
          />
          <polyline
            points={requestPoints}
            fill="none"
            stroke="var(--chart-1)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="3"
          />
          <polyline
            points={tokenPoints}
            fill="none"
            stroke="var(--chart-2)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2.5"
          />
          {points.map((point, index) => (
            <g key={point.start}>
              <circle
                cx={x(index)}
                cy={y(requests[index], maxRequest)}
                r="3"
                fill="var(--card)"
                stroke="var(--chart-1)"
                strokeWidth="2"
              />
              <title>
                {formatTime(point.start)} · 请求 {formatNumber(requests[index])} · Token{" "}
                {formatNumber(tokens[index])}
              </title>
            </g>
          ))}
          <text x={padding.left} y={height - 7} fill="var(--muted-foreground)" fontSize="10">
            {formatTime(points[0]?.start)}
          </text>
          <text
            x={width - padding.right}
            y={height - 7}
            fill="var(--muted-foreground)"
            fontSize="10"
            textAnchor="end"
          >
            {formatTime(points[points.length - 1]?.start)}
          </text>
        </svg>
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-chart-1" />
          请求 <span className="font-mono text-foreground">{formatNumber(lastRequest)}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-full bg-chart-2" />
          Token <span className="font-mono text-foreground">{formatCompact(lastToken)}</span>
        </span>
        <span className="ml-auto text-[10px]">左右刻度分别归一化</span>
      </div>
    </div>
  );
}

export function DistributionList({ groups, label }: { groups: MetricGroup[]; label: string }) {
  const total = groups.reduce((sum, group) => sum + group.requests, 0);
  return (
    <div className="space-y-3">
      {groups.length === 0 && <EmptyState icon={Database} title={`暂无${label}数据`} />}
      {groups.slice(0, 6).map((group) => (
        <div key={group.key}>
          <div className="mb-1.5 flex items-center justify-between gap-3 text-xs">
            <span className="truncate text-foreground">{group.key || "未标识"}</span>
            <span className="shrink-0 font-mono text-muted-foreground">
              {formatNumber(group.requests)} ·{" "}
              {total ? Math.round((group.requests / total) * 100) : 0}%
            </span>
          </div>
          <Progress value={total ? (group.requests / total) * 100 : 0} />
        </div>
      ))}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="block space-y-2">
      <label htmlFor={htmlFor} className="block text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
    </div>
  );
}

export function InfoRow({
  label,
  value,
  copyable = false,
}: {
  label: string;
  value: string;
  copyable?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-lg bg-muted/20 px-3 py-2.5",
        "sm:flex-row sm:items-center sm:justify-between",
      )}
    >
      <span className="text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center justify-between gap-2 sm:justify-end">
        <code className="break-all font-mono text-[11px] text-foreground">{value}</code>
        {copyable && <CopyButton value={value} />}
      </div>
    </div>
  );
}

export function CopyButton({ value, label = "复制" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);

  const copy = async (): Promise<void> => {
    if (!navigator.clipboard || !value) {
      setCopyError(true);
      window.setTimeout(() => setCopyError(false), 1600);
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setCopyError(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyError(true);
      window.setTimeout(() => setCopyError(false), 1600);
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1",
        "text-[11px] text-muted-foreground transition-colors",
        "hover:bg-muted hover:text-foreground focus-visible:outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
      )}
      aria-label={copyError ? "复制失败" : copied ? "已复制" : label}
      title={copyError ? "复制失败，请手动复制" : copied ? "已复制" : label}
    >
      {copyError ? (
        <Copy className="size-3 text-red-300" />
      ) : copied ? (
        <Check className="size-3" />
      ) : (
        <Copy className="size-3" />
      )}
      <span className="hidden sm:inline">{copyError ? "复制失败" : copied ? "已复制" : label}</span>
    </button>
  );
}
