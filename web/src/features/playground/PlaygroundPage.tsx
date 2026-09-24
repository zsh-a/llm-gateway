import { ArrowUp, Square } from "lucide-react";
import type { ComponentProps } from "react";
import { type FormEvent, useEffect, useRef, useState } from "react";
import type { GatewayApi } from "../../api";
import { Field, ResourceContent } from "../../components/common";
import { ModelPicker } from "../../components/ModelPicker";
import { Button, Card, Input, Select, Textarea } from "../../components/ui";
import { formatNumber } from "../../lib/format";
import { useModels } from "../../lib/gateway-queries";
import { modelEfforts, modelSupportsReasoning } from "../../lib/models";
import type { DashboardData, Navigate } from "../../types";
import { ResponsePreview } from "./ResponsePreview";
import type { PlaygroundRequest as Request, PlaygroundResponse as Response } from "./types";

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
  onStreamingChange,
}: {
  data: Pick<DashboardData, "models"> & { resources: Pick<DashboardData["resources"], "models"> };
  api: GatewayApi;
  initialModelId?: string;
  onNavigate: Navigate;
  onRefresh: () => void;
  serviceAvailable?: boolean;
  active?: boolean;
  onStreamingChange?: (streaming: boolean) => void;
}) {
  const [modelId, setModelId] = useState(initialModelId ?? data.models[0]?.id ?? "");
  const [effort, setEffort] = useState("auto");
  const [prompt, setPrompt] = useState("");
  const [maxOutputTokens, setMaxOutputTokens] = useState("");
  const [response, setResponse] = useState<Response>(emptyResponse);
  const abortRef = useRef<AbortController | null>(null);
  const model = data.models.find((item) => item.id === modelId);
  const streaming = response.state === "streaming";
  const budget = maxOutputTokens.trim() ? Number(maxOutputTokens) : undefined;
  const budgetError =
    budget !== undefined && (!Number.isSafeInteger(budget) || budget <= 0)
      ? "请输入大于 0 的整数，或留空使用上游默认值"
      : "";
  useEffect(() => {
    onStreamingChange?.(streaming);
  }, [streaming, onStreamingChange]);
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
    const startedAt = Date.now();
    setResponse({ ...emptyResponse, state: "streaming", request, startedAt });
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
            requestId: update.requestId ?? current.requestId,
            finishReason: update.finishReason ?? current.finishReason,
            firstTokenMs:
              current.firstTokenMs ??
              (update.content || update.reasoning ? Date.now() - startedAt : undefined),
          }));
        },
        controller.signal,
        request.maxOutputTokens,
      );
      if (!controller.signal.aborted && abortRef.current === controller)
        setResponse((current) => ({
          ...current,
          state: ["length", "content_filter"].includes(current.finishReason ?? "")
            ? "incomplete"
            : "success",
          durationMs: Date.now() - startedAt,
        }));
    } catch (error) {
      if (!controller.signal.aborted && abortRef.current === controller)
        setResponse((current) => ({
          ...current,
          state: "error",
          error: error instanceof Error ? error.message : "请求失败，请重试",
          durationMs: Date.now() - startedAt,
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
    setResponse((current) => ({
      ...current,
      state: "canceled",
      durationMs: current.startedAt ? Date.now() - current.startedAt : undefined,
    }));
    onRefresh();
  };
  const clear = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setResponse(emptyResponse);
  };
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (model && prompt.trim() && !streaming && !budgetError)
      void send({ model: { ...model }, prompt: prompt.trim(), effort, maxOutputTokens: budget });
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
            {(data.resources.models.error ||
              (data.resources.models.hasData && !data.models.length)) && (
              <div className="rounded-lg bg-muted/60 p-3 text-sm">
                <p className="mb-2 text-muted-foreground">请检查调用凭证、模型权限和渠道认证。</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onNavigate("settings", { settingsTab: "connection" })}
                >
                  配置调用凭证
                </Button>
              </div>
            )}
            {model && (
              <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span>{model.provider || model.owned_by || "当前模型"}</span>
                <span>
                  上下文{" "}
                  {model.contextWindow ? `${formatNumber(model.contextWindow)} tokens` : "未提供"}
                </span>
                <span>
                  输出上限{" "}
                  {model.max_output_tokens
                    ? `${formatNumber(model.max_output_tokens)} tokens`
                    : "未提供"}
                </span>
              </p>
            )}
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
            <details className="rounded-lg border p-3" open={budgetError ? true : undefined}>
              <summary className="cursor-pointer text-sm font-medium">
                高级参数
                {budget !== undefined && !budgetError ? ` · 输出预算 ${formatNumber(budget)}` : ""}
              </summary>
              <div className="mt-3">
                <Field label="最大输出 Token" htmlFor="playground-max-output" error={budgetError}>
                  <Input
                    id="playground-max-output"
                    type="number"
                    min="1"
                    step="1"
                    value={maxOutputTokens}
                    onChange={(event) => setMaxOutputTokens(event.target.value)}
                    disabled={streaming}
                    placeholder="留空使用上游默认值"
                    aria-invalid={Boolean(budgetError)}
                    aria-describedby={
                      budgetError ? "playground-max-output-error" : "playground-budget-help"
                    }
                  />
                  <p id="playground-budget-help" className="text-xs text-muted-foreground">
                    仅对本次请求设置预算；留空不添加限制。实际可用上限由模型决定。
                  </p>
                </Field>
              </div>
            </details>
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
                  !serviceAvailable ||
                  !model ||
                  !prompt.trim() ||
                  !data.resources.models.hasData ||
                  Boolean(budgetError)
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
        onNavigate={onNavigate}
        onClear={clear}
        onRetry={() => {
          if (response.request) void send(response.request);
        }}
      />
    </div>
  );
}

export function PlaygroundScreen(props: Omit<ComponentProps<typeof PlaygroundPage>, "data">) {
  const models = useModels(
    props.api,
    (props.serviceAvailable ?? true) && (props.active ?? true),
    "available",
  );
  return (
    <PlaygroundPage
      {...props}
      data={{ models: models.data, resources: { models: models.resource } }}
    />
  );
}
