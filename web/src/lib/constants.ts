import {
  BarChart3,
  LayoutDashboard,
  MessageSquareText,
  Settings2,
  ShieldCheck
} from "lucide-react";
import type { DashboardData, MetricsSummary, PageKey } from "../types";

const emptyTokens = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cachedTokens: 0,
  cacheCreationTokens: 0,
  inputAudioTokens: 0,
  outputAudioTokens: 0,
  inputImageTokens: 0,
  outputImageTokens: 0,
  acceptedPredictionTokens: 0,
  rejectedPredictionTokens: 0,
  totalTokens: 0,
  requestsWithUsage: 0
};

export const emptySummary: MetricsSummary = {
  requests: 0,
  successes: 0,
  errors: 0,
  canceled: 0,
  successRate: null,
  activeRequests: 0,
  latency: { averageMs: null, p50Ms: null, p95Ms: null, maxMs: null },
  tokens: emptyTokens,
  byProvider: [],
  byChannel: [],
  byModel: [],
  byApiKey: []
};

export const emptyDashboard: DashboardData = {
  health: { status: "offline" },
  auth: { ready: false, providers: {} },
  models: [],
  summary: emptySummary,
  timeseries: [],
  recent: [],
  channels: [],
  keys: [],
  adminError: ""
};

export const pageMeta: Record<PageKey, { label: string; title: string; description: string }> = {
  overview: { label: "概览", title: "网关概览", description: "实时掌握服务状态、模型目录和最近调用" },
  playground: { label: "Playground", title: "模型工作台", description: "直接验证模型、思考强度和响应效果" },
  metrics: { label: "统计分析", title: "流量与用量", description: "请求、Token、延迟和模型路由的完整视图" },
  management: { label: "资源管理", title: "渠道与密钥", description: "管理 Provider 渠道、模型路由和访问权限" },
  settings: { label: "设置", title: "运行设置", description: "控制台凭证、主题和运行时信息" }
};

export const navigation: Array<{ key: PageKey; icon: typeof LayoutDashboard }> = [
  { key: "overview", icon: LayoutDashboard },
  { key: "playground", icon: MessageSquareText },
  { key: "metrics", icon: BarChart3 },
  { key: "management", icon: ShieldCheck },
  { key: "settings", icon: Settings2 }
];

export function resolvePage(hash: string): PageKey {
  const value = hash.replace(/^#/, "") as PageKey;
  return value in pageMeta ? value : "overview";
}
