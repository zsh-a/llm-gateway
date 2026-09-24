import type { Usage, UsageBreakdown } from "../types";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function number(value: Record<string, unknown>, ...keys: string[]): number | undefined {
  return keys
    .map((key) => value[key])
    .find(
      (value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
    );
}

function details(value: unknown): UsageBreakdown {
  const source = object(value);
  return Object.fromEntries(
    [
      ["cachedTokens", "cached_tokens"],
      ["reasoningTokens", "reasoning_tokens"],
      ["audioTokens", "audio_tokens"],
      ["imageTokens", "image_tokens"],
      ["textTokens", "text_tokens"],
      ["acceptedPredictionTokens", "accepted_prediction_tokens"],
      ["rejectedPredictionTokens", "rejected_prediction_tokens"],
    ]
      .map(([camel, snake]) => [camel, number(source, camel, snake)])
      .filter(([, value]) => value !== undefined),
  );
}

export function normalizeUsage(value: unknown): Usage | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const source = object(value);
  const inputDetails = details(
    source.inputDetails ?? source.prompt_tokens_details ?? source.input_tokens_details,
  );
  const outputDetails = details(
    source.outputDetails ?? source.completion_tokens_details ?? source.output_tokens_details,
  );
  const inputTokens = number(source, "inputTokens", "prompt_tokens", "input_tokens");
  const outputTokens = number(source, "outputTokens", "completion_tokens", "output_tokens");
  return {
    ...source,
    inputTokens,
    outputTokens,
    totalTokens:
      number(source, "totalTokens", "total_tokens") ??
      (inputTokens !== undefined && outputTokens !== undefined
        ? inputTokens + outputTokens
        : undefined),
    cachedTokens: number(source, "cachedTokens", "cached_tokens") ?? inputDetails.cachedTokens,
    reasoningTokens:
      number(source, "reasoningTokens", "reasoning_tokens") ?? outputDetails.reasoningTokens,
    inputDetails,
    outputDetails,
  };
}
