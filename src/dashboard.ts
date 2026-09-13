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
  TextArea,
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
  showToast,
  textSetColor,
  textSetFontFamily,
  textSetFontSize,
  textSetSelectable,
  textSetWraps,
  textfieldSetBackgroundColor,
  textfieldSetBorderless,
  textfieldSetFontSize,
  textfieldSetTextColor,
  textareaSetString,
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
  capabilities?: {
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

let gatewayKey = process.env.PROXY_API_KEY?.trim() || "";
let promptValue = "请用一句话介绍你自己。";
let models: GatewayModel[] = [];
let modelSearch = "";
let selectedModelIndex = 0;

let modelRows: Widget;
let modelPickerHost: Widget;
let providerRows: Widget;
let modelPicker: Widget | null = null;
let globalStatus: Widget;
let responseStatus: Widget;

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
  value: Color
): Widget {
  const widget = Text(content, id);
  color(widget, value);
  textSetFontSize(widget, size);
  textSetWraps(widget, 620);
  return widget;
}

function card(widget: Widget, width = 0): Widget {
  fill(widget, colors.panel);
  border(widget, colors.border);
  setCornerRadius(widget, 16);
  setPadding(widget, 16, 16, 16, 16);
  if (width > 0) widgetSetWidth(widget, width);
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

function metric(title: string, valueId: string, foot: string): Widget {
  const widget = VStack(5, [
    label(title, 11, colors.subtle),
    dynamicLabel("—", valueId, 23, colors.text),
    label(foot, 10, colors.subtle)
  ]);
  card(widget, 175);
  widgetSetHeight(widget, 86);
  return widget;
}

function styleInput(widget: Widget, width: number): void {
  widgetSetWidth(widget, width);
  textfieldSetBackgroundColor(widget, colors.panelMuted.r, colors.panelMuted.g, colors.panelMuted.b, 1);
  textfieldSetBorderless(widget, 0);
  textfieldSetFontSize(widget, 12);
  textfieldSetTextColor(widget, colors.text.r, colors.text.g, colors.text.b, 1);
  setPadding(widget, 8, 10, 8, 10);
}

function modelFrom(value: unknown): GatewayModel | null {
  const record = asRecord(value);
  const id = stringValue(record.id);
  if (!id) return null;
  const capabilities = asRecord(record.capabilities);
  return {
    id,
    name: stringValue(record.name) || undefined,
    provider: stringValue(record.provider) || undefined,
    capabilities: {
      reasoning: capabilities.reasoning === true,
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

interface CommandResponse {
  status: number;
  body: string;
}

function requestText(
  path: string,
  method = "GET",
  body = ""
): Promise<CommandResponse> {
  const args = [
    "--silent",
    "--show-error",
    "--request", method,
    "--connect-timeout", "5",
    "--max-time", "120",
    "--header", "Accept: application/json"
  ];
  if (gatewayKey) args.push("--header", `Authorization: Bearer ${gatewayKey}`);
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
  body = ""
): Promise<unknown> {
  const response = await requestText(path, method, body);
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
  setText("global-status", text);
  color(globalStatus, value);
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
      ? `${model.name} · ${model.id}`
      : model.id;
    const subtitle = `${providerName(model.provider || "unknown")}  ·  ${
      model.capabilities?.reasoning ? "Reasoning" : "Chat"
    }`;
    const row = button(
      `${title}\n${subtitle}`,
      () => selectModel(index),
      index === selectedModelIndex ? colors.accent : colors.muted,
      520
    );
    fill(row, index === selectedModelIndex ? colors.panelMuted : colors.background);
    border(row, index === selectedModelIndex ? colors.accent : colors.border);
    setCornerRadius(row, 10);
    widgetSetHeight(row, 52);
    widgetAddChild(modelRows, row);
  });

  if (visible === 0) {
    const message = stateText();
    widgetAddChild(modelRows, label(message, 12, colors.subtle));
  }
  setText("model-count", String(models.length));
  renderPicker();
}

function stateText(): string {
  if (models.length === 0) return "暂无模型，请先完成 Provider 认证。";
  return "没有匹配的模型。";
}

function renderPicker(): void {
  widgetClearChildren(modelPickerHost);
  modelPicker = Picker((index) => selectModel(index));
  for (const model of models) {
    pickerAddItem(modelPicker, `${model.name || model.id} · ${providerName(model.provider || "unknown")}`);
  }
  if (models.length > 0) pickerSetSelected(modelPicker, selectedModelIndex);
  widgetSetWidth(modelPicker, 430);
  widgetAddChild(modelPickerHost, modelPicker);
}

function selectModel(index: number): void {
  if (index < 0 || index >= models.length) return;
  selectedModelIndex = index;
  if (modelPicker) pickerSetSelected(modelPicker, index);
  renderModels();
  setText("selected-model", models[index].id);
}

function renderProviders(statusValue: unknown): void {
  const providers = asRecord(asRecord(statusValue).providers);
  const ids = Object.keys(providers);
  widgetClearChildren(providerRows);

  for (const id of ids) {
    const status = asRecord(providers[id]) as ProviderStatus;
    const ready = status.ready === true;
    const statusColor = ready ? colors.green : colors.yellow;
    const detail = ready
      ? `认证缓存 · ${formatTime(status.capturedAt)}`
      : `运行 npm run auth -- --provider ${id}`;
    const providerCard = VStack(8, [
      HStack(8, [
        label(providerName(id), 14, colors.text),
        Spacer(),
        label(ready ? "● 已认证" : "● 待认证", 11, statusColor)
      ]),
      label(id, 10, colors.subtle),
      Divider(),
      label(detail, 11, ready ? colors.muted : colors.yellow)
    ]);
    card(providerCard, 1040);
    widgetAddChild(providerRows, providerCard);
  }

  if (ids.length === 0) {
    widgetAddChild(providerRows, label("暂时无法读取 Provider 状态。", 12, colors.subtle));
  }
  setText("metric-providers", String(ids.length || "—"));
}

async function loadDashboard(): Promise<void> {
  setGlobalState("刷新中…", colors.muted);
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
    setGlobalState(health.status === "ok" ? "在线" : "异常", health.status === "ok" ? colors.green : colors.yellow);
  } catch (error) {
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
  selectedModelIndex = Math.min(selectedModelIndex, Math.max(0, models.length - 1));
  setText("metric-models", String(models.length || "—"));
  renderModels();
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
  setText("response-reasoning", "");
  setText("response-answer", "");
  try {
    const payload = asRecord(await requestJson(
      "/v1/chat/completions",
      "POST",
      JSON.stringify({
        model: model.id,
        messages: [{ role: "user", content: promptValue }],
        stream: false
      })
    ));
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
  }
}

function saveKey(): void {
  setText("key-state", gatewayKey ? "当前运行时已保存" : "未设置 API Key");
  showToast(gatewayKey ? "API Key 已保存" : "API Key 已清除");
  void loadDashboard();
}

function buildUi(): Widget {
  const brand = VStack(4, [
    label("LLM Gateway", 22, colors.text),
    label("ONE ENDPOINT · MULTIPLE PROVIDERS", 10, colors.cyan)
  ]);
  const endpoint = label(`${gatewayUrl}/v1`, 10, colors.cyan);
  globalStatus = dynamicLabel("检测中", "global-status", 12, colors.muted);
  const refresh = button("刷新", () => { void loadDashboard(); }, colors.text, 72);
  const header = HStack(14, [brand, Spacer(), endpoint, globalStatus, refresh]);
  setPadding(header, 16, 22, 16, 22);
  fill(header, colors.panelMuted);
  widgetSetWidth(header, 1180);

  const hero = VStack(8, [
    label("CONTROL PLANE", 10, colors.cyan),
    label("你的模型入口，一处管理。", 30, colors.text),
    label("统一查看认证状态、模型目录，并通过同一个 OpenAI 兼容接口连接 MiMo、WorkBuddy 以及未来的更多 Provider。", 13, colors.muted),
    label(`Base URL  ${gatewayUrl}/v1`, 11, colors.accent)
  ]);
  card(hero);
  widgetSetHeight(hero, 148);
  widgetSetWidth(hero, 1136);

  const metrics = HStack(12, [
    metric("Provider", "metric-providers", "已注册上游"),
    metric("认证状态", "metric-auth", "可直接调用"),
    metric("模型目录", "metric-models", "自动发现与缓存"),
    metric("API Endpoint", "metric-endpoint", "OpenAI compatible")
  ]);
  widgetSetWidth(metrics, 1136);
  setText("metric-endpoint", `${gatewayHost}:${config.port}`);

  modelRows = VStack(8, []);
  const modelScroll = ScrollView();
  scrollviewSetChild(modelScroll, modelRows);
  widgetSetHeight(modelScroll, 315);
  widgetSetWidth(modelScroll, 520);
  const search = TextField("搜索模型名称或 ID", (value) => {
    modelSearch = value.trim();
    renderModels();
  });
  styleInput(search, 520);
  const modelPanel = VStack(12, [
    HStack(8, [
      VStack(3, [label("模型目录", 15, colors.text), label("来自各 Provider 的可用模型", 11, colors.subtle)]),
      Spacer(),
      dynamicLabel("—", "model-count", 11, colors.cyan)
    ]),
    search,
    modelScroll,
    dynamicLabel("", "model-error", 10, colors.red)
  ]);
  card(modelPanel, 570);

  modelPickerHost = VStack(8, []);
  const prompt = TextArea("输入一条消息，验证当前网关链路…", (value) => {
    promptValue = value;
  });
  textareaSetString(prompt, promptValue);
  widgetSetWidth(prompt, 430);
  widgetSetHeight(prompt, 112);
  fill(prompt, colors.panelMuted);
  border(prompt, colors.border);
  setPadding(prompt, 10, 11, 10, 11);

  responseStatus = dynamicLabel("准备就绪", "response-status", 11, colors.subtle);
  const testPanel = VStack(12, [
    HStack(8, [
      VStack(3, [label("快速测试", 15, colors.text), label("发送一条真实的 OpenAI 兼容请求", 11, colors.subtle)]),
      Spacer(),
      responseStatus
    ]),
    label("目标模型", 11, colors.muted),
    modelPickerHost,
    label("Prompt", 11, colors.muted),
    prompt,
    HStack(10, [button("发送请求", () => { void sendChat(); }, colors.text, 120), label("stream: false · ⌘ / Ctrl + Enter", 10, colors.subtle)]),
    Divider(),
    label("思考过程", 10, colors.yellow),
    dynamicLabel("", "response-reasoning", 10, colors.yellow),
    label("回答", 10, colors.cyan),
    dynamicLabel("选择模型并发送消息，响应会显示在这里。", "response-answer", 13, colors.text),
    dynamicLabel("", "response-error", 10, colors.red)
  ]);
  card(testPanel, 470);

  providerRows = VStack(10, []);
  const providerScroll = ScrollView();
  scrollviewSetChild(providerScroll, providerRows);
  widgetSetHeight(providerScroll, 175);
  widgetSetWidth(providerScroll, 1040);
  const providerPanel = VStack(10, [
    HStack(8, [
      VStack(3, [label("Provider 状态", 15, colors.text), label("认证只在首次引导时发生，网关运行时仅读取缓存。", 11, colors.subtle)]),
      Spacer(),
      label("/health/auth", 10, colors.subtle)
    ]),
    providerScroll
  ]);
  card(providerPanel, 1080);

  const key = SecureField("PROXY_API_KEY（可选）", (value) => {
    gatewayKey = value.trim();
  });
  widgetSetWidth(key, 320);
  const keyPanel = VStack(8, [
    HStack(8, [
      VStack(3, [label("Gateway API Key", 13, colors.text), label("仅用于访问当前网关，不会读取上游认证信息。", 10, colors.subtle)]),
      Spacer(),
      dynamicLabel(gatewayKey ? "当前运行时已设置" : "未设置", "key-state", 10, colors.subtle)
    ]),
    HStack(8, [key, button("保存", saveKey, colors.text, 72)])
  ]);
  card(keyPanel, 1080);

  const content = VStack(16, [
    hero,
    metrics,
    HStack(16, [modelPanel, testPanel]),
    providerPanel,
    keyPanel,
    label(`API Base URL  ${gatewayUrl}/v1  ·  认证缓存不会通过 UI 暴露  ·  需要重新认证时运行 npm run auth`, 10, colors.subtle)
  ]);
  setPadding(content, 20, 22, 30, 22);
  widgetSetWidth(content, 1180);

  const scroll = ScrollView();
  scrollviewSetChild(scroll, content);
  widgetSetWidth(scroll, 1180);
  widgetSetHeight(scroll, 760);

  const root = VStack(0, [header, scroll]);
  fill(root, colors.background);
  widgetSetWidth(root, 1180);
  widgetSetHeight(root, 820);
  return root;
}

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
