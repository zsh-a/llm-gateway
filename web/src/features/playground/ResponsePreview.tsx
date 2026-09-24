import { ArrowDown, Bot, ChevronDown, RefreshCw, Trash2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import { CopyButton } from "../../components/common";
import { Badge, Button, Card, Spinner } from "../../components/ui";
import { formatDuration, formatNumber, usageTotal } from "../../lib/format";
import type { Navigate } from "../../types";
import type { PlaygroundResponse as Response } from "./types";

export function ResponsePreview({
  response,
  canRetry,
  onClear,
  onRetry,
  onNavigate,
}: {
  response: Response;
  canRetry: boolean;
  onClear: () => void;
  onRetry: () => void;
  onNavigate: Navigate;
}) {
  const { state, content, reasoning, error, usage, request } = response;
  const scrollRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (request && window.matchMedia("(max-width: 1023px)").matches)
      panelRef.current?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  }, [request]);
  const following = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const streaming = state === "streaming";
  useLayoutEffect(() => {
    if (request) {
      following.current = true;
      setAtBottom(true);
    }
  }, [request]);
  useLayoutEffect(() => {
    if (content || reasoning || state === "idle") {
      if (following.current && scrollRef.current)
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [content, reasoning, state]);
  const scrollToBottom = () => {
    following.current = true;
    setAtBottom(true);
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  };
  const labels = {
    idle: "待发送",
    streaming: "生成中",
    success: "已完成",
    incomplete: response.finishReason === "length" ? "达到输出上限" : "内容被过滤",
    error: "失败",
    canceled: "已停止",
  };
  return (
    <Card
      ref={panelRef}
      className="relative flex min-h-[26rem] min-w-0 scroll-mt-20 flex-col overflow-hidden lg:min-h-0"
    >
      <div className="flex shrink-0 items-start justify-between gap-3 border-b px-5 py-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold">响应</h2>
          {request && (
            <p className="mt-1 truncate text-xs text-muted-foreground" title={request.model.id}>
              {request.model.name || request.model.id} ·{" "}
              {request.effort === "auto"
                ? "自动"
                : request.effort === "off"
                  ? "关闭思考"
                  : request.effort}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {(content || reasoning) && (
            <CopyButton
              value={[reasoning ? `思考过程\n${reasoning}` : "", content]
                .filter(Boolean)
                .join("\n\n")}
              label="复制"
            />
          )}
          {request && !streaming && (
            <>
              <Button
                variant="ghost"
                size="icon"
                onClick={onRetry}
                disabled={!canRetry}
                title="重试原请求"
                aria-label="重试原请求"
              >
                <RefreshCw className="size-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onClear}
                title="清空响应"
                aria-label="清空响应"
              >
                <Trash2 className="size-4" />
              </Button>
            </>
          )}
          <span role="status" aria-live="polite">
            <Badge
              variant={
                state === "error"
                  ? "danger"
                  : state === "incomplete"
                    ? "warning"
                    : state === "success"
                      ? "success"
                      : "muted"
              }
            >
              {streaming && <Spinner className="size-3" />}
              {labels[state]}
            </Badge>
          </span>
        </div>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5 scrollbar-thin"
        onScroll={(event) => {
          const target = event.currentTarget;
          const bottom = target.scrollHeight - target.scrollTop - target.clientHeight < 40;
          following.current = bottom;
          setAtBottom(bottom);
        }}
      >
        {state === "idle" && (
          <div className="flex h-full min-h-56 flex-col items-center justify-center gap-3 text-center">
            <Bot className="size-8 text-primary/70" />
            <p className="text-sm font-medium">从一条消息开始</p>
            <p className="max-w-xs text-sm text-muted-foreground">
              选择模型并发送消息，响应会实时显示在这里。
            </p>
          </div>
        )}
        {error && (
          <div
            role="alert"
            className="mb-4 rounded-lg bg-destructive/5 px-4 py-3 text-sm leading-6 text-destructive"
          >
            {error}
          </div>
        )}
        {state === "incomplete" && (
          <div
            role="status"
            className="mb-4 rounded-lg bg-warning/10 p-3 text-sm leading-6 text-warning"
          >
            {response.finishReason === "length"
              ? "响应因达到输出预算而结束，内容可能不完整。可调整最大输出 Token 后重新发送。"
              : "上游因内容过滤结束了响应，以下为已收到的内容。"}
          </div>
        )}
        {reasoning && (
          <details className="group mb-5 border-b pb-4">
            <summary className="flex cursor-pointer list-none items-center gap-2 text-sm text-muted-foreground [&::-webkit-details-marker]:hidden">
              <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
              思考过程
            </summary>
            <div className="mt-3 whitespace-pre-wrap text-sm leading-7 text-muted-foreground">
              {reasoning}
            </div>
          </details>
        )}
        {content && (
          <Streamdown
            className="response-markdown text-sm leading-7"
            isAnimating={streaming}
            mode={streaming ? "streaming" : "static"}
            controls={{
              code: { copy: true, download: false },
              table: { copy: true, download: false, fullscreen: false },
            }}
            translations={{
              copyCode: "复制代码",
              copied: "已复制",
              copyTable: "复制表格",
              copyTableAsMarkdown: "复制为 Markdown",
              copyTableAsCsv: "复制为 CSV",
              copyTableAsTsv: "复制为 TSV",
            }}
            codeBlockMaxHeight={0}
            tableMaxHeight={0}
          >
            {content}
          </Streamdown>
        )}
        {streaming && !content && (
          <div role="status" className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Spinner />
            {reasoning ? "正在思考…" : "正在等待模型响应…"}
          </div>
        )}
      </div>
      {!atBottom && (
        <Button
          variant="outline"
          size="sm"
          className="absolute bottom-16 left-1/2 -translate-x-1/2 bg-card shadow-sm"
          onClick={scrollToBottom}
        >
          <ArrowDown className="size-3.5" />
          回到底部
        </Button>
      )}
      {request && (
        <div className="shrink-0 space-y-2 border-t px-5 py-3 text-xs text-muted-foreground">
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            <span>耗时 {formatDuration(response.durationMs)}</span>
            <span>首个输出 {formatDuration(response.firstTokenMs)}</span>
            {response.finishReason && <span>结束原因 {response.finishReason}</span>}
          </div>
          {usage ? (
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <span>
                输入 {usage.inputTokens === undefined ? "—" : formatNumber(usage.inputTokens)}
              </span>
              <span>
                输出 {usage.outputTokens === undefined ? "—" : formatNumber(usage.outputTokens)}
              </span>
              <span>
                总计 {usageTotal(usage) === undefined ? "—" : formatNumber(usageTotal(usage))}{" "}
                tokens
              </span>
            </div>
          ) : (
            !streaming && <p>上游未返回用量</p>
          )}
          {response.requestId && (
            <div className="flex flex-wrap items-center gap-2">
              <code className="min-w-0 break-all">{response.requestId}</code>
              <CopyButton value={response.requestId} label="复制 Request ID" />
              {!streaming && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onNavigate("metrics", { requestId: response.requestId })}
                >
                  查看请求记录
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
