import {
  Activity,
  ChevronDown,
  ChevronUp
} from "lucide-react";
import {
  Fragment,
  useState
} from "react";
import type { RecentRequest, Usage } from "../types";
import {
  formatCompact,
  formatDuration,
  formatNumber,
  formatTime,
  usageTotal
} from "../lib/format";
import { cn } from "../lib/utils";
import {
  Badge,
  Button
} from "./ui";
import {
  EmptyState,
  InfoRow,
  StatusBadge
} from "./common";

function tokenValue(value: number | undefined): string {
  return value === undefined ? "—" : formatNumber(value);
}

function maxTokenValue(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter((value): value is number => (
    value !== undefined && Number.isFinite(value) && value >= 0
  ));
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function BreakdownCard({
  title,
  breakdown
}: {
  title: string;
  breakdown?: Usage["inputDetails"];
}) {
  const rows: Array<[string, number | undefined]> = [
    ["缓存命中", breakdown?.cachedTokens],
    ["音频", breakdown?.audioTokens],
    ["图像", breakdown?.imageTokens],
    ["文本", breakdown?.textTokens],
    ["推理", breakdown?.reasoningTokens],
    ["接受预测", breakdown?.acceptedPredictionTokens],
    ["拒绝预测", breakdown?.rejectedPredictionTokens]
  ];
  const visibleRows = rows.filter(([, value]) => value !== undefined);
  return (
    <div className="rounded-xl border border-border/70 bg-background/35 p-3">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</div>
      {visibleRows.length > 0 ? (
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {visibleRows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-2 text-xs">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono text-foreground">{tokenValue(value)}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-xs text-muted-foreground">上游未返回拆分明细</div>
      )}
    </div>
  );
}

export function UsageDetails({ usage }: { usage?: Usage | null }) {
  if (!usage) {
    return <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5 text-xs text-amber-200">上游没有返回 usage，当前请求无法进行准确 Token 统计。</div>;
  }

  const cachedTokens = maxTokenValue(usage.cachedTokens, usage.inputDetails?.cachedTokens);
  const inputDetails = {
    ...(usage.inputDetails ?? {}),
    cachedTokens,
    audioTokens: usage.inputAudioTokens ?? usage.inputDetails?.audioTokens,
    imageTokens: usage.inputImageTokens ?? usage.inputDetails?.imageTokens
  };
  const outputDetails = {
    ...(usage.outputDetails ?? {}),
    audioTokens: usage.outputAudioTokens ?? usage.outputDetails?.audioTokens,
    imageTokens: usage.outputImageTokens ?? usage.outputDetails?.imageTokens,
    reasoningTokens: usage.reasoningTokens ?? usage.outputDetails?.reasoningTokens,
    acceptedPredictionTokens: usage.acceptedPredictionTokens ?? usage.outputDetails?.acceptedPredictionTokens,
    rejectedPredictionTokens: usage.rejectedPredictionTokens ?? usage.outputDetails?.rejectedPredictionTokens
  };
  const cards: Array<[string, string, string]> = [
    ["总 Token", tokenValue(usage.totalTokens), "text-foreground"],
    ["输入", tokenValue(usage.inputTokens), "text-cyan-200"],
    ["输出", tokenValue(usage.outputTokens), "text-primary"],
    ["缓存命中", tokenValue(cachedTokens), "text-emerald-300"],
    ["推理", tokenValue(usage.reasoningTokens), "text-violet-200"],
    ["缓存写入", tokenValue(usage.cacheCreationTokens), "text-amber-200"]
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map(([label, value, color]) => (
          <div key={label} className="rounded-xl border border-border/70 bg-background/35 px-3 py-2.5">
            <div className="text-[10px] text-muted-foreground">{label}</div>
            <div className={cn("mt-1 font-mono text-sm font-medium", color)}>{value}</div>
          </div>
        ))}
      </div>
      <div className="grid gap-3 md:grid-cols-2">
        <BreakdownCard title="输入 Token 明细" breakdown={inputDetails} />
        <BreakdownCard title="输出 Token 明细" breakdown={outputDetails} />
      </div>
    </div>
  );
}

function RequestDetails({ row }: { row: RecentRequest }) {
  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-muted/15 p-3.5">
      <div className="grid gap-2 md:grid-cols-2">
        <InfoRow label="Request ID" value={row.id || "—"} />
        <InfoRow label="开始时间" value={formatTime(row.startedAt, true)} />
        <InfoRow label="完成时间" value={formatTime(row.completedAt, true)} />
        <InfoRow label="耗时" value={formatDuration(row.durationMs)} />
        <InfoRow label="Provider" value={row.provider || "—"} />
        <InfoRow label="渠道" value={row.channelId || "—"} />
        <InfoRow label="思考强度" value={row.reasoningEffort || "—"} />
        <InfoRow label="Finish reason" value={row.finishReason || "—"} />
        <InfoRow label="工具调用" value={row.toolCalls === undefined ? "—" : formatNumber(row.toolCalls)} />
      </div>
      <div>
        <div className="mb-2 text-xs font-medium text-foreground">Token 用量</div>
        <UsageDetails usage={row.usage} />
      </div>
    </div>
  );
}

export function RequestTable({ rows }: { rows: RecentRequest[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!rows.length) return <EmptyState icon={Activity} title="暂无请求记录" description="API 请求完成后会在这里显示" />;

  const toggle = (id: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="overflow-x-auto rounded-xl border border-border/70">
      <table className="w-full min-w-[800px] text-left text-xs">
        <thead className="bg-muted/45 text-[10px] uppercase tracking-wider text-muted-foreground">
          <tr>
            <th className="w-10 px-2 py-2.5 font-medium" />
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
          {rows.map((row) => {
            const isExpanded = expanded.has(row.id);
            return (
              <Fragment key={row.id}>
                <tr className="transition hover:bg-muted/20">
                  <td className="px-2 py-2.5">
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={isExpanded ? "收起请求详情" : "展开请求详情"}
                      aria-expanded={isExpanded}
                      onClick={() => toggle(row.id)}
                    >
                      {isExpanded ? <ChevronUp className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    </Button>
                  </td>
                  <td className="whitespace-nowrap px-3 py-3 font-mono text-muted-foreground">{formatTime(row.startedAt, true)}</td>
                  <td className="max-w-48 truncate px-3 py-3 font-medium text-foreground">{row.model || "—"}</td>
                  <td className="px-3 py-3 text-muted-foreground">{row.provider || "—"}</td>
                  <td className="px-3 py-3"><Badge variant="muted">{row.protocol || "chat"}</Badge></td>
                  <td className="px-3 py-3 text-muted-foreground">{formatDuration(row.durationMs)}</td>
                  <td className="px-3 py-3 font-mono text-muted-foreground">{formatCompact(usageTotal(row.usage ?? undefined))}</td>
                  <td className="px-3 py-3"><StatusBadge status={row.status} label={row.status === "success" ? "成功" : row.status === "error" ? "失败" : "取消"} /></td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={8} className="bg-muted/10 px-3 py-3">
                      <RequestDetails row={row} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
