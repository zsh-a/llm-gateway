import { ArrowDown, ArrowUp, Bot, ChevronDown, RefreshCw, Square, Trash2 } from "lucide-react";
import { type FormEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";
import type { GatewayApi } from "../../api";
import { CopyButton, ResourceContent } from "../../components/common";
import { ModelPicker } from "../../components/ModelPicker";
import { Badge, Button, Card, Select, Spinner, Textarea } from "../../components/ui";
import { formatNumber, usageTotal } from "../../lib/format";
import { modelEfforts, modelSupportsReasoning } from "../../lib/models";
import type { DashboardData, GatewayModel, Navigate, Usage } from "../../types";

type Request = { model: GatewayModel; prompt: string; effort: string };
type Response = {
  state: "idle" | "streaming" | "success" | "error" | "canceled";
  content: string;
  reasoning: string;
  usage?: Usage;
  error: string;
  request?: Request;
};
const emptyResponse: Response = { state: "idle", content: "", reasoning: "", error: "" };
const examples = [
  { label: "测试文本", prompt: "用三句话解释流式响应。" },
  { label: "测试代码", prompt: "写一个 Python Hello World，并说明运行方式。" },
  { label: "测试表格", prompt: "用 Markdown 表格比较 HTTP 和 WebSocket。" },
];

export function PlaygroundPage({
  data,
  api,
  initialModelId,
  onNavigate,
  onRefresh,
  serviceAvailable = true,
}: {
  data: DashboardData;
  api: GatewayApi;
  initialModelId?: string;
  onNavigate: Navigate;
  onRefresh: () => void;
  serviceAvailable?: boolean;
}) {
  const [modelId, setModelId] = useState(initialModelId ?? data.models[0]?.id ?? "");
  const [effort, setEffort] = useState("auto");
  const [prompt, setPrompt] = useState("");
  const [response, setResponse] = useState<Response>(emptyResponse);
  const abortRef = useRef<AbortController | null>(null);
  const model = data.models.find((item) => item.id === modelId);
  const streaming = response.state === "streaming";
  useEffect(
    () => () => {
      abortRef.current?.abort();
      abortRef.current = null;
    },
    [],
  );
  useEffect(() => {
    if (initialModelId && data.models.some((item) => item.id === initialModelId))
      setModelId(initialModelId);
    else if (data.resources.models.hasData && !data.models.some((item) => item.id === modelId))
      setModelId(data.models[0]?.id ?? "");
  }, [data.models, data.resources.models.hasData, initialModelId, modelId]);
  useEffect(() => {
    if (!modelSupportsReasoning(model)) setEffort("auto");
    else if (effort !== "auto" && effort !== "off" && !Object.hasOwn(modelEfforts(model), effort))
      setEffort("auto");
  }, [model, effort]);

  const send = async (request: Request): Promise<void> => {
    if (abortRef.current || !serviceAvailable) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setResponse({ ...emptyResponse, state: "streaming", request });
    try {
      await api.streamChat(
        request.model,
        request.prompt,
        request.effort,
        (update) => {
          if (abortRef.current !== controller || controller.signal.aborted) return;
          setResponse((current) => ({
            ...current,
            content: current.content + (update.content ?? ""),
            reasoning: current.reasoning + (update.reasoning ?? ""),
            usage: update.usage ?? current.usage,
          }));
        },
        controller.signal,
      );
      if (!controller.signal.aborted && abortRef.current === controller)
        setResponse((current) => ({ ...current, state: "success" }));
    } catch (error) {
      if (!controller.signal.aborted && abortRef.current === controller)
        setResponse((current) => ({
          ...current,
          state: "error",
          error: error instanceof Error ? error.message : "请求失败，请重试",
        }));
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        onRefresh();
      }
    }
  };
  const stop = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setResponse((current) => ({ ...current, state: "canceled" }));
    onRefresh();
  };
  const clear = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setResponse(emptyResponse);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (model && prompt.trim() && !streaming)
      void send({ model: { ...model }, prompt: prompt.trim(), effort });
  };

  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[minmax(18rem,0.75fr)_minmax(0,1.25fr)]">
      <Card className="flex min-h-0 flex-col overflow-hidden">
        <form aria-label="模型请求" onSubmit={submit} className="flex h-full min-h-0 flex-col">
          <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
            <ResourceContent state={data.resources.models} label="模型">
              <div className="space-y-2">
                <label htmlFor="playground-model" className="text-sm font-medium">
                  模型
                </label>
                <ModelPicker
                  id="playground-model"
                  models={data.models}
                  value={modelId}
                  disabled={streaming || !data.models.length}
                  placeholder={data.models.length ? "选择模型" : "暂无可用模型"}
                  onChange={(id) => {
                    setModelId(id);
                    onNavigate("playground", { modelId: id, replace: true });
                  }}
                />
              </div>
            </ResourceContent>
            {modelSupportsReasoning(model) && (
              <div className="flex items-center justify-between gap-3">
                <label
                  htmlFor="playground-effort"
                  className="shrink-0 text-sm text-muted-foreground"
                >
                  思考强度
                </label>
                <Select
                  id="playground-effort"
                  className="h-9 max-w-44"
                  value={effort}
                  onChange={(event) => setEffort(event.target.value)}
                  disabled={streaming}
                >
                  <option value="auto">自动</option>
                  <option value="off">关闭</option>
                  {Object.keys(modelEfforts(model))
                    .filter((key) => key !== "off")
                    .map((key) => (
                      <option key={key} value={key}>
                        {key}
                      </option>
                    ))}
                </Select>
              </div>
            )}
            <div className="flex min-h-52 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between">
                <label htmlFor="playground-prompt" className="text-sm font-medium">
                  消息
                </label>
                <span className="text-xs text-muted-foreground">⌘ / Ctrl + Enter 发送</span>
              </div>
              <Textarea
                id="playground-prompt"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="输入消息，测试模型的响应效果…"
                disabled={streaming}
                className="min-h-44 flex-1 resize-none bg-background/50"
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {examples.map((example) => (
                <Button
                  key={example.label}
                  variant="outline"
                  size="sm"
                  disabled={streaming}
                  onClick={() => setPrompt(example.prompt)}
                >
                  {example.label}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-between gap-3 border-t px-5 py-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setPrompt("")}
              disabled={!prompt || streaming}
            >
              清空输入
            </Button>
            {streaming ? (
              <Button onClick={stop} variant="outline">
                <Square className="size-3.5" />
                停止生成
              </Button>
            ) : (
              <Button
                type="submit"
                disabled={
                  !serviceAvailable || !model || !prompt.trim() || !data.resources.models.hasData
                }
              >
                <ArrowUp className="size-4" />
                发送
              </Button>
            )}
          </div>
        </form>
      </Card>
      <ResponsePreview
        response={response}
        canRetry={serviceAvailable}
        onClear={clear}
        onRetry={() => {
          if (response.request) void send(response.request);
        }}
      />
    </div>
  );
}

function ResponsePreview({
  response,
  canRetry,
  onClear,
  onRetry,
}: {
  response: Response;
  canRetry: boolean;
  onClear: () => void;
  onRetry: () => void;
}) {
  const { state, content, reasoning, error, usage, request } = response;
  const scrollRef = useRef<HTMLDivElement>(null);
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
    error: "失败",
    canceled: "已停止",
  };
  return (
    <Card className="relative flex min-h-[26rem] min-w-0 flex-col overflow-hidden lg:min-h-0">
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
              variant={state === "error" ? "danger" : state === "success" ? "success" : "muted"}
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
      {usage && (
        <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 border-t px-5 py-3 text-xs text-muted-foreground">
          <span>输入 {formatNumber(usage.inputTokens)}</span>
          <span>输出 {formatNumber(usage.outputTokens)}</span>
          <span>总计 {formatNumber(usageTotal(usage))} tokens</span>
        </div>
      )}
    </Card>
  );
}
