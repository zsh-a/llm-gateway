import type { JsonRecord } from "./types.js";
import { asNonNegativeNumber, asRecord } from "./json.js";

export interface TokenBreakdown {
  cachedTokens?: number;
  audioTokens?: number;
  imageTokens?: number;
  textTokens?: number;
  reasoningTokens?: number;
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
}

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  cacheCreationTokens?: number;
  inputAudioTokens?: number;
  outputAudioTokens?: number;
  inputImageTokens?: number;
  outputImageTokens?: number;
  acceptedPredictionTokens?: number;
  rejectedPredictionTokens?: number;
  inputDetails?: TokenBreakdown;
  outputDetails?: TokenBreakdown;
  totalTokens?: number;
}

function firstNumber(record: JsonRecord, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = asNonNegativeNumber(record[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function firstNumberFrom(records: JsonRecord[], keys: readonly string[]): number | undefined {
  for (const record of records) {
    const value = firstNumber(record, keys);
    if (value !== undefined) return value;
  }
  return undefined;
}

function maxNumberFrom(records: JsonRecord[], keys: readonly string[]): number | undefined {
  let maximum: number | undefined;
  for (const record of records) {
    for (const key of keys) {
      const value = asNonNegativeNumber(record[key]);
      if (value === undefined) continue;
      maximum = maximum === undefined ? value : Math.max(maximum, value);
    }
  }
  return maximum;
}

// Different providers report the same counters under different names. These
// aliases represent one value and must be reconciled, not added together.
const CACHE_READ_KEYS = [
  "cached_tokens",
  "cachedTokens",
  "prompt_cache_hit_tokens",
  "promptCacheHitTokens",
  "input_cached_tokens",
  "inputCachedTokens",
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cache_read_tokens",
  "cacheReadTokens",
  "cache_hit_tokens",
  "cacheHitTokens",
  "cached_content_token_count",
  "cachedContentTokenCount"
];

const CACHE_WRITE_KEYS = [
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "cache_write_input_tokens",
  "cacheWriteInputTokens",
  "prompt_cache_write_tokens",
  "promptCacheWriteTokens",
  "cache_creation_tokens",
  "cacheCreationTokens",
  "cache_write_tokens",
  "cacheWriteTokens"
];

function detailRecord(value: unknown): JsonRecord {
  return asRecord(value);
}

function mergeDetails(...values: unknown[]): JsonRecord {
  const result: JsonRecord = {};
  for (const value of values) Object.assign(result, detailRecord(value));
  return result;
}

function normalizeBreakdown(
  records: JsonRecord[],
  includeReasoning = false,
  includePrediction = false
): TokenBreakdown | undefined {
  const result: TokenBreakdown = {};
  const cachedTokens = maxNumberFrom(records, CACHE_READ_KEYS);
  const audioTokens = firstNumberFrom(records, ["audio_tokens", "audioTokens"]);
  const imageTokens = firstNumberFrom(records, ["image_tokens", "imageTokens"]);
  const textTokens = firstNumberFrom(records, ["text_tokens", "textTokens"]);
  const reasoningTokens = includeReasoning
    ? firstNumberFrom(records, ["reasoning_tokens", "reasoningTokens"])
    : undefined;
  const acceptedPredictionTokens = includePrediction
    ? firstNumberFrom(records, ["accepted_prediction_tokens", "acceptedPredictionTokens"])
    : undefined;
  const rejectedPredictionTokens = includePrediction
    ? firstNumberFrom(records, ["rejected_prediction_tokens", "rejectedPredictionTokens"])
    : undefined;

  if (cachedTokens !== undefined) result.cachedTokens = cachedTokens;
  if (audioTokens !== undefined) result.audioTokens = audioTokens;
  if (imageTokens !== undefined) result.imageTokens = imageTokens;
  if (textTokens !== undefined) result.textTokens = textTokens;
  if (reasoningTokens !== undefined) result.reasoningTokens = reasoningTokens;
  if (acceptedPredictionTokens !== undefined) result.acceptedPredictionTokens = acceptedPredictionTokens;
  if (rejectedPredictionTokens !== undefined) result.rejectedPredictionTokens = rejectedPredictionTokens;

  return Object.keys(result).length > 0 ? result : undefined;
}

/** Normalize provider usage into one internal metric shape. */
export function normalizeUsage(value: unknown): TokenUsage | null {
  const record = asRecord(value);
  const inputDetails = [
    detailRecord(record.prompt_tokens_details),
    detailRecord(record.input_tokens_details),
    detailRecord(record.input_token_details),
    detailRecord(record.inputDetails)
  ];
  const outputDetails = [
    detailRecord(record.completion_tokens_details),
    detailRecord(record.output_tokens_details),
    detailRecord(record.output_token_details),
    detailRecord(record.outputDetails)
  ];
  const inputSources = [record, ...inputDetails];
  const outputSources = [record, ...outputDetails];
  const inputTokens = firstNumber(record, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens = firstNumber(record, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const reasoningTokens = firstNumberFrom(outputSources, ["reasoning_tokens", "reasoningTokens"]);
  const cachedTokens = maxNumberFrom(inputSources, CACHE_READ_KEYS);
  const cacheCreationTokens = maxNumberFrom(inputSources, CACHE_WRITE_KEYS);
  const inputAudioTokens = firstNumberFrom(inputSources, ["input_audio_tokens", "inputAudioTokens", "audio_input_tokens", "audioInputTokens"]) ??
    firstNumberFrom(inputDetails, ["audio_tokens", "audioTokens"]);
  const outputAudioTokens = firstNumberFrom(outputSources, ["output_audio_tokens", "outputAudioTokens", "audio_output_tokens", "audioOutputTokens"]) ??
    firstNumberFrom(outputDetails, ["audio_tokens", "audioTokens"]);
  const inputImageTokens = firstNumberFrom(inputSources, ["input_image_tokens", "inputImageTokens", "image_input_tokens", "imageInputTokens"]) ??
    firstNumberFrom(inputDetails, ["image_tokens", "imageTokens"]);
  const outputImageTokens = firstNumberFrom(outputSources, ["output_image_tokens", "outputImageTokens", "image_output_tokens", "imageOutputTokens"]) ??
    firstNumberFrom(outputDetails, ["image_tokens", "imageTokens"]);
  const acceptedPredictionTokens = firstNumberFrom(outputSources, [
    "accepted_prediction_tokens",
    "acceptedPredictionTokens"
  ]);
  const rejectedPredictionTokens = firstNumberFrom(outputSources, [
    "rejected_prediction_tokens",
    "rejectedPredictionTokens"
  ]);
  const totalTokens = firstNumber(record, ["total_tokens", "totalTokens"]) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const normalizedInputDetails = normalizeBreakdown(inputDetails, false, false);
  const normalizedOutputDetails = normalizeBreakdown(outputDetails, true, true);

  if (
    inputTokens === undefined &&
    outputTokens === undefined &&
    reasoningTokens === undefined &&
    cachedTokens === undefined &&
    cacheCreationTokens === undefined &&
    inputAudioTokens === undefined &&
    outputAudioTokens === undefined &&
    inputImageTokens === undefined &&
    outputImageTokens === undefined &&
    acceptedPredictionTokens === undefined &&
    rejectedPredictionTokens === undefined &&
    totalTokens === undefined
  ) {
    return null;
  }

  const usage: TokenUsage = {};
  if (inputTokens !== undefined) usage.inputTokens = inputTokens;
  if (outputTokens !== undefined) usage.outputTokens = outputTokens;
  if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
  if (cachedTokens !== undefined) usage.cachedTokens = cachedTokens;
  if (cacheCreationTokens !== undefined) usage.cacheCreationTokens = cacheCreationTokens;
  if (inputAudioTokens !== undefined) usage.inputAudioTokens = inputAudioTokens;
  if (outputAudioTokens !== undefined) usage.outputAudioTokens = outputAudioTokens;
  if (inputImageTokens !== undefined) usage.inputImageTokens = inputImageTokens;
  if (outputImageTokens !== undefined) usage.outputImageTokens = outputImageTokens;
  if (acceptedPredictionTokens !== undefined) usage.acceptedPredictionTokens = acceptedPredictionTokens;
  if (rejectedPredictionTokens !== undefined) usage.rejectedPredictionTokens = rejectedPredictionTokens;
  if (normalizedInputDetails) usage.inputDetails = normalizedInputDetails;
  if (normalizedOutputDetails) usage.outputDetails = normalizedOutputDetails;
  if (totalTokens !== undefined) usage.totalTokens = totalTokens;
  return usage;
}

/** Convert provider Chat Completions usage into standard Responses usage. */
export function responsesUsage(value: JsonRecord | null): JsonRecord | null {
  if (!value) return null;

  const usage: JsonRecord = { ...value };
  const inputTokens = maxNumberFrom([value], ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]);
  const outputTokens = maxNumberFrom([value], ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]);
  const totalTokens = firstNumber(value, ["total_tokens", "totalTokens"]) ??
    (inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined);
  const inputDetails = mergeDetails(
    value.input_tokens_details,
    value.inputTokensDetails,
    value.prompt_tokens_details,
    value.promptTokensDetails,
    value.inputDetails
  );
  const outputDetails = mergeDetails(
    value.output_tokens_details,
    value.outputTokensDetails,
    value.completion_tokens_details,
    value.completionTokensDetails,
    value.outputDetails
  );
  const cachedTokens = maxNumberFrom([value, inputDetails], CACHE_READ_KEYS);
  if (cachedTokens !== undefined) inputDetails.cached_tokens = cachedTokens;

  if (inputTokens !== undefined) usage.input_tokens = inputTokens;
  if (outputTokens !== undefined) usage.output_tokens = outputTokens;
  if (totalTokens !== undefined) usage.total_tokens = totalTokens;
  if (Object.keys(inputDetails).length > 0) usage.input_tokens_details = inputDetails;
  if (Object.keys(outputDetails).length > 0) usage.output_tokens_details = outputDetails;

  delete usage.prompt_tokens;
  delete usage.promptTokens;
  delete usage.completion_tokens;
  delete usage.completionTokens;
  delete usage.prompt_tokens_details;
  delete usage.promptTokensDetails;
  delete usage.completion_tokens_details;
  delete usage.completionTokensDetails;
  delete usage.inputTokensDetails;
  delete usage.outputTokensDetails;
  delete usage.inputDetails;
  delete usage.outputDetails;
  return usage;
}
