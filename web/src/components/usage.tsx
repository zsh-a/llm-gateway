import { Activity, ChevronDown, ChevronUp } from "lucide-react";
import { Fragment, useState } from "react";
import { formatCompact, formatDuration, formatNumber, formatTime, usageTotal } from "../lib/format";
import { cn } from "../lib/utils";
import type { RecentRequest, Usage } from "../types";
import { EmptyState, InfoRow, StatusBadge } from "./common";
import { Badge, Button } from "./ui";

function tokenValue(value: number | undefined): string {
  return value === undefined ? "—" : formatNumber(value);
}

function maxTokenValue(...values: Array<number | undefined>): number | undefined {
  const defined = values.filter(
    (value): value is number => value !== undefined && Number.isFinite(value) && value >= 0,
  );
  return defined.length > 0 ? Math.max(...defined) : undefined;
}

function BreakdownCard({ title, breakdown }: { title: string; breakdown?: Usage["inputDetails"] }) {
  const rows: Array<[string, number | undefined]> = [
    ["缓存命中", breakdown?.cachedTokens],
    ["音频", breakdown?.audioTokens],
    ["图像", breakdown?.imageTokens],
    ["文本", breakdown?.textTokens],
    ["推理", breakdown?.reasoningTokens],
    ["接受预测", breakdown?.acceptedPredictionTokens],
    ["拒绝预测", breakdown?.rejectedPredictionTokens],
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
    return (
      <div className="rounded-xl border border-amber-400/20 bg-amber-400/5 px-3 py-2.5 text-xs text-warning">
        上游没有返回 usage，当前请求无法进行准确 Token 统计。
      </div>
    );
  }

  const cachedTokens = maxTokenValue(usage.cachedTokens, usage.inputDetails?.cachedTokens);
  const inputDetails = {
    ...(usage.inputDetails ?? {}),
    cachedTokens,
    audioTokens: usage.inputAudioTokens ?? usage.inputDetails?.audioTokens,
    imageTokens: usage.inputImageTokens ?? usage.inputDetails?.imageTokens,
  };
  const outputDetails = {
    ...(usage.outputDetails ?? {}),
    audioTokens: usage.outputAudioTokens ?? usage.outputDetails?.audioTokens,
    imageTokens: usage.outputImageTokens ?? usage.outputDetails?.imageTokens,
    reasoningTokens: usage.reasoningTokens ?? usage.outputDetails?.reasoningTokens,
    acceptedPredictionTokens:
      usage.acceptedPredictionTokens ?? usage.outputDetails?.acceptedPredictionTokens,
    rejectedPredictionTokens:
      usage.rejectedPredictionTokens ?? usage.outputDetails?.rejectedPredictionTokens,
  };
  const cards: Array<[string, string, string]> = [
    ["总 Token", tokenValue(usage.totalTokens), "text-foreground"],
    ["输入", tokenValue(usage.inputTokens), "text-info"],
    ["输出", tokenValue(usage.outputTokens), "text-primary"],
    ["缓存命中", tokenValue(cachedTokens), "text-success"],
    ["推理", tokenValue(usage.reasoningTokens), "text-primary"],
    ["缓存写入", tokenValue(usage.cacheCreationTokens), "text-warning"],
  ];

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {cards.map(([label, value, color]) => (
          <div
            key={label}
            className="rounded-xl border border-border/70 bg-background/35 px-3 py-2.5"
          >
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
  const diagnostics = row.diagnostics;
  const failure = diagnostics?.error;
  const budget = (values: Record<string, number>) =>
    Object.entries(values)
      .map(([name, value]) => `${name}: ${formatNumber(value)}`)
      .join(" · ") || "未指定，采用上游默认值";
  const stageNames: Record<string, string> = {
    connect: "建立连接",
    response_headers: "等待响应头",
    first_byte: "等待首个数据",
    stream_idle: "等待后续数据",
    response_body: "读取响应体",
  };
  return (
    <div className="space-y-4 rounded-xl border border-border/70 bg-muted/15 p-3.5">
      {failure && (
        <div
          className="rounded-xl border border-destructive/25 bg-destructive/5 p-3 text-sm"
          role="alert"
        >
          <p className="font-medium">{failure.message}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {stageNames[failure.stage] || failure.stage} · {failure.code}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {diagnostics.receivedBytes > 0
              ? "中断前已收到上游数据；缺少 usage 不代表没有生成输出。"
              : diagnostics.responseHeadersMs !== null
                ? "已收到上游响应头，但尚未收到响应体数据。"
                : "尚未收到上游响应头或响应体数据。"}
          </p>
        </div>
      )}
      {row.status === "error" && !diagnostics && (
        <p className="text-xs text-muted-foreground">
          此历史记录未保存错误阶段，无法区分连接、首包或数据中断。
        </p>
      )}
      <div className="grid gap-2 md:grid-cols-2">
        <InfoRow label="模型" value={row.model || "—"} />
        <InfoRow label="协议" value={row.protocol || "chat"} />
        <InfoRow label="API Key" value={row.apiKeyName || row.apiKeyId || "—"} />
        <InfoRow label="Request ID" value={row.id || "—"} />
        <InfoRow label="开始时间" value={formatTime(row.startedAt, true)} />
        <InfoRow label="完成时间" value={formatTime(row.completedAt, true)} />
        <InfoRow label="耗时" value={formatDuration(row.durationMs)} />
        <InfoRow label="结果状态码" value={row.statusCode == null ? "—" : String(row.statusCode)} />
        <InfoRow label="Provider" value={row.provider || "—"} />
        <InfoRow label="渠道" value={row.channelId || "—"} />
        <InfoRow label="思考强度" value={row.reasoningEffort || "—"} />
        <InfoRow label="Finish reason" value={row.finishReason || "—"} />
        <InfoRow
          label="工具调用"
          value={row.toolCalls === undefined ? "—" : formatNumber(row.toolCalls)}
        />
      </div>
      {diagnostics && (
        <div className="grid gap-2 md:grid-cols-2">
          <InfoRow label="渠道尝试次数" value={String(diagnostics.attempts)} />
          <InfoRow
            label="收到响应头"
            value={
              diagnostics.responseHeadersMs === null
                ? "未收到"
                : formatDuration(diagnostics.responseHeadersMs)
            }
          />
          <InfoRow
            label="首个数据到达"
            value={
              diagnostics.firstByteMs === null ? "未收到" : formatDuration(diagnostics.firstByteMs)
            }
          />
          <InfoRow
            label="最后数据到达"
            value={
              diagnostics.lastByteMs === null ? "未收到" : formatDuration(diagnostics.lastByteMs)
            }
          />
          <InfoRow
            label="已收数据"
            value={`${formatNumber(diagnostics.receivedBytes)} 字节 / ${formatNumber(diagnostics.receivedChunks)} 块`}
          />
          {failure?.timeoutMs != null && (
            <InfoRow label="超时阈值" value={formatDuration(failure.timeoutMs)} />
          )}
        </div>
      )}
      {diagnostics?.outputBudget && (
        <div className="grid gap-2">
          <InfoRow label="请求输出预算" value={budget(diagnostics.outputBudget.requested)} />
          <InfoRow label="发送给上游的预算" value={budget(diagnostics.outputBudget.upstream)} />
        </div>
      )}
      {diagnostics?.attemptDetails?.some((attempt) => attempt.error) && (
        <div className="space-y-2 text-xs text-muted-foreground">
          {diagnostics.attemptDetails.map((attempt, index) => (
            <p key={attempt.channelId}>
              {index + 1}. {attempt.channelId} · {attempt.model}：
              {attempt.error?.message ?? "已接收上游响应"}
            </p>
          ))}
        </div>
      )}
      <div>
        <div className="mb-2 text-xs font-medium text-foreground">
          {row.status !== "success" && row.usage ? "中断前 Token 用量（可能不完整）" : "Token 用量"}
        </div>
        <UsageDetails usage={row.usage} />
      </div>
    </div>
  );
}

function requestStatusLabel(row: RecentRequest): string {
  if (row.status === "success" && row.finishReason === "length") return "达到输出上限";
  if (row.status === "success" && row.finishReason === "content_filter") return "内容过滤";
  if (row.status === "success") return "成功";
  if (row.status !== "error") return "取消";
  const labels: Record<string, string> = {
    upstream_connect_timeout: "连接超时",
    upstream_first_byte_timeout: "首包超时",
    upstream_idle_timeout: "数据中断超时",
  };
  return labels[row.diagnostics?.error?.code ?? ""] ?? "失败";
}

export function RequestTable({ rows }: { rows: RecentRequest[] }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  if (!rows.length)
    return (
      <EmptyState icon={Activity} title="暂无请求记录" description="API 请求完成后会在这里显示" />
    );

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
      <table className="w-full text-left text-sm" aria-label="最近请求记录">
        <caption className="sr-only">最近请求记录</caption>
        <thead className="bg-muted/45 text-xs text-muted-foreground">
          <tr>
            <th className="w-10 px-2 py-2.5 font-medium" />
            <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">
              时间
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              模型
            </th>
            <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">
              API Key
            </th>
            <th scope="col" className="hidden px-3 py-2.5 font-medium xl:table-cell">
              Provider
            </th>
            <th scope="col" className="hidden px-3 py-2.5 font-medium xl:table-cell">
              协议
            </th>
            <th scope="col" className="hidden px-3 py-2.5 font-medium md:table-cell">
              耗时
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              Token
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              状态
            </th>
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
                      {isExpanded ? (
                        <ChevronUp className="size-3.5" />
                      ) : (
                        <ChevronDown className="size-3.5" />
                      )}
                    </Button>
                  </td>
                  <td className="hidden whitespace-nowrap px-3 py-3 font-mono text-xs text-muted-foreground md:table-cell">
                    {formatTime(row.startedAt, true)}
                  </td>
                  <td
                    className="max-w-24 truncate px-3 py-3 font-medium text-foreground sm:max-w-48"
                    title={row.model}
                  >
                    {row.model || "—"}
                  </td>
                  <td
                    className="hidden max-w-36 truncate px-3 py-3 text-muted-foreground md:table-cell"
                    title={row.apiKeyId}
                  >
                    {row.apiKeyName || row.apiKeyId || "—"}
                  </td>
                  <td className="hidden px-3 py-3 text-muted-foreground xl:table-cell">
                    {row.provider || "—"}
                  </td>
                  <td className="hidden px-3 py-3 xl:table-cell">
                    <Badge variant="muted">{row.protocol || "chat"}</Badge>
                  </td>
                  <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">
                    {formatDuration(row.durationMs)}
                  </td>
                  <td className="px-3 py-3 font-mono text-muted-foreground">
                    {row.usage?.totalTokens === undefined && row.usage?.inputTokens === undefined
                      ? "用量未知"
                      : formatCompact(usageTotal(row.usage ?? undefined))}
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge
                      status={
                        row.status === "success" &&
                        ["length", "content_filter"].includes(row.finishReason ?? "")
                          ? "incomplete"
                          : row.status
                      }
                      label={requestStatusLabel(row)}
                    />
                  </td>
                </tr>
                {isExpanded && (
                  <tr>
                    <td colSpan={9} className="bg-muted/10 px-3 py-3">
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
