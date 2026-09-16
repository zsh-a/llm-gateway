import {
  AlertCircle,
  Bot,
  Check,
  CircleDashed,
  Loader2,
  MessageSquareText,
  TerminalSquare,
  Trash2,
  X,
  XCircle,
  Zap,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { GatewayApi } from "../api";
import { CopyButton } from "../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Kbd,
  Select,
  Spinner,
  Textarea,
} from "../components/ui";
import { formatNumber, toFiniteNumber, usageTotal } from "../lib/format";
import { modelEfforts, modelSupportsReasoning } from "../lib/models";
import { cn } from "../lib/utils";
import type { DashboardData, GatewayModel, Usage } from "../types";

type PlaygroundState = "idle" | "streaming" | "success" | "error";

const examplePrompts = [
  "用一句话介绍当前 Gateway 的能力。",
  "解释当前模型的路由逻辑。",
  "给我一个健康检查 curl 示例。",
];

export function PlaygroundPage({
  data,
  api,
  onRefresh,
}: {
  data: DashboardData;
  api: GatewayApi;
  onRefresh: () => void;
}) {
  const [modelId, setModelId] = useState(data.models[0]?.id ?? "");
  const [effort, setEffort] = useState("off");
  const [prompt, setPrompt] = useState("请用一句话介绍当前 Gateway 的能力。");
  const [content, setContent] = useState("");
  const [reasoning, setReasoning] = useState("");
  const [usage, setUsage] = useState<Usage | undefined>();
  const [state, setState] = useState<PlaygroundState>("idle");
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const model = data.models.find((item) => item.id === modelId) ?? data.models[0];

  useEffect(() => {
    if (!modelId && data.models[0]) setModelId(data.models[0].id);
    if (model && !modelSupportsReasoning(model)) setEffort("off");
  }, [data.models, model, modelId]);

  const clearOutput = (): void => {
    abortRef.current?.abort();
    setState("idle");
    setContent("");
    setReasoning("");
    setUsage(undefined);
    setError("");
  };

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
      await api.streamChat(
        model,
        prompt.trim(),
        effort,
        (update) => {
          if (update.content) setContent((current) => current + update.content);
          if (update.reasoning) setReasoning((current) => current + update.reasoning);
          if (update.usage) setUsage(update.usage);
        },
        controller.signal,
      );
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

  return (
    <div className="grid gap-6 xl:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]">
      <PlaygroundForm
        models={data.models}
        model={model}
        modelId={modelId}
        effort={effort}
        prompt={prompt}
        state={state}
        onModelChange={setModelId}
        onEffortChange={setEffort}
        onPromptChange={setPrompt}
        onSubmit={submit}
        onStop={() => abortRef.current?.abort()}
      />
      <ResponsePreview
        model={model}
        effort={effort}
        state={state}
        error={error}
        reasoning={reasoning}
        content={content}
        usage={usage}
        onClear={clearOutput}
      />
    </div>
  );
}

function PlaygroundForm({
  models,
  model,
  modelId,
  effort,
  prompt,
  state,
  onModelChange,
  onEffortChange,
  onPromptChange,
  onSubmit,
  onStop,
}: {
  models: GatewayModel[];
  model?: GatewayModel;
  modelId: string;
  effort: string;
  prompt: string;
  state: PlaygroundState;
  onModelChange: (value: string) => void;
  onEffortChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
}) {
  const efforts = modelEfforts(model);
  return (
    <Card className="h-fit">
      <CardHeader>
        <div className="flex items-center gap-2">
          <MessageSquareText className="size-4 text-primary" />
          <CardTitle>请求配置</CardTitle>
        </div>
        <CardDescription>使用与 OpenAI Chat Completions 兼容的请求格式</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="space-y-5" onSubmit={onSubmit}>
          <div className="space-y-2">
            <label htmlFor="playground-model" className="text-xs font-medium text-foreground">
              模型
            </label>
            <Select
              id="playground-model"
              value={model?.id ?? modelId}
              onChange={(event) => onModelChange(event.target.value)}
              disabled={!models.length}
            >
              <option value="">{models.length ? "选择模型" : "暂无模型"}</option>
              {models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name || item.id}
                </option>
              ))}
            </Select>
            {model && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <span className="font-mono">{model.id}</span>
                {model.provider && <Badge variant="muted">{model.provider}</Badge>}
              </div>
            )}
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="playground-effort" className="text-xs font-medium text-foreground">
                思考强度
              </label>
              {modelSupportsReasoning(model) ? (
                <Badge variant="info">模型支持</Badge>
              ) : (
                <span className="text-[11px] text-muted-foreground">模型未声明</span>
              )}
            </div>
            <Select
              id="playground-effort"
              value={effort}
              onChange={(event) => onEffortChange(event.target.value)}
              disabled={!modelSupportsReasoning(model)}
            >
              <option value="off">关闭思考</option>
              {Object.keys(efforts).map((key) => (
                <option key={key} value={key}>
                  {key}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label htmlFor="playground-prompt" className="text-xs font-medium text-foreground">
                Prompt
              </label>
              <Kbd>⌘ ↵</Kbd>
            </div>
            <Textarea
              id="playground-prompt"
              value={prompt}
              onChange={(event) => onPromptChange(event.target.value)}
              placeholder="输入一条消息..."
              className="min-h-44"
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter")
                  void onSubmit(event as unknown as FormEvent<HTMLFormElement>);
              }}
            />
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-0.5 text-[11px] text-muted-foreground">示例</span>
              {examplePrompts.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => onPromptChange(example)}
                  className={cn(
                    "rounded-full border border-border/70 bg-muted/20 px-2 py-1",
                    "text-[11px] text-muted-foreground transition-colors",
                    "hover:border-primary/30 hover:bg-primary/8 hover:text-foreground",
                  )}
                >
                  {example}
                </button>
              ))}
            </div>
            <div className="flex justify-end text-[11px] text-muted-foreground">
              {prompt.length} 字符
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="submit"
              className="flex-1"
              disabled={!model || !prompt.trim() || state === "streaming"}
            >
              {state === "streaming" ? (
                <>
                  <Spinner className="size-3.5" />
                  生成中
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  发送请求
                </>
              )}
            </Button>
            {state === "streaming" && (
              <Button type="button" variant="outline" onClick={onStop}>
                <X className="size-4" />
                停止
              </Button>
            )}
          </div>
        </form>
      </CardContent>
      <CardFooter className="border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
        <TerminalSquare className="mr-1.5 size-3.5" />
        响应通过本地 Gateway 流式转发
      </CardFooter>
    </Card>
  );
}

function ResponsePreview({
  model,
  effort,
  state,
  error,
  reasoning,
  content,
  usage,
  onClear,
}: {
  model?: GatewayModel;
  effort: string;
  state: PlaygroundState;
  error: string;
  reasoning: string;
  content: string;
  usage?: Usage;
  onClear: () => void;
}) {
  const title = model
    ? `${model.name || model.id} · ${effort === "off" ? "思考关闭" : effort}`
    : "选择模型开始测试";
  return (
    <Card className="min-h-[560px] overflow-hidden">
      <CardHeader className="border-b border-border/60 bg-muted/15">
        <div className="flex items-center justify-between gap-3">
          <div>
            <CardTitle>响应预览</CardTitle>
            <CardDescription>{title}</CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            {(content || reasoning || error) && (
              <>
                {content && <CopyButton value={content} />}
                <Button variant="ghost" size="sm" onClick={onClear} aria-label="清空响应">
                  <Trash2 className="size-3.5" />
                  <span className="hidden sm:inline">清空</span>
                </Button>
              </>
            )}
            {state === "streaming" ? (
              <Badge variant="warning">
                <Loader2 className="size-3 animate-spin" />
                生成中
              </Badge>
            ) : state === "success" ? (
              <Badge variant="success">
                <Check className="size-3" />
                完成
              </Badge>
            ) : state === "error" ? (
              <Badge variant="danger">
                <XCircle className="size-3" />
                失败
              </Badge>
            ) : (
              <Badge variant="muted">待命</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 p-5">
        {error && (
          <div
            className={cn(
              "flex items-start gap-2 rounded-xl border border-red-400/25",
              "bg-red-400/10 p-3 text-sm text-red-200",
            )}
          >
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            {error}
          </div>
        )}
        {reasoning && (
          <div className="rounded-xl border border-violet-400/20 bg-violet-400/5">
            <div
              className={cn(
                "flex items-center gap-2 border-b border-violet-400/15 px-4 py-3",
                "text-xs font-medium text-violet-200",
              )}
            >
              <CircleDashed className="size-3.5" />
              思考过程
            </div>
            <div
              className={cn(
                "max-h-64 overflow-y-auto whitespace-pre-wrap px-4 py-3 font-mono text-xs leading-6",
                "text-violet-100/70 scrollbar-thin",
              )}
            >
              {reasoning}
              {state === "streaming" && (
                <span className="ml-1 inline-block h-3 w-1 animate-pulse bg-violet-300" />
              )}
            </div>
          </div>
        )}
        {content ? (
          <div
            role="log"
            aria-live="polite"
            className="rounded-xl border border-border/70 bg-background/55 p-4"
          >
            <div className="mb-2 flex items-center gap-2 text-xs font-medium text-muted-foreground">
              <Bot className="size-3.5 text-primary" />
              Assistant
            </div>
            <div className="whitespace-pre-wrap text-sm leading-7 text-foreground">
              {content}
              {state === "streaming" && (
                <span className="ml-1 inline-block h-4 w-1 animate-pulse bg-primary" />
              )}
            </div>
          </div>
        ) : !reasoning && state === "idle" ? (
          <div className="flex min-h-80 flex-col items-center justify-center text-center">
            <div className="mb-4 flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <MessageSquareText className="size-6" />
            </div>
            <div className="text-sm font-medium">准备好测试了吗？</div>
            <p className="mt-2 max-w-xs text-xs leading-5 text-muted-foreground">
              选择模型，输入 Prompt，查看真实的流式响应和思考过程。
            </p>
          </div>
        ) : !content && state === "streaming" ? (
          <div className="flex min-h-80 flex-col items-center justify-center text-center text-muted-foreground">
            <Spinner className="mb-3 size-6 text-primary" />
            <div className="text-sm">正在等待模型响应...</div>
          </div>
        ) : null}
        {usage && (
          <div className="flex flex-wrap gap-2 border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
            <Badge variant="muted">输入 {formatNumber(usage.inputTokens)} tokens</Badge>
            <Badge variant="muted">输出 {formatNumber(usage.outputTokens)} tokens</Badge>
            {toFiniteNumber(usage.cachedTokens) > 0 && (
              <Badge variant="success">缓存 {formatNumber(usage.cachedTokens)} tokens</Badge>
            )}
            {toFiniteNumber(usage.reasoningTokens) > 0 && (
              <Badge variant="muted">思考 {formatNumber(usage.reasoningTokens)} tokens</Badge>
            )}
            <Badge variant="info">总计 {formatNumber(usageTotal(usage))}</Badge>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
