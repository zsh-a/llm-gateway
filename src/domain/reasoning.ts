import type { ReasoningEffort } from "./types.js";

const VALID_EFFORTS: readonly ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];

export function normalizeEffort(
  value: unknown,
  fallback: ReasoningEffort = "medium"
): ReasoningEffort {
  if (typeof value !== "string") return fallback;

  const normalized = value.trim().toLowerCase();
  if (VALID_EFFORTS.includes(normalized as ReasoningEffort)) {
    return normalized as ReasoningEffort;
  }

  return fallback;
}
