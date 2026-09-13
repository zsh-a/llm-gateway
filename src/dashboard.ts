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
  widgetSetTooltip,
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

const layout = {
  windowWidth: 1120,
  windowHeight: 760,
  contentWidth: 1076,
  sidebarWidth: 250,
  workspaceWidth: 810,
  modelWidth: 365,
  testWidth: 429,
  sidebarInnerWidth: 220,
  modelInnerWidth: 335,
  testInnerWidth: 399,
  panelHeight: 500
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
let overviewStatus: Widget;
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

function metric(title: string, valueId: string, foot: string): Widget {
  const widget = HStack(8, [
    label(title, 11, colors.muted),
    Spacer(),
    dynamicLabel("—", valueId, 13, colors.text, 90)
  ]);
  setPadding(widget, 6, 0, 6, 0);
  stackSetAlignment(widget, 12);
  if (foot) widgetSetTooltip(widget, foot);
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
      model.capabilities?.reasoning ? "Reasoning" : "Chat"
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
}

function stateText(): string {
  if (models.length === 0) return "暂无模型 · 请先完成 Provider 认证";
  return "没有匹配的模型。";
}

function renderPicker(): void {
  widgetClearChildren(modelPickerHost);
  modelPicker = Picker((index) => selectModel(index));
  for (const model of models) {
    pickerAddItem(modelPicker, `${model.name || model.id} · ${providerName(model.provider || "unknown")}`);
  }
  if (models.length > 0) pickerSetSelected(modelPicker, selectedModelIndex);
  widgetSetWidth(modelPicker, layout.testInnerWidth);
  widgetAddChild(modelPickerHost, modelPicker);
}

function selectModel(index: number): void {
  if (index < 0 || index >= models.length) return;
  selectedModelIndex = index;
  if (modelPicker) pickerSetSelected(modelPicker, index);
  renderModels();
}

function renderProviders(statusValue: unknown): void {
  const providers = asRecord(asRecord(statusValue).providers);
  const ids = Object.keys(providers);
  widgetClearChildren(providerRows);

  for (const id of ids) {
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
    surface(providerRow, layout.sidebarInnerWidth, 44);
    stackSetAlignment(providerRow, 12);
    widgetAddChild(providerRows, providerRow);
  }

  if (ids.length === 0) {
    widgetAddChild(providerRows, label("暂时无法读取 Provider 状态。", 11, colors.subtle));
  }
  setText("metric-providers", String(ids.length || "—"));
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

  const intro = HStack(16, [
    VStack(3, [
      label("CONTROL PLANE", 9, colors.cyan),
      label("一处连接，统一调用。", 23, colors.text),
      label("管理认证、模型目录，并通过一个 OpenAI 兼容入口连接多个 Provider。", 11, colors.muted)
    ]),
    Spacer(),
    VStack(3, [
      label("SERVICE", 9, colors.subtle),
      label("OpenAI compatible", 11, colors.accent),
      label("MiMo · WorkBuddy · more", 10, colors.muted)
    ])
  ]);
  stackSetAlignment(intro, 12);
  card(intro, layout.contentWidth);
  stackSetAlignment(intro, 12);
  widgetSetHeight(intro, 84);

  overviewStatus = dynamicLabel("● 检测中", "overview-status", 12, colors.muted, 120);
  const overview = VStack(9, [
    HStack(8, [
      VStack(2, [
        label("服务状态", 14, colors.text),
        label("网关与上游连接", 10, colors.subtle)
      ]),
      Spacer(),
      overviewStatus
    ]),
    Divider(),
    metric("Provider", "metric-providers", "已注册上游"),
    metric("已认证", "metric-auth", "可直接调用"),
    metric("模型", "metric-models", "自动发现目录")
  ]);
  stackSetAlignment(overview, 5);
  card(overview, layout.sidebarWidth);
  widgetSetHeight(overview, 154);

  providerRows = VStack(8, []);
  stackSetAlignment(providerRows, 5);
  widgetSetWidth(providerRows, layout.sidebarInnerWidth);
  const providerPanel = VStack(9, [
    HStack(8, [
      VStack(2, [
        label("Providers", 14, colors.text),
        label("认证状态", 10, colors.subtle)
      ]),
      Spacer(),
      label("/health/auth", 9, colors.subtle)
    ]),
    Divider(),
    providerRows
  ]);
  stackSetAlignment(providerPanel, 5);
  card(providerPanel, layout.sidebarWidth);
  widgetSetHeight(providerPanel, 166);

  const key = SecureField("PROXY_API_KEY（可选）", (value) => {
    gatewayKey = value.trim();
  });
  styleInput(key, layout.sidebarInnerWidth);
  const keyPanel = VStack(8, [
    HStack(8, [
      VStack(2, [
        label("访问密钥", 14, colors.text),
        label("保护本地网关", 10, colors.subtle)
      ]),
      Spacer(),
      dynamicLabel(gatewayKey ? "已设置" : "未设置", "key-state", 10, colors.subtle, 70)
    ]),
    key,
    HStack(8, [
      label("仅影响 Gateway API", 9, colors.subtle),
      Spacer(),
      button("保存", saveKey, colors.cyan, 58)
    ])
  ]);
  stackSetAlignment(keyPanel, 5);
  card(keyPanel, layout.sidebarWidth);
  widgetSetHeight(keyPanel, 148);

  const sidebar = VStack(12, [overview, providerPanel, keyPanel]);
  stackSetAlignment(sidebar, 5);
  widgetSetWidth(sidebar, layout.sidebarWidth);

  modelRows = VStack(7, []);
  stackSetAlignment(modelRows, 5);
  widgetSetWidth(modelRows, layout.modelInnerWidth);
  const modelScroll = ScrollView();
  scrollviewSetChild(modelScroll, modelRows);
  widgetSetHeight(modelScroll, 354);
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
        label("来自已认证 Provider", 10, colors.subtle)
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
  widgetSetWidth(modelPickerHost, layout.testInnerWidth);

  const prompt = TextField("输入一条消息，验证当前网关链路…", (value) => {
    promptValue = value;
  });
  textfieldSetString(prompt, promptValue);
  styleInput(prompt, layout.testInnerWidth);

  responseStatus = dynamicLabel("准备就绪", "response-status", 11, colors.subtle, 76);
  const selectedModel = dynamicLabel("选择一个模型", "selected-model", 10, colors.accent, 190);
  const reasoning = surface(
    VStack(4, [
      label("THINKING", 9, colors.yellow),
      dynamicLabel("暂无思考内容", "response-reasoning", 10, colors.yellow, layout.testInnerWidth - 22)
    ]),
    layout.testInnerWidth,
    64
  );
  const answer = surface(
    VStack(4, [
      label("ANSWER", 9, colors.cyan),
      dynamicLabel("选择模型并发送消息，响应会显示在这里。", "response-answer", 12, colors.text, layout.testInnerWidth - 22)
    ]),
    layout.testInnerWidth,
    144
  );
  const testPanel = VStack(10, [
    HStack(8, [
      VStack(2, [
        label("快速测试", 15, colors.text),
        label("发送一条真实的兼容请求", 10, colors.subtle)
      ]),
      Spacer(),
      VStack(2, [selectedModel, responseStatus])
    ]),
    label("目标模型", 10, colors.muted),
    modelPickerHost,
    label("Prompt", 10, colors.muted),
    prompt,
    HStack(10, [
      primaryButton("发送请求", () => { void sendChat(); }, 112),
      label("stream: false", 9, colors.subtle)
    ]),
    reasoning,
    answer,
    dynamicLabel("", "response-error", 10, colors.red, layout.testInnerWidth)
  ]);
  stackSetAlignment(testPanel, 5);
  card(testPanel, layout.testWidth);
  widgetSetHeight(testPanel, layout.panelHeight);

  const workspaceHeading = HStack(10, [
    VStack(2, [
      label("工作台", 15, colors.text),
      label("选择模型并验证请求链路", 10, colors.subtle)
    ]),
    Spacer(),
    label("POST /v1/chat/completions", 9, colors.subtle)
  ]);
  stackSetAlignment(workspaceHeading, 12);

  const workspace = VStack(12, [
    workspaceHeading,
    HStack(16, [modelPanel, testPanel])
  ]);
  stackSetAlignment(workspace, 5);
  widgetSetWidth(workspace, layout.workspaceWidth);

  const main = HStack(16, [sidebar, workspace]);
  stackSetAlignment(main, 3);
  widgetSetWidth(main, layout.contentWidth);

  const content = VStack(16, [
    intro,
    main,
    label("认证独立于网关运行 · 模型目录来自 /v1/models · 重新认证请运行 npm run auth", 10, colors.subtle)
  ]);
  stackSetAlignment(content, 5);
  setPadding(content, 18, 22, 24, 22);
  widgetSetWidth(content, layout.contentWidth);

  const scroll = ScrollView();
  scrollviewSetChild(scroll, content);
  widgetSetWidth(scroll, layout.windowWidth);
  widgetSetHeight(scroll, layout.windowHeight - 64);

  const root = VStack(0, [header, scroll]);
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
