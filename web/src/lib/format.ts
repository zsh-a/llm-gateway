import type { Usage } from "../types";

export function toFiniteNumber(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function formatNumber(value: number | null | undefined): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 }).format(toFiniteNumber(value));
}

export function formatCompact(value: number | null | undefined): string {
  const amount = toFiniteNumber(value);
  if (amount >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B`;
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return formatNumber(amount);
}

export function formatDuration(value: number | null | undefined): string {
  const amount = toFiniteNumber(value);
  if (!amount) return "—";
  if (amount < 1000) return `${Math.round(amount)} ms`;
  return `${(amount / 1000).toFixed(2)} s`;
}

export function formatTime(value: number | undefined, withDate = false): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    month: withDate ? "2-digit" : undefined,
    day: withDate ? "2-digit" : undefined,
    hour: "2-digit",
    minute: "2-digit",
    second: withDate ? undefined : "2-digit",
  }).format(new Date(value));
}

export function usageTotal(usage: Usage | undefined): number {
  return (
    toFiniteNumber(usage?.totalTokens) ||
    toFiniteNumber(usage?.inputTokens) +
      toFiniteNumber(usage?.outputTokens) +
      toFiniteNumber(usage?.reasoningTokens)
  );
}
