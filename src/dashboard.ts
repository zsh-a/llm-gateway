import { execFile } from "node:child_process";
import { loadConfig } from "./config.js";
import {
  App,
  Button,
  Divider,
  HStack,
  Picker,
  ScrollView,
  SecureField,
  Spacer,
  Text,
  TextField,
  VStack,
  appSetTimer,
  buttonSetBordered,
  buttonSetTextColor,
  pickerAddItem,
  pickerSetSelected,
  scrollviewSetChild,
  setCornerRadius,
  setPadding,
  setText,
  stackSetAlignment,
  showToast,
  textSetColor,
  textSetFontFamily,
  textSetFontSize,
  textSetWraps,
  textfieldSetBackgroundColor,
  textfieldSetBorderless,
  textfieldSetFontSize,
  textfieldSetString,
  textfieldSetTextColor,
  widgetAddChild,
  widgetClearChildren,
  widgetSetBackgroundColor,
  widgetSetBorderColor,
  widgetSetBorderWidth,
  widgetSetHeight,
  widgetSetWidth
} from "perry/ui";
import type { Widget } from "perry/ui";

interface GatewayModel {
  id: string;
  name?: string;
  provider?: string;
  reasoningEfforts?: { [key: string]: string | null };
  defaultReasoningEffort?: string;
  capabilities?: {
    chat?: boolean;
    reasoning?: boolean;
    images?: boolean;
    toolCalling?: boolean;
  };
}

interface ProviderStatus {
  ready?: boolean;
  source?: string | null;
  capturedAt?: number | null;
}

interface GatewayChannel {
  id: string;
  name: string;
  providerId: string;
  authRef: string;
  upstreamUrl?: string;
  enabled?: boolean;
  priority?: number;
  weight?: number;
  modelMappings?: { [key: string]: string };
}

interface ManagedApiKey {
  id: string;
  name: string;
  prefix: string;
  enabled: boolean;
  createdAt?: number;
  lastUsedAt?: number | null;
  allowedModels: string[];
  rpmLimit?: number | null;
  tpmLimit?: number | null;
  quotaTokens?: number | null;
  usedTokens: number;
  remainingTokens?: number | null;
}

type DashboardPage = "overview" | "playground" | "metrics" | "management" | "settings";

interface DashboardPageMeta {
  label: string;
  title: string;
  subtitle: string;
  route: string;
}

interface Color {
  r: number;
  g: number;
  b: number;
  a: number;
}

const config = loadConfig();
const gatewayHost = config.bindHost === "0.0.0.0" || config.bindHost === "::"
  ? "127.0.0.1"
  : config.bindHost;
const gatewayUrl = (process.env.GATEWAY_URL?.trim() ||
  `http://${gatewayHost}:${config.port}`).replace(/\/$/, "");

const colors: { [key: string]: Color } = {
  background: { r: 0.035, g: 0.045, b: 0.075, a: 1 },
  panel: { r: 0.075, g: 0.09, b: 0.14, a: 0.97 },
  panelMuted: { r: 0.055, g: 0.07, b: 0.11, a: 1 },
  border: { r: 0.2, g: 0.23, b: 0.34, a: 0.85 },
  text: { r: 0.95, g: 0.96, b: 0.99, a: 1 },
  muted: { r: 0.58, g: 0.63, b: 0.73, a: 1 },
  subtle: { r: 0.38, g: 0.43, b: 0.54, a: 1 },
  accent: { r: 0.66, g: 0.55, b: 0.98, a: 1 },
  cyan: { r: 0.4, g: 0.9, b: 0.97, a: 1 },
  green: { r: 0.37, g: 0.9, b: 0.66, a: 1 },
  yellow: { r: 0.97, g: 0.82, b: 0.47, a: 1 },
  red: { r: 0.98, g: 0.44, b: 0.53, a: 1 }
};

const layout = {
  windowWidth: 1120,
  windowHeight: 760,
  contentWidth: 1076,
  contentInnerWidth: 1048,
  modelWidth: 330,
  testWidth: 730,
  modelInnerWidth: 302,
  testInnerWidth: 702,
  modelPickerWidth: 420,
  reasoningPickerWidth: 260,
  providerCardWidth: 520,
  adminPanelWidth: 518,
  adminInnerWidth: 488,
  panelHeight: 480
};

let gatewayKey = process.env.PROXY_API_KEY?.trim() || "";
let adminKey = process.env.PROXY_ADMIN_KEY?.trim() || gatewayKey;
let promptValue = "请用一句话介绍你自己。";
let models: GatewayModel[] = [];
let channels: GatewayChannel[] = [];
let managedKeys: ManagedApiKey[] = [];
let modelSearch = "";
let selectedModelIndex = 0;
let selectedReasoningEffort = "";
let modelSelectionTimerPending = false;
let pendingModelIndex: number | null = null;
let metricsRefreshTimerPending = false;
let navigationTimerPending = false;
let pendingPage: DashboardPage | null = null;
let activePage: DashboardPage = "overview";

let channelIdValue = "";
let channelNameValue = "";
let channelProviderValue = "mimo";
let channelAuthRefValue = "mimo";
let channelUrlValue = "";
let channelPriorityValue = "100";
let channelWeightValue = "1";
let channelMappingsValue = "";
let keyNameValue = "";
let keyModelsValue = "";
let keyRpmValue = "";
let keyTpmValue = "";
let keyQuotaValue = "";

let modelRows: Widget;
let modelPickerHost: Widget;
let reasoningPickerHost: Widget;
let providerRows: Widget;
let modelPicker: Widget | null = null;
let reasoningPicker: Widget | null = null;
let globalStatus: Widget;
let overviewStatus: Widget;
let responseStatus: Widget;
let metricsRows: Widget;
let metricsStatus: Widget;
let channelRows: Widget;
let managedKeyRows: Widget;
let adminStatus: Widget;
let navRows: Widget;
let pageHost: Widget;
let pageTitle: Widget;
let pageSubtitle: Widget;
let pageRoute: Widget;
let pageViews: { [key: string]: Widget } = {};

const pageOrder: DashboardPage[] = [
  "overview",
  "playground",
  "metrics",
  "management",
  "settings"
];

const pageMeta: { [key: string]: DashboardPageMeta } = {
  overview: {
    label: "概览",
    title: "网关概览",
    subtitle: "查看服务状态、Provider 认证和模型目录",
    route: "GET /health · GET /v1/models"
  },
  playground: {
    label: "Playground",
    title: "模型请求工作台",
    subtitle: "选择模型、调整推理强度，并发送一条真实的兼容请求",
    route: "POST /v1/chat/completions"
  },
  metrics: {
    label: "统计",
    title: "流量与用量",
    subtitle: "观察请求、Token、延迟和路由分布",
    route: "GET /metrics/*"
  },
  management: {
    label: "渠道与 Key",
    title: "渠道与访问控制",
    subtitle: "维护上游路由、模型映射和客户端访问凭据",
    route: "GET /admin/*"
  },
  settings: {
    label: "设置",
    title: "连接设置",
    subtitle: "配置调用密钥、管理员密钥和认证流程",
    route: "LOCAL CONFIG"
  }
};

function asRecord(value: unknown): { [key: string]: unknown } {
  return value !== null && typeof value === "object"
    ? value as { [key: string]: unknown }
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerName(id: string): string {
  if (id === "mimo") return "MiMo";
  if (id === "workbuddy") return "WorkBuddy";
  return id;
}

function formatTime(value: unknown): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "尚未认证";
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit"
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function numberValue(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function formatCount(value: unknown): string {
  const number = numberValue(value);
  if (number === null) return "—";
  if (number >= 1000000) return `${(number / 1000000).toFixed(2)}M`;
  if (number >= 1000) return `${(number / 1000).toFixed(1)}K`;
  return String(Math.round(number));
}

function formatPercent(value: unknown): string {
  const number = numberValue(value);
  return number === null ? "—" : `${number.toFixed(number % 1 === 0 ? 0 : 1)}%`;
}

function formatDuration(value: unknown): string {
  const number = numberValue(value);
  if (number === null) return "—";
  if (number >= 1000) return `${(number / 1000).toFixed(1)}s`;
  return `${Math.round(number)}ms`;
}

function usageNumber(value: unknown, ...fallbacks: unknown[]): number | null {
  const values = [value, ...fallbacks];
  for (const item of values) {
    const number = numberValue(item);
    if (number !== null) return number;
  }
  return null;
}

function responseUsage(value: unknown): void {
  const usage = asRecord(value);
  const inputDetails = asRecord(
    usage.prompt_tokens_details ?? usage.input_tokens_details
  );
  const outputDetails = asRecord(
    usage.completion_tokens_details ?? usage.output_tokens_details
  );
  setText(
    "response-input-tokens",
    formatCount(usageNumber(usage.input_tokens, usage.prompt_tokens, usage.inputTokens))
  );
  setText(
    "response-output-tokens",
    formatCount(usageNumber(usage.output_tokens, usage.completion_tokens, usage.outputTokens))
  );
  setText(
    "response-reasoning-tokens",
    formatCount(usageNumber(
      usage.reasoning_tokens,
      usage.reasoningTokens,
      outputDetails.reasoning_tokens
    ))
  );
  setText(
    "response-total-tokens",
    formatCount(usageNumber(usage.total_tokens, usage.totalTokens))
  );
  setText(
    "response-cached-tokens",
    formatCount(usageNumber(
      usage.cached_tokens,
      usage.cachedTokens,
      inputDetails.cached_tokens
    ))
  );
  const hasUsage = Object.keys(usage).length > 0;
  setText("response-usage-note", hasUsage ? "上游已报告 usage" : "本次响应未提供 usage");
}

function color(widget: Widget, value: Color): void {
  textSetColor(widget, value.r, value.g, value.b, value.a);
}

function fill(widget: Widget, value: Color): void {
  widgetSetBackgroundColor(widget, value.r, value.g, value.b, value.a);
}

function border(widget: Widget, value: Color): void {
  widgetSetBorderColor(widget, value.r, value.g, value.b, value.a);
  widgetSetBorderWidth(widget, 1);
}

function label(content: string, size: number, value: Color): Widget {
  const widget = Text(content);
  color(widget, value);
  textSetFontSize(widget, size);
  textSetWraps(widget, 620);
  return widget;
}

function dynamicLabel(
  content: string,
  id: string,
  size: number,
  value: Color,
  maxWidth = 620
): Widget {
  const widget = Text(content, id);
  color(widget, value);
  textSetFontSize(widget, size);
  textSetWraps(widget, maxWidth);
  return widget;
}

function card(widget: Widget, width = 0): Widget {
  fill(widget, colors.panel);
  border(widget, colors.border);
  setCornerRadius(widget, 13);
  setPadding(widget, 14, 14, 14, 14);
  stackSetAlignment(widget, 5);
  if (width > 0) widgetSetWidth(widget, width);
  return widget;
}

function surface(widget: Widget, width = 0, height = 0): Widget {
  fill(widget, colors.panelMuted);
  setCornerRadius(widget, 10);
  setPadding(widget, 10, 11, 10, 11);
  stackSetAlignment(widget, 5);
  if (width > 0) widgetSetWidth(widget, width);
  if (height > 0) widgetSetHeight(widget, height);
  return widget;
}

function button(
  title: string,
  onPress: () => void,
  value = colors.text,
  width = 0
): Widget {
  const widget = Button(title, onPress);
  buttonSetBordered(widget, 0);
  buttonSetTextColor(widget, value.r, value.g, value.b, value.a);
  setPadding(widget, 9, 13, 9, 13);
  if (width > 0) widgetSetWidth(widget, width);
  return widget;
}

function primaryButton(title: string, onPress: () => void, width = 0): Widget {
  const widget = button(title, onPress, colors.background, width);
  fill(widget, colors.accent);
  setCornerRadius(widget, 9);
  return widget;
}

function compactMetric(title: string, valueId: string, value = colors.text): Widget {
  const widget = VStack(2, [
    label(title, 9, colors.muted),
    dynamicLabel("—", valueId, 13, value, 82)
  ]);
  stackSetAlignment(widget, 5);
  widgetSetWidth(widget, 82);
  return widget;
}

function styleInput(widget: Widget, width: number): void {
  widgetSetWidth(widget, width);
  textfieldSetBackgroundColor(widget, colors.panelMuted.r, colors.panelMuted.g, colors.panelMuted.b, 1);
  textfieldSetBorderless(widget, 0);
  textfieldSetFontSize(widget, 12);
  textfieldSetTextColor(widget, colors.text.r, colors.text.g, colors.text.b, 1);
  setPadding(widget, 8, 10, 8, 10);
  widgetSetHeight(widget, 34);
}

function effortMap(value: unknown): { [key: string]: string | null } | undefined {
  const record = asRecord(value);
  const result: { [key: string]: string | null } = {};
  for (const key of Object.keys(record)) {
    const item = record[key];
    if (item === null || typeof item === "string") result[key] = item;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function effortLabel(value: string): string {
  const labels: { [key: string]: string } = {
    off: "关闭",
    none: "关闭",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "超高",
    max: "最大"
  };
  return labels[value] || value;
}

function modelFrom(value: unknown): GatewayModel | null {
  const record = asRecord(value);
  const id = stringValue(record.id);
  if (!id) return null;
  const capabilities = asRecord(record.capabilities);
  const reasoningEfforts = effortMap(
    record.reasoningEfforts ?? record.reasoning_efforts ?? capabilities.reasoningEfforts
  );
  return {
    id,
    name: stringValue(record.name) || undefined,
    provider: stringValue(record.provider) || undefined,
    reasoningEfforts,
    defaultReasoningEffort: stringValue(record.defaultReasoningEffort) || undefined,
    capabilities: {
      chat: capabilities.chat !== false,
      reasoning: capabilities.reasoning === true || record.reasoning === true,
      images: capabilities.images === true,
      toolCalling: capabilities.toolCalling === true
    }
  };
}

function modelsFrom(value: unknown): GatewayModel[] {
  const data = asRecord(value).data;
  if (!Array.isArray(data)) return [];
  const result: GatewayModel[] = [];
  for (const item of data) {
    const model = modelFrom(item);
    if (model) result.push(model);
  }
  return result;
}

function channelsFrom(value: unknown): GatewayChannel[] {
  const data = asRecord(value).data;
  if (!Array.isArray(data)) return [];
  const result: GatewayChannel[] = [];
  for (const item of data) {
    const record = asRecord(item);
    const id = stringValue(record.id);
    const providerId = stringValue(record.providerId);
    const authRef = stringValue(record.authRef);
    if (!id || !providerId || !authRef) continue;
    const mappings = asRecord(record.modelMappings);
    const modelMappings: { [key: string]: string } = {};
    for (const key of Object.keys(mappings)) {
      const model = stringValue(mappings[key]);
      if (model) modelMappings[key] = model;
    }
    result.push({
      id,
      name: stringValue(record.name) || id,
      providerId,
      authRef,
      upstreamUrl: stringValue(record.upstreamUrl) || undefined,
      enabled: record.enabled !== false,
      priority: numberValue(record.priority) ?? 100,
      weight: numberValue(record.weight) ?? 1,
      modelMappings: Object.keys(modelMappings).length > 0 ? modelMappings : undefined
    });
  }
  return result;
}

function managedKeysFrom(value: unknown): ManagedApiKey[] {
  const data = asRecord(value).data;
  if (!Array.isArray(data)) return [];
  const result: ManagedApiKey[] = [];
  for (const item of data) {
    const record = asRecord(item);
    const id = stringValue(record.id);
    if (!id) continue;
    const allowedModels = Array.isArray(record.allowedModels)
      ? record.allowedModels.map(stringValue).filter(Boolean)
      : [];
    result.push({
      id,
      name: stringValue(record.name) || id,
      prefix: stringValue(record.prefix) || "sk-gw-…",
      enabled: record.enabled !== false,
      createdAt: numberValue(record.createdAt) ?? undefined,
      lastUsedAt: numberValue(record.lastUsedAt),
      allowedModels,
      rpmLimit: numberValue(record.rpmLimit),
      tpmLimit: numberValue(record.tpmLimit),
      quotaTokens: numberValue(record.quotaTokens),
      usedTokens: numberValue(record.usedTokens) ?? 0,
      remainingTokens: numberValue(record.remainingTokens)
    });
  }
  return result;
}

interface CommandResponse {
  status: number;
  body: string;
}

function requestText(
  path: string,
  method = "GET",
  body = "",
  key = gatewayKey
): Promise<CommandResponse> {
  const args = [
    "--silent",
    "--show-error",
    "--request", method,
    "--connect-timeout", "5",
    "--max-time", "120",
    "--header", "Accept: application/json"
  ];
  if (key) args.push("--header", `Authorization: Bearer ${key}`);
  if (body) {
    args.push("--header", "Content-Type: application/json", "--data-raw", body);
  }
  args.push(
    "--write-out",
    "\n__LLM_GATEWAY_STATUS__:%{http_code}",
    gatewayUrl + path
  );

  return new Promise<CommandResponse>((resolve, reject) => {
    execFile(
      "curl",
      args,
      { maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }

        const marker = "\n__LLM_GATEWAY_STATUS__:";
        const markerIndex = stdout.lastIndexOf(marker);
        if (markerIndex < 0) {
          reject(new Error("网关响应格式无效"));
          return;
        }

        const status = Number(stdout.slice(markerIndex + marker.length).trim());
        if (!Number.isFinite(status)) {
          reject(new Error("网关状态码无效"));
          return;
        }
        resolve({ status, body: stdout.slice(0, markerIndex) });
      }
    );
  });
}

async function requestJson(
  path: string,
  method = "GET",
  body = "",
  key = gatewayKey
): Promise<unknown> {
  const response = await requestText(path, method, body, key);
  const raw = response.body;
  let value: unknown = {};
  try {
    value = JSON.parse(raw);
  } catch {
    value = {};
  }

  if (response.status < 200 || response.status >= 300) {
    const error = asRecord(asRecord(value).error);
    throw new Error(
      stringValue(error.message) || `网关请求失败（HTTP ${response.status}）`
    );
  }
  return value;
}

function setGlobalState(text: string, value: Color): void {
  setText("global-status", `● ${text}`);
  setText("overview-status", `● ${text}`);
  color(globalStatus, value);
  color(overviewStatus, value);
}

function setResponseState(text: string, value: Color): void {
  setText("response-status", text);
  color(responseStatus, value);
}

function renderModels(): void {
  widgetClearChildren(modelRows);
  const query = modelSearch.toLowerCase();
  let visible = 0;

  models.forEach((model, index) => {
    const searchable = `${model.id} ${model.name || ""} ${model.provider || ""}`.toLowerCase();
    if (query && !searchable.includes(query)) return;
    visible += 1;

    const title = model.name && model.name !== model.id
      ? model.name
      : model.id;
    const subtitle = `${providerName(model.provider || "unknown")}  ·  ${
      model.capabilities?.chat === false
        ? "非 Chat 模型"
        : model.capabilities?.reasoning
          ? "Reasoning"
          : "Chat"
    }  ·  ${model.id}`;
    const row = button(
      `${title}\n${subtitle}`,
      () => selectModel(index),
      index === selectedModelIndex ? colors.accent : colors.muted,
      layout.modelInnerWidth
    );
    fill(row, index === selectedModelIndex ? colors.accent : colors.background);
    buttonSetTextColor(
      row,
      index === selectedModelIndex ? colors.background.r : colors.text.r,
      index === selectedModelIndex ? colors.background.g : colors.text.g,
      index === selectedModelIndex ? colors.background.b : colors.text.b,
      1
    );
    setCornerRadius(row, 9);
    widgetSetHeight(row, 48);
    widgetAddChild(modelRows, row);
  });

  if (visible === 0) {
    const message = stateText();
    widgetAddChild(modelRows, label(message, 12, colors.subtle));
  }
  setText("model-count", String(models.length));
  setText(
    "selected-model",
    models[selectedModelIndex]?.id || "选择一个模型"
  );
  renderPicker();
  renderReasoningPicker();
}

function stateText(): string {
  if (models.length === 0) return "暂无模型 · 请先完成 Provider 认证";
  return "没有匹配的模型。";
}

function renderPicker(): void {
  widgetClearChildren(modelPickerHost);
  modelPicker = Picker((index) => queueModelSelection(index));
  for (const model of models) {
    pickerAddItem(modelPicker, `${model.name || model.id} · ${providerName(model.provider || "unknown")}`);
  }
  if (models.length > 0) pickerSetSelected(modelPicker, selectedModelIndex);
  widgetSetWidth(modelPicker, layout.modelPickerWidth);
  widgetAddChild(modelPickerHost, modelPicker);
}

function queueModelSelection(index: number): void {
  if (index < 0 || index >= models.length || index === selectedModelIndex) return;
  pendingModelIndex = index;
  if (modelSelectionTimerPending) return;
  modelSelectionTimerPending = true;
  // Perry's macOS Picker callback temporarily borrows its callback registry.
  // Rebuilding the widget tree inside that callback would borrow it again.
  appSetTimer(1, () => {
    modelSelectionTimerPending = false;
    const nextIndex = pendingModelIndex;
    pendingModelIndex = null;
    if (nextIndex !== null) selectModel(nextIndex);
  });
}

function renderReasoningPicker(): void {
  widgetClearChildren(reasoningPickerHost);
  reasoningPicker = null;
  const model = models[selectedModelIndex];
  const efforts = model?.reasoningEfforts;
  if (!model || !efforts) {
    selectedReasoningEffort = "";
    widgetAddChild(reasoningPickerHost, label("模型默认", 11, colors.subtle));
    setText("selected-effort", "默认");
    return;
  }

  const keys = Object.keys(efforts);
  if (keys.length === 0) {
    selectedReasoningEffort = "";
    widgetAddChild(reasoningPickerHost, label("模型默认", 11, colors.subtle));
    setText("selected-effort", "默认");
    return;
  }

  if (!keys.includes(selectedReasoningEffort)) {
    selectedReasoningEffort = model.defaultReasoningEffort &&
      keys.includes(model.defaultReasoningEffort)
      ? model.defaultReasoningEffort
      : keys[0];
  }
  reasoningPicker = Picker((index) => {
    const key = keys[index];
    if (!key) return;
    selectedReasoningEffort = key;
    setText("selected-effort", effortLabel(key));
  });
  for (const key of keys) pickerAddItem(reasoningPicker, effortLabel(key));
  pickerSetSelected(reasoningPicker, keys.indexOf(selectedReasoningEffort));
  widgetSetWidth(reasoningPicker, layout.reasoningPickerWidth);
  widgetAddChild(reasoningPickerHost, reasoningPicker);
  setText("selected-effort", effortLabel(selectedReasoningEffort));
}

function selectModel(index: number): void {
  if (index < 0 || index >= models.length) return;
  if (index === selectedModelIndex) return;
  selectedModelIndex = index;
  selectedReasoningEffort = "";
  renderModels();
}

function renderProviders(statusValue: unknown): void {
  const providers = asRecord(asRecord(statusValue).providers);
  const ids = Object.keys(providers);
  widgetClearChildren(providerRows);

  for (let index = 0; index < ids.length; index += 2) {
    const providerLine = HStack(8, []);
    for (const id of ids.slice(index, index + 2)) {
      const status = asRecord(providers[id]) as ProviderStatus;
      const ready = status.ready === true;
      const statusColor = ready ? colors.green : colors.yellow;
      const providerRow = HStack(8, [
        VStack(2, [
          label(providerName(id), 12, colors.text),
          label(id, 10, colors.subtle)
        ]),
        Spacer(),
        label(ready ? `已认证 · ${formatTime(status.capturedAt)}` : "待认证", 10, statusColor)
      ]);
      surface(providerRow, layout.providerCardWidth, 44);
      stackSetAlignment(providerRow, 12);
      widgetAddChild(providerLine, providerRow);
    }
    if (ids.length - index === 1) widgetAddChild(providerLine, Spacer());
    widgetAddChild(providerRows, providerLine);
  }

  if (ids.length === 0) {
    widgetAddChild(providerRows, label("暂时无法读取 Provider 状态。", 11, colors.subtle));
  }
  setText("metric-providers", String(ids.length || "—"));
}

function renderRecentMetrics(value: unknown): void {
  widgetClearChildren(metricsRows);
  const data = asRecord(value).data;
  if (!Array.isArray(data) || data.length === 0) {
    widgetAddChild(metricsRows, label("暂无请求记录", 11, colors.subtle));
    return;
  }

  for (const item of data) {
    const record = asRecord(item);
    const usage = asRecord(record.usage);
    const status = stringValue(record.status);
    const statusColor = status === "success"
      ? colors.green
      : status === "canceled"
        ? colors.yellow
        : colors.red;
    const statusText = status === "success"
      ? "成功"
      : status === "canceled"
        ? "取消"
        : "失败";
    const model = stringValue(record.model) || "unknown";
    const provider = providerName(stringValue(record.provider) || "unknown");
    const startedAt = numberValue(record.startedAt);
    const time = startedAt === null
      ? "—"
      : new Date(startedAt).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
      });
    const tokens = usageNumber(usage.totalTokens, usage.total_tokens);
    const row = HStack(8, [
      VStack(2, [
        label(`${provider} · ${model}`, 11, colors.text),
        label(`${time}  ·  ${stringValue(record.protocol) || "—"}`, 9, colors.subtle)
      ]),
      Spacer(),
      VStack(2, [
        label(`${formatCount(tokens)} token`, 10, colors.cyan),
        label(`${formatDuration(record.durationMs)}  ·  ${statusText}`, 9, statusColor)
      ])
    ]);
    stackSetAlignment(row, 12);
    surface(row, layout.contentInnerWidth, 44);
    widgetAddChild(metricsRows, row);
  }
}

function limitText(value: unknown, suffix = ""): string {
  const number = numberValue(value);
  return number === null ? "不限" : `${formatCount(number)}${suffix}`;
}

function parseNonNegativeInput(value: string, fallback: number): number | null {
  const parsed = Number(value.trim());
  if (!Number.isInteger(parsed) || parsed < 0) return fallback >= 0 ? fallback : null;
  return parsed;
}

function parsePositiveInput(value: string): number | undefined {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseMappings(value: string): { [key: string]: string } | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("模型映射必须是合法 JSON 对象");
  }
  const record = asRecord(parsed);
  const mappings: { [key: string]: string } = {};
  for (const key of Object.keys(record)) {
    const model = stringValue(record[key]);
    if (key.trim() && model) mappings[key.trim()] = model;
  }
  if (Object.keys(mappings).length === 0) {
    throw new Error("模型映射必须包含至少一个有效键值");
  }
  return mappings;
}

function renderChannels(): void {
  widgetClearChildren(channelRows);
  if (channels.length === 0) {
    widgetAddChild(channelRows, label("暂无渠道配置", 11, colors.subtle));
    return;
  }

  for (const channel of channels) {
    const enabled = channel.enabled !== false;
    const mappingCount = channel.modelMappings
      ? Object.keys(channel.modelMappings).length
      : 0;
    const endpoint = channel.upstreamUrl ? "自定义上游" : "Provider 默认上游";
    const info = VStack(2, [
      label(`${channel.name} · ${providerName(channel.providerId)}`, 11, colors.text),
      label(
        `${channel.id}  ·  ${channel.authRef}  ·  P${channel.priority ?? 100} / W${channel.weight ?? 1}  ·  ${endpoint}${mappingCount > 0 ? `  ·  ${mappingCount} 个映射` : ""}`,
        9,
        colors.subtle
      )
    ]);
    const actions = HStack(4, [
      button(enabled ? "停用" : "启用", () => { void toggleChannel(channel); }, enabled ? colors.yellow : colors.green, 48),
      button("删除", () => { void removeChannel(channel); }, colors.red, 48)
    ]);
    const row = HStack(7, [info, Spacer(), actions]);
    stackSetAlignment(row, 12);
    surface(row, layout.adminInnerWidth, 54);
    widgetAddChild(channelRows, row);
  }
}

function renderManagedKeys(): void {
  widgetClearChildren(managedKeyRows);
  if (managedKeys.length === 0) {
    widgetAddChild(managedKeyRows, label("暂无虚拟 Key", 11, colors.subtle));
    return;
  }

  for (const key of managedKeys) {
    const status = key.enabled ? "启用" : "已撤销";
    const statusColor = key.enabled ? colors.green : colors.red;
    const quota = key.quotaTokens === null || key.quotaTokens === undefined
      ? "配额不限"
      : `剩余 ${formatCount(key.remainingTokens)} / ${formatCount(key.quotaTokens)}`;
    const limits = `${limitText(key.rpmLimit, " RPM")}  ·  ${limitText(key.tpmLimit, " TPM")}`;
    const info = VStack(2, [
      label(`${key.name}  ·  ${key.prefix}…`, 11, colors.text),
      label(`${quota}  ·  ${limits}  ·  已用 ${formatCount(key.usedTokens)} token`, 9, colors.subtle)
    ]);
    const action = key.enabled
      ? button("撤销", () => { void revokeManagedKey(key); }, colors.red, 48)
      : label(status, 10, statusColor);
    const row = HStack(7, [info, Spacer(), action]);
    stackSetAlignment(row, 12);
    surface(row, layout.adminInnerWidth, 54);
    widgetAddChild(managedKeyRows, row);
  }
}

async function loadAdmin(): Promise<void> {
  try {
    const values = await Promise.all([
      requestJson("/admin/channels", "GET", "", adminKey),
      requestJson("/admin/keys", "GET", "", adminKey)
    ]);
    channels = channelsFrom(values[0]);
    managedKeys = managedKeysFrom(values[1]);
    renderChannels();
    renderManagedKeys();
    setText("admin-status", "管理已连接");
    color(adminStatus, colors.green);
  } catch (error) {
    setText("admin-status", adminKey ? "管理员 Key 无效" : "只读模式");
    color(adminStatus, colors.yellow);
    if (!adminKey) {
      channels = [];
      managedKeys = [];
      renderChannels();
      renderManagedKeys();
    }
  }
}

async function saveChannel(): Promise<void> {
  const id = channelIdValue.trim();
  const providerId = channelProviderValue.trim();
  const authRef = channelAuthRefValue.trim();
  if (!id || !providerId || !authRef) {
    showToast("渠道 ID、Provider ID、认证引用不能为空");
    return;
  }

  let modelMappings: { [key: string]: string } | undefined;
  try {
    modelMappings = parseMappings(channelMappingsValue);
  } catch (error) {
    showToast(errorMessage(error));
    return;
  }

  const priority = parseNonNegativeInput(channelPriorityValue, 100);
  const weight = parsePositiveInput(channelWeightValue) ?? 1;
  const body: { [key: string]: unknown } = {
    id,
    name: channelNameValue.trim() || id,
    providerId,
    authRef,
    enabled: true,
    priority,
    weight
  };
  if (channelUrlValue.trim()) body.upstreamUrl = channelUrlValue.trim();
  if (modelMappings) body.modelMappings = modelMappings;

  try {
    await requestJson("/admin/channels", "POST", JSON.stringify(body), adminKey);
    showToast("渠道已保存，模型目录将自动刷新");
    await loadDashboard();
  } catch (error) {
    showToast(`保存渠道失败：${errorMessage(error)}`);
  }
}

async function toggleChannel(channel: GatewayChannel): Promise<void> {
  const body = {
    ...channel,
    enabled: channel.enabled === false
  };
  try {
    await requestJson("/admin/channels", "POST", JSON.stringify(body), adminKey);
    showToast(body.enabled ? "渠道已启用" : "渠道已停用");
    await loadDashboard();
  } catch (error) {
    showToast(`更新渠道失败：${errorMessage(error)}`);
  }
}

async function removeChannel(channel: GatewayChannel): Promise<void> {
  try {
    await requestJson(`/admin/channels/${encodeURIComponent(channel.id)}`, "DELETE", "", adminKey);
    showToast(`已删除渠道：${channel.name}`);
    await loadDashboard();
  } catch (error) {
    showToast(`删除渠道失败：${errorMessage(error)}`);
  }
}

async function createManagedKey(): Promise<void> {
  const name = keyNameValue.trim();
  if (!name) {
    showToast("请填写 Key 名称");
    return;
  }
  const allowedModels = keyModelsValue.split(",").map((item) => item.trim()).filter(Boolean);
  const body: { [key: string]: unknown } = { name, allowedModels };
  const rpmLimit = parsePositiveInput(keyRpmValue);
  const tpmLimit = parsePositiveInput(keyTpmValue);
  const quotaTokens = parsePositiveInput(keyQuotaValue);
  if (rpmLimit !== undefined) body.rpmLimit = rpmLimit;
  if (tpmLimit !== undefined) body.tpmLimit = tpmLimit;
  if (quotaTokens !== undefined) body.quotaTokens = quotaTokens;

  try {
    const response = asRecord(await requestJson(
      "/admin/keys",
      "POST",
      JSON.stringify(body),
      adminKey
    ));
    const secret = stringValue(response.secret);
    if (!secret) throw new Error("网关未返回新 Key");
    setText("new-key-secret", secret);
    showToast("虚拟 Key 已创建，请立即复制保存");
    await loadAdmin();
  } catch (error) {
    showToast(`创建 Key 失败：${errorMessage(error)}`);
  }
}

async function revokeManagedKey(key: ManagedApiKey): Promise<void> {
  try {
    await requestJson(`/admin/keys/${encodeURIComponent(key.id)}`, "DELETE", "", adminKey);
    showToast(`已撤销 Key：${key.name}`);
    await loadAdmin();
  } catch (error) {
    showToast(`撤销 Key 失败：${errorMessage(error)}`);
  }
}

function renderMetrics(summaryValue: unknown, requestsValue: unknown): void {
  const summary = asRecord(summaryValue);
  const tokens = asRecord(summary.tokens);
  const latency = asRecord(summary.latency);
  const usageRequests = numberValue(tokens.requestsWithUsage) ?? 0;
  setText("metric-requests", formatCount(summary.requests));
  setText("metric-success", formatPercent(summary.successRate));
  setText(
    "metric-tokens",
    usageRequests > 0 ? formatCount(tokens.totalTokens) : "—"
  );
  setText("metric-p95", formatDuration(latency.p95Ms));
  setText("stats-requests", formatCount(summary.requests));
  setText("stats-success", formatPercent(summary.successRate));
  setText(
    "stats-tokens",
    usageRequests > 0 ? formatCount(tokens.totalTokens) : "—"
  );
  setText("stats-latency", formatDuration(latency.averageMs));
  setText(
    "stats-coverage",
    summary.requests === undefined
      ? "—"
      : `${formatCount(usageRequests)} / ${formatCount(summary.requests)} 有 usage`
  );
  const byModel = Array.isArray(summary.byModel) ? summary.byModel : [];
  const breakdown = byModel.slice(0, 3).map((item) => {
    const group = asRecord(item);
    return `${stringValue(group.key) || "unknown"} ${formatCount(group.requests)} 次`;
  });
  setText(
    "stats-breakdown",
    breakdown.length > 0 ? breakdown.join("  ·  ") : "暂无模型分布"
  );
  const byChannel = Array.isArray(summary.byChannel) ? summary.byChannel : [];
  setText(
    "stats-channel-breakdown",
    byChannel.length > 0
      ? byChannel.slice(0, 3).map((item) => {
        const group = asRecord(item);
        return `${stringValue(group.key) || "unknown"} ${formatCount(group.requests)} 次`;
      }).join("  ·  ")
      : "暂无渠道分布"
  );
  const byApiKey = Array.isArray(summary.byApiKey) ? summary.byApiKey : [];
  setText(
    "stats-key-breakdown",
    byApiKey.length > 0
      ? byApiKey.slice(0, 3).map((item) => {
        const group = asRecord(item);
        return `${stringValue(group.key) || "anonymous"} ${formatCount(group.requests)} 次`;
      }).join("  ·  ")
      : "暂无客户端分布"
  );
  setText("metrics-status", "24h");
  color(metricsStatus, colors.cyan);
  renderRecentMetrics(requestsValue);
}

function renderMetricsError(error: unknown): void {
  setText("metric-requests", "—");
  setText("metric-success", "—");
  setText("metric-tokens", "—");
  setText("metric-p95", "—");
  setText("stats-requests", "—");
  setText("stats-success", "—");
  setText("stats-tokens", "—");
  setText("stats-latency", "—");
  setText("stats-coverage", errorMessage(error));
  setText("stats-breakdown", "暂无模型分布");
  setText("stats-channel-breakdown", "暂无渠道分布");
  setText("stats-key-breakdown", "暂无客户端分布");
  setText("metrics-status", "不可用");
  color(metricsStatus, colors.red);
  widgetClearChildren(metricsRows);
  widgetAddChild(metricsRows, label(`无法读取统计：${errorMessage(error)}`, 11, colors.red));
}

async function loadDashboard(retry = 0): Promise<void> {
  setGlobalState("刷新中…", colors.muted);
  let connected = false;
  try {
    const values = await Promise.all([
      requestJson("/health"),
      requestJson("/health/auth")
    ]);
    const health = asRecord(values[0]);
    const auth = asRecord(values[1]);
    const providers = asRecord(auth.providers);
    const ids = Object.keys(providers);
    const ready = ids.filter((id) => asRecord(providers[id]).ready === true).length;
    setText("metric-auth", ids.length > 0 ? `${ready} / ${ids.length}` : "—");
    renderProviders(auth);
    connected = true;
    setGlobalState(health.status === "ok" ? "在线" : "异常", health.status === "ok" ? colors.green : colors.yellow);
  } catch (error) {
    if (retry < 20) {
      setGlobalState("连接中…", colors.muted);
      appSetTimer(250, () => { void loadDashboard(retry + 1); });
      return;
    }
    setGlobalState("离线", colors.red);
    setText("metric-providers", "—");
    setText("metric-auth", "—");
    widgetClearChildren(providerRows);
    widgetAddChild(providerRows, label(`无法连接网关：${errorMessage(error)}`, 12, colors.red));
  }

  try {
    models = modelsFrom(await requestJson("/v1/models"));
    setText("model-error", "");
  } catch (error) {
    models = [];
    setText("model-error", errorMessage(error));
  }
  if (!connected) return;
  selectedModelIndex = Math.min(selectedModelIndex, Math.max(0, models.length - 1));
  setText("metric-models", String(models.length || "—"));
  renderModels();

  await loadMetrics();
  await loadAdmin();
  scheduleMetricsRefresh();
}

async function loadMetrics(): Promise<void> {
  try {
  const values = await Promise.all([
      requestJson("/metrics/summary?window=24h"),
      requestJson("/metrics/requests?window=24h&limit=3")
    ]);
    renderMetrics(values[0], values[1]);
  } catch (error) {
    renderMetricsError(error);
  }
}

function scheduleMetricsRefresh(): void {
  if (metricsRefreshTimerPending) return;
  metricsRefreshTimerPending = true;
  appSetTimer(10000, () => {
    metricsRefreshTimerPending = false;
    void loadMetrics();
    void loadAdmin();
    scheduleMetricsRefresh();
  });
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    const record = asRecord(item);
    return stringValue(record.text) || stringValue(record.content);
  }).filter(Boolean).join("");
}

async function sendChat(): Promise<void> {
  if (models.length === 0) {
    showToast("暂无可用模型，请先完成认证");
    return;
  }
  const model = models[selectedModelIndex];
  if (!model) return;

  setResponseState("请求中…", colors.muted);
  setText("response-error", "");
  setText("response-reasoning", "");
  setText("response-answer", "");
  responseUsage(null);
  try {
    const body: { [key: string]: unknown } = {
      model: model.id,
      messages: [{ role: "user", content: promptValue }],
      stream: false
    };
    if (selectedReasoningEffort && model.reasoningEfforts) {
      const wireValue = model.reasoningEfforts[selectedReasoningEffort];
      if (wireValue === null) {
        body.thinking = { type: "disabled" };
      } else if (wireValue !== undefined) {
        body.reasoning_effort = wireValue;
        body.thinking = { type: "enabled" };
      }
    }
    const payload = asRecord(await requestJson(
      "/v1/chat/completions",
      "POST",
      JSON.stringify(body)
    ));
    responseUsage(payload.usage);
    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const first = asRecord(choices[0]);
    const message = asRecord(first.message);
    const reasoning = contentText(message.reasoning_content);
    const answer = contentText(message.content);
    setText("response-reasoning", reasoning || "本次响应未返回思考过程");
    setText("response-answer", answer || "上游未返回正文");
    setResponseState("完成", colors.green);
  } catch (error) {
    setText("response-answer", "");
    setText("response-reasoning", "");
    setText("response-error", errorMessage(error));
    setResponseState("失败", colors.red);
  } finally {
    void Promise.all([loadMetrics(), loadAdmin()]);
  }
}

function saveKey(): void {
  setText("key-state", gatewayKey ? "当前运行时已保存" : "未设置 API Key");
  setText("admin-key-state", adminKey ? "已设置" : "未设置");
  showToast(gatewayKey || adminKey ? "访问配置已保存" : "访问配置已清除");
  void loadDashboard();
}

function renderNavigation(): void {
  widgetClearChildren(navRows);
  for (const page of pageOrder) {
    const meta = pageMeta[page];
    const active = page === activePage;
    const width = page === "management" ? 112 : page === "playground" ? 104 : 68;
    const tab = button(meta.label, () => queuePage(page), active ? colors.background : colors.muted, width);
    fill(tab, active ? colors.accent : colors.panelMuted);
    setCornerRadius(tab, 8);
    buttonSetTextColor(
      tab,
      active ? colors.background.r : colors.text.r,
      active ? colors.background.g : colors.text.g,
      active ? colors.background.b : colors.text.b,
      1
    );
    widgetSetHeight(tab, 32);
    widgetAddChild(navRows, tab);
  }
}

function renderPage(): void {
  const meta = pageMeta[activePage];
  setText("page-title", meta.title);
  setText("page-subtitle", meta.subtitle);
  setText("page-route", meta.route);
  widgetClearChildren(pageHost);
  const view = pageViews[activePage];
  if (view) widgetAddChild(pageHost, view);
}

function queuePage(page: DashboardPage): void {
  if (page === activePage && pendingPage === null) return;
  pendingPage = page;
  if (navigationTimerPending) return;
  navigationTimerPending = true;
  appSetTimer(1, () => {
    navigationTimerPending = false;
    const nextPage = pendingPage;
    pendingPage = null;
    if (!nextPage || nextPage === activePage) return;
    activePage = nextPage;
    renderNavigation();
    renderPage();
  });
}

function buildUi(): Widget {
  const brand = VStack(2, [
    label("LLM Gateway", 18, colors.text),
    label("UNIFIED MODEL ACCESS", 9, colors.subtle)
  ]);
  stackSetAlignment(brand, 5);

  const endpoint = label(gatewayUrl + "/v1", 10, colors.cyan);
  textSetFontFamily(endpoint, "SF Mono");
  globalStatus = dynamicLabel("● 检测中", "global-status", 11, colors.muted, 100);
  const refresh = button("刷新", () => { void loadDashboard(); }, colors.cyan, 58);
  const header = HStack(14, [brand, Spacer(), endpoint, globalStatus, refresh]);
  stackSetAlignment(header, 12);
  setPadding(header, 14, 22, 14, 22);
  fill(header, colors.panel);
  widgetSetWidth(header, layout.windowWidth);
  widgetSetHeight(header, 64);

  overviewStatus = dynamicLabel("● 检测中", "overview-status", 12, colors.muted, 120);
  const summaryMetrics = HStack(9, [
    compactMetric("Provider", "metric-providers", colors.text),
    compactMetric("已认证", "metric-auth", colors.green),
    compactMetric("模型", "metric-models", colors.accent),
    compactMetric("24h 请求", "metric-requests", colors.text),
    compactMetric("成功率", "metric-success", colors.green),
    compactMetric("Token", "metric-tokens", colors.cyan),
    compactMetric("P95 延迟", "metric-p95", colors.yellow)
  ]);
  stackSetAlignment(summaryMetrics, 12);
  const summary = VStack(9, [
    HStack(8, [
      VStack(2, [
        label("GATEWAY", 9, colors.cyan),
        label("统一模型入口", 16, colors.text),
        label(gatewayUrl + "/v1", 9, colors.subtle)
      ]),
      Spacer(),
      overviewStatus
    ]),
    Divider(),
    summaryMetrics
  ]);
  stackSetAlignment(summary, 5);
  card(summary, layout.contentWidth);
  widgetSetHeight(summary, 126);

  providerRows = VStack(8, []);
  stackSetAlignment(providerRows, 5);
  widgetSetWidth(providerRows, layout.contentInnerWidth);

  const key = SecureField("PROXY_API_KEY（可选）", (value) => {
    gatewayKey = value.trim();
  });
  styleInput(key, 440);
  if (gatewayKey) textfieldSetString(key, gatewayKey);
  const adminInput = SecureField("PROXY_ADMIN_KEY（可选）", (value) => {
    adminKey = value.trim();
  });
  styleInput(adminInput, 440);
  if (adminKey) textfieldSetString(adminInput, adminKey);
  const access = HStack(10, [
    VStack(3, [
      HStack(6, [
        label("调用 Key", 9, colors.muted),
        dynamicLabel(gatewayKey ? "已设置" : "未设置", "key-state", 9, colors.subtle, 70)
      ]),
      key
    ]),
    VStack(3, [
      HStack(6, [
        label("管理员 Key", 9, colors.muted),
        dynamicLabel(adminKey ? "已设置" : "未设置", "admin-key-state", 9, colors.subtle, 70)
      ]),
      adminInput
    ]),
    Spacer(),
    button("保存设置", saveKey, colors.cyan, 76)
  ]);
  stackSetAlignment(access, 12);

  const providerPanel = VStack(9, [
    HStack(8, [
      VStack(2, [
        label("Provider 状态", 15, colors.text),
        label("已配置的上游认证", 10, colors.subtle)
      ]),
      Spacer(),
      label("/health/auth", 9, colors.subtle)
    ]),
    Divider(),
    providerRows
  ]);
  stackSetAlignment(providerPanel, 5);
  card(providerPanel, layout.contentWidth);
  widgetSetHeight(providerPanel, 168);

  const accessPanel = VStack(8, [
    HStack(8, [
      VStack(2, [
        label("访问凭据", 15, colors.text),
        label("普通调用与管理接口使用不同权限", 10, colors.subtle)
      ]),
      Spacer(),
      label("LOCAL CONFIG", 9, colors.subtle)
    ]),
    access
  ]);
  stackSetAlignment(accessPanel, 5);
  card(accessPanel, layout.contentWidth);
  widgetSetHeight(accessPanel, 118);

  modelRows = VStack(7, []);
  stackSetAlignment(modelRows, 5);
  widgetSetWidth(modelRows, layout.modelInnerWidth);
  const modelScroll = ScrollView();
  scrollviewSetChild(modelScroll, modelRows);
  widgetSetHeight(modelScroll, 338);
  widgetSetWidth(modelScroll, layout.modelInnerWidth);
  const search = TextField("搜索模型名称或 ID", (value) => {
    modelSearch = value.trim();
    renderModels();
  });
  styleInput(search, layout.modelInnerWidth);
  const modelPanel = VStack(10, [
    HStack(8, [
      VStack(2, [
        label("模型目录", 15, colors.text),
        label("点击模型加入请求", 10, colors.subtle)
      ]),
      Spacer(),
      dynamicLabel("—", "model-count", 12, colors.cyan, 48)
    ]),
    search,
    modelScroll,
    dynamicLabel("", "model-error", 10, colors.red, layout.modelInnerWidth)
  ]);
  stackSetAlignment(modelPanel, 5);
  card(modelPanel, layout.modelWidth);
  widgetSetHeight(modelPanel, layout.panelHeight);

  modelPickerHost = VStack(0, []);
  stackSetAlignment(modelPickerHost, 5);
  widgetSetWidth(modelPickerHost, layout.modelPickerWidth);

  reasoningPickerHost = VStack(0, []);
  stackSetAlignment(reasoningPickerHost, 5);
  widgetSetWidth(reasoningPickerHost, layout.reasoningPickerWidth);

  const prompt = TextField("输入一条消息，验证当前网关链路…", (value) => {
    promptValue = value;
  });
  textfieldSetString(prompt, promptValue);
  styleInput(prompt, layout.testInnerWidth);

  responseStatus = dynamicLabel("准备就绪", "response-status", 11, colors.subtle, 76);
  const selectedModel = dynamicLabel("选择一个模型", "selected-model", 10, colors.accent, 190);
  const modelControl = VStack(4, [
    label("目标模型", 9, colors.muted),
    modelPickerHost
  ]);
  const reasoningControl = VStack(4, [
    HStack(6, [
      label("Reasoning effort", 9, colors.muted),
      Spacer(),
      dynamicLabel("默认", "selected-effort", 9, colors.yellow, 60)
    ]),
    reasoningPickerHost
  ]);
  const controls = HStack(10, [modelControl, reasoningControl]);
  stackSetAlignment(controls, 5);
  const reasoning = surface(
    VStack(4, [
      label("THINKING", 9, colors.yellow),
      dynamicLabel("暂无思考内容", "response-reasoning", 10, colors.yellow, 324)
    ]),
    346,
    132
  );
  const answer = surface(
    VStack(4, [
      label("ANSWER", 9, colors.cyan),
      dynamicLabel("选择模型并发送消息，响应会显示在这里。", "response-answer", 12, colors.text, 324)
    ]),
    346,
    132
  );
  const usagePanel = surface(
    VStack(5, [
      HStack(8, [
        label("TOKEN USAGE", 9, colors.cyan),
        Spacer(),
        dynamicLabel("本次响应未提供 usage", "response-usage-note", 9, colors.subtle, 180)
      ]),
      HStack(8, [
        compactMetric("输入", "response-input-tokens", colors.text),
        compactMetric("输出", "response-output-tokens", colors.text),
        compactMetric("思考", "response-reasoning-tokens", colors.yellow),
        compactMetric("总计", "response-total-tokens", colors.cyan)
      ])
    ]),
    layout.testInnerWidth,
    76
  );
  const testPanel = VStack(10, [
    HStack(8, [
      VStack(2, [
        label("请求 Playground", 15, colors.text),
        label("用真实请求验证模型与响应", 10, colors.subtle)
      ]),
      Spacer(),
      VStack(2, [selectedModel, responseStatus])
    ]),
    controls,
    label("MESSAGE", 9, colors.cyan),
    prompt,
    HStack(10, [
      primaryButton("发送请求", () => { void sendChat(); }, 112),
      label("stream: false", 9, colors.subtle)
    ]),
    HStack(10, [reasoning, answer]),
    usagePanel,
    dynamicLabel("", "response-error", 10, colors.red, layout.testInnerWidth)
  ]);
  stackSetAlignment(testPanel, 5);
  card(testPanel, layout.testWidth);
  widgetSetHeight(testPanel, 500);

  metricsRows = VStack(6, []);
  stackSetAlignment(metricsRows, 5);
  widgetSetWidth(metricsRows, layout.contentInnerWidth);
  const metricsScroll = ScrollView();
  scrollviewSetChild(metricsScroll, metricsRows);
  widgetSetWidth(metricsScroll, layout.contentInnerWidth);
  widgetSetHeight(metricsScroll, 116);
  metricsStatus = dynamicLabel("—", "metrics-status", 10, colors.subtle, 72);
  const breakdown = surface(
    VStack(3, [
      HStack(7, [
        label("模型", 9, colors.muted),
        dynamicLabel("暂无模型分布", "stats-breakdown", 9, colors.subtle, layout.contentInnerWidth - 40)
      ]),
      HStack(7, [
        label("渠道", 9, colors.muted),
        dynamicLabel("暂无渠道分布", "stats-channel-breakdown", 9, colors.subtle, layout.contentInnerWidth - 40)
      ]),
      HStack(7, [
        label("客户端", 9, colors.muted),
        dynamicLabel("暂无客户端分布", "stats-key-breakdown", 9, colors.subtle, layout.contentInnerWidth - 40)
      ])
    ]),
    layout.contentInnerWidth,
    72
  );
  const statsPanel = VStack(9, [
    HStack(8, [
      VStack(2, [
        label("流量概览", 15, colors.text),
        label("最近 24 小时 · 不保存请求内容", 10, colors.subtle)
      ]),
      Spacer(),
      metricsStatus
    ]),
    HStack(8, [
      compactMetric("请求", "stats-requests", colors.text),
      compactMetric("成功率", "stats-success", colors.green),
      compactMetric("Token", "stats-tokens", colors.cyan),
      compactMetric("平均延迟", "stats-latency", colors.yellow),
      Spacer()
    ]),
    dynamicLabel("—", "stats-coverage", 9, colors.subtle, layout.contentInnerWidth),
    breakdown,
    HStack(8, [
      label("最近请求", 9, colors.muted),
      Spacer(),
      label("仅保留元数据", 9, colors.subtle)
    ]),
    metricsScroll
  ]);
  stackSetAlignment(statsPanel, 5);
  card(statsPanel, layout.contentWidth);
  widgetSetHeight(statsPanel, 350);

  const adminPanelWidth = layout.adminPanelWidth;
  const adminInnerWidth = layout.adminInnerWidth;
  channelRows = VStack(6, []);
  stackSetAlignment(channelRows, 5);
  widgetSetWidth(channelRows, adminInnerWidth);
  const channelScroll = ScrollView();
  scrollviewSetChild(channelScroll, channelRows);
  widgetSetWidth(channelScroll, adminInnerWidth);
  widgetSetHeight(channelScroll, 156);

  const channelId = TextField("渠道 ID，例如 mimo-secondary", (value) => {
    channelIdValue = value;
  });
  styleInput(channelId, 220);
  const channelProvider = TextField("Provider ID", (value) => {
    channelProviderValue = value;
  });
  styleInput(channelProvider, 110);
  textfieldSetString(channelProvider, channelProviderValue);
  const channelAuth = TextField("认证引用", (value) => {
    channelAuthRefValue = value;
  });
  styleInput(channelAuth, 140);
  textfieldSetString(channelAuth, channelAuthRefValue);
  const channelName = TextField("显示名称（可选）", (value) => {
    channelNameValue = value;
  });
  styleInput(channelName, 210);
  const channelUrl = TextField("自定义上游 URL（可选）", (value) => {
    channelUrlValue = value;
  });
  styleInput(channelUrl, 272);
  const channelPriority = TextField("优先级", (value) => {
    channelPriorityValue = value;
  });
  styleInput(channelPriority, 70);
  textfieldSetString(channelPriority, channelPriorityValue);
  const channelWeight = TextField("权重", (value) => {
    channelWeightValue = value;
  });
  styleInput(channelWeight, 60);
  textfieldSetString(channelWeight, channelWeightValue);
  const channelMappings = TextField('模型映射 JSON，例如 {"别名":"真实 ID"}', (value) => {
    channelMappingsValue = value;
  });
  styleInput(channelMappings, 346);
  const channelAdminPanel = VStack(7, [
    HStack(7, [
      VStack(2, [
        label("渠道路由", 14, colors.text),
        label("Provider、认证与故障转移", 9, colors.subtle)
      ]),
      Spacer(),
      label("CHANNELS", 9, colors.cyan)
    ]),
    Divider(),
    HStack(6, [channelId, channelProvider, channelAuth]),
    HStack(6, [channelName, channelUrl]),
    HStack(6, [channelPriority, channelWeight, channelMappings]),
    HStack(7, [
      primaryButton("保存渠道", () => { void saveChannel(); }, 92),
      label("同 ID 保存即更新", 9, colors.subtle)
    ]),
    label("已配置渠道", 9, colors.muted),
    channelScroll
  ]);
  stackSetAlignment(channelAdminPanel, 5);
  card(channelAdminPanel, adminPanelWidth);
  widgetSetHeight(channelAdminPanel, 456);

  managedKeyRows = VStack(6, []);
  stackSetAlignment(managedKeyRows, 5);
  widgetSetWidth(managedKeyRows, adminInnerWidth);
  const managedKeyScroll = ScrollView();
  scrollviewSetChild(managedKeyScroll, managedKeyRows);
  widgetSetWidth(managedKeyScroll, adminInnerWidth);
  widgetSetHeight(managedKeyScroll, 156);

  const keyName = TextField("Key 名称，例如 cline-local", (value) => {
    keyNameValue = value;
  });
  styleInput(keyName, 210);
  const keyModels = TextField("允许模型（逗号分隔，留空=全部）", (value) => {
    keyModelsValue = value;
  });
  styleInput(keyModels, 272);
  const keyRpm = TextField("RPM", (value) => {
    keyRpmValue = value;
  });
  styleInput(keyRpm, 58);
  const keyTpm = TextField("TPM", (value) => {
    keyTpmValue = value;
  });
  styleInput(keyTpm, 58);
  const keyQuota = TextField("Token 配额", (value) => {
    keyQuotaValue = value;
  });
  styleInput(keyQuota, 90);
  const newKeySecret = surface(
    VStack(3, [
      label("新 Key（只显示一次）", 9, colors.yellow),
      dynamicLabel("创建后在这里复制保存", "new-key-secret", 10, colors.text, adminInnerWidth - 22)
    ]),
    adminInnerWidth,
    64
  );
  const keyAdminPanel = VStack(7, [
    HStack(7, [
      VStack(2, [
        label("虚拟 API Key", 14, colors.text),
        label("按客户端分配权限与额度", 9, colors.subtle)
      ]),
      Spacer(),
      label("ACCESS", 9, colors.accent)
    ]),
    Divider(),
    HStack(6, [keyName, keyModels]),
    HStack(6, [keyRpm, keyTpm, keyQuota, Spacer(), primaryButton("创建 Key", () => { void createManagedKey(); }, 106)]),
    newKeySecret,
    label("已创建 Key", 9, colors.muted),
    managedKeyScroll
  ]);
  stackSetAlignment(keyAdminPanel, 5);
  card(keyAdminPanel, adminPanelWidth);
  widgetSetHeight(keyAdminPanel, 456);

  adminStatus = dynamicLabel("只读模式", "admin-status", 10, colors.subtle, 100);
  const managementPanel = VStack(10, [
    HStack(8, [
      VStack(2, [
        label("管理中心", 15, colors.text),
        label("渠道路由与客户端 Key · 仅管理员可写", 10, colors.subtle)
      ]),
      Spacer(),
      adminStatus
    ]),
    HStack(12, [channelAdminPanel, keyAdminPanel])
  ]);
  stackSetAlignment(managementPanel, 5);
  card(managementPanel, layout.contentWidth);
  widgetSetHeight(managementPanel, 540);

  const playground = HStack(16, [modelPanel, testPanel]);
  stackSetAlignment(playground, 3);
  widgetSetWidth(playground, layout.contentWidth);

  const overviewHint = surface(
    HStack(10, [
      VStack(2, [
        label("快速开始", 12, colors.text),
        label("进入 Playground 选择模型并发送一条测试请求", 10, colors.subtle)
      ]),
      Spacer(),
      button("打开 Playground", () => queuePage("playground"), colors.cyan, 108)
    ]),
    layout.contentInnerWidth,
    60
  );
  stackSetAlignment(overviewHint, 12);

  const settingsInfo = VStack(5, [
    label("认证与运行", 13, colors.text),
    label("首次认证通过 npm run auth 独立完成，认证缓存与网关运行时分离。", 10, colors.subtle),
    label("desktop 模式会托管 Gateway 子进程；serve 模式只运行 HTTP 服务。", 10, colors.subtle),
    label("管理接口未配置 PROXY_ADMIN_KEY 时，仅建议在 127.0.0.1 本机使用。", 10, colors.yellow)
  ]);
  card(settingsInfo, layout.contentWidth);
  widgetSetHeight(settingsInfo, 116);

  const overviewPage = VStack(14, [summary, providerPanel, overviewHint]);
  const playgroundPage = VStack(14, [playground]);
  const metricsPage = VStack(14, [statsPanel]);
  const managementPage = VStack(14, [managementPanel]);
  const settingsPage = VStack(14, [accessPanel, settingsInfo]);
  pageViews = {
    overview: overviewPage,
    playground: playgroundPage,
    metrics: metricsPage,
    management: managementPage,
    settings: settingsPage
  };
  for (const page of Object.keys(pageViews)) {
    widgetSetWidth(pageViews[page], layout.contentWidth);
    stackSetAlignment(pageViews[page], 5);
  }

  pageTitle = dynamicLabel("网关概览", "page-title", 18, colors.text, 620);
  pageSubtitle = dynamicLabel("查看服务状态、Provider 认证和模型目录", "page-subtitle", 10, colors.subtle, 620);
  pageRoute = dynamicLabel("GET /health", "page-route", 9, colors.subtle, 220);
  const pageHeader = HStack(10, [
    VStack(2, [pageTitle, pageSubtitle]),
    Spacer(),
    pageRoute
  ]);
  stackSetAlignment(pageHeader, 12);
  card(pageHeader, layout.contentWidth);
  widgetSetHeight(pageHeader, 68);

  navRows = HStack(6, []);
  stackSetAlignment(navRows, 12);
  widgetSetWidth(navRows, 444);
  renderNavigation();
  const navigation = HStack(12, [
    navRows,
    Spacer(),
    label("PERRY NATIVE UI", 9, colors.subtle)
  ]);
  stackSetAlignment(navigation, 12);
  setPadding(navigation, 8, 22, 8, 22);
  fill(navigation, colors.panel);
  widgetSetWidth(navigation, layout.windowWidth);
  widgetSetHeight(navigation, 50);

  pageHost = VStack(0, []);
  stackSetAlignment(pageHost, 5);
  widgetSetWidth(pageHost, layout.contentWidth);
  renderPage();
  const pageContent = VStack(12, [pageHeader, pageHost]);
  stackSetAlignment(pageContent, 5);
  setPadding(pageContent, 18, 22, 24, 22);
  widgetSetWidth(pageContent, layout.contentWidth);

  const scroll = ScrollView();
  scrollviewSetChild(scroll, pageContent);
  widgetSetWidth(scroll, layout.windowWidth);
  widgetSetHeight(scroll, layout.windowHeight - 114);

  const root = VStack(0, [header, navigation, scroll]);
  stackSetAlignment(root, 5);
  fill(root, colors.background);
  widgetSetWidth(root, layout.windowWidth);
  widgetSetHeight(root, layout.windowHeight);
  return root;
}

export function startDashboard(): void {
  const root = buildUi();
  let dashboardStarted = false;
  appSetTimer(100, () => {
    if (dashboardStarted) return;
    dashboardStarted = true;
    void loadDashboard();
  });

  App({
    title: "LLM Gateway",
    width: 1180,
    height: 820,
    body: root,
    vibrancy: "windowBackground"
  });
}
