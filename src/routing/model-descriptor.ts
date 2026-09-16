import {
  asBool,
  asRecord,
  asPositiveNumber,
  asTrimmedString
} from "../domain/json.js";
import type {
  JsonRecord,
  ModelCapabilities,
  ModelDescriptor,
  ReasoningEfforts
} from "../domain/types.js";
function reasoningEffortsValue(value: unknown): ReasoningEfforts | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const efforts: ReasoningEfforts = {};
  for (const [id, wireValue] of Object.entries(value as JsonRecord)) {
    if (wireValue === null || typeof wireValue === "string") {
      efforts[id] = wireValue;
    }
  }
  return Object.keys(efforts).length > 0 ? efforts : undefined;
}

const GENERIC_REASONING_EFFORTS: ReasoningEfforts = {
  off: null,
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};

const DEEPSEEK_V4_REASONING_EFFORTS: ReasoningEfforts = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "high",
  high: "high",
  xhigh: "high",
  max: "max"
};

function modelId(value: unknown): string {
  if (typeof value === "string") return value.trim();

  const record = asRecord(value);
  for (const key of ["id", "modelName", "model"]) {
    const id = asTrimmedString(record[key]) ?? "";
    if (id) return id;
  }
  return "";
}

function modelDescriptor(
  value: unknown,
  defaultOwnedBy: string
): ModelDescriptor | null {
  const id = modelId(value);
  if (!id) return null;
  if (typeof value === "string") return { id, ownedBy: defaultOwnedBy };

  const record = asRecord(value);
  const recordCapabilities = asRecord(record.capabilities);
  const capabilities: ModelCapabilities = {};
  const toolCalling = asBool(
    record.supportsToolCall ?? record.supportsToolCalls ?? record.tool_calling ??
      recordCapabilities.toolCalling ?? recordCapabilities.tool_calling
  );
  const images = asBool(
    record.supportsImages ?? record.supportsVision ?? record.vision ??
      recordCapabilities.images ?? recordCapabilities.vision
  );
  const rawReasoning = record.supportsReasoning ?? record.reasoning ??
    record.thinking ?? recordCapabilities.reasoning ?? recordCapabilities.thinking;
  const reasoning = asBool(
    rawReasoning
  );
  const nestedReasoning = asRecord(record.reasoning);
  const efforts = reasoningEffortsValue(
    record.reasoningEfforts ?? record.reasoning_efforts ??
      recordCapabilities.reasoningEfforts ?? recordCapabilities.reasoning_efforts ??
      nestedReasoning.efforts
  );
  const reasoningEnabled = reasoning ?? (
    rawReasoning !== undefined && typeof rawReasoning === "object"
      ? true
      : efforts !== undefined
        ? true
        : undefined
  );
  if (toolCalling !== undefined) capabilities.toolCalling = toolCalling;
  if (images !== undefined) capabilities.images = images;
  if (reasoningEnabled !== undefined) capabilities.reasoning = reasoningEnabled;
  if (Object.keys(capabilities).length > 0) capabilities.chat = true;

  const name = asTrimmedString(
    record.displayName ?? record.label ?? record.name ?? record.title
  );
  const ownedBy = asTrimmedString(
    record.owned_by ?? record.ownedBy ?? record.vendor ?? record.provider
  ) || defaultOwnedBy;
  const descriptor: ModelDescriptor = { id, ownedBy };
  if (name && name !== id) descriptor.name = name;
  if (Object.keys(capabilities).length > 0) descriptor.capabilities = capabilities;

  if (efforts !== undefined && reasoningEnabled !== false) {
    descriptor.reasoningEfforts = efforts;
  } else if (reasoningEnabled === true) {
    descriptor.reasoningEfforts = id.toLowerCase().startsWith("deepseek-v4-")
      ? { ...DEEPSEEK_V4_REASONING_EFFORTS }
      : { ...GENERIC_REASONING_EFFORTS };
  }

  const defaultReasoningEffort = asTrimmedString(
    record.defaultReasoningEffort ?? record.default_reasoning_effort ??
      nestedReasoning.defaultEffort ?? nestedReasoning.default_effort ??
      nestedReasoning.effort
  );
  if (defaultReasoningEffort) {
    descriptor.defaultReasoningEffort = defaultReasoningEffort;
  }

  const maxInputTokens = asPositiveNumber(
    record.maxInputTokens ?? record.max_input_tokens ?? record.contextWindow
  );
  const maxOutputTokens = asPositiveNumber(
    record.maxOutputTokens ?? record.max_output_tokens ?? record.maxTokens
  );
  if (maxInputTokens !== undefined) descriptor.maxInputTokens = maxInputTokens;
  if (maxOutputTokens !== undefined) descriptor.maxOutputTokens = maxOutputTokens;
  return descriptor;
}

export function uniqueModels(
  values: unknown[],
  defaultOwnedBy: string
): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const model = modelDescriptor(value, defaultOwnedBy);
    if (!model || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

export function extractModels(
  value: unknown,
  defaultOwnedBy: string
): ModelDescriptor[] {
  const root = asRecord(value);
  if (root.code !== undefined && Number(root.code) !== 0) return [];

  const values: unknown[] = [];
  if (Array.isArray(root.models)) values.push(...root.models);

  const data = root.data;
  if (Array.isArray(data)) values.push(...data);

  const dataRecord = asRecord(data);
  if (Array.isArray(dataRecord.models)) values.push(...dataRecord.models);
  if (Array.isArray(dataRecord.groups)) {
    for (const group of dataRecord.groups) {
      const models = asRecord(group).models;
      if (Array.isArray(models)) values.push(...models);
    }
  }

  if (values.length === 0 && modelId(value)) values.push(value);
  return uniqueModels(values, defaultOwnedBy);
}

export function filterModels(
  models: ModelDescriptor[],
  allowlist: string[]
): ModelDescriptor[] {
  if (allowlist.length === 0) return models;
  const allowed = new Set(allowlist);
  return models.filter((model) => allowed.has(model.id));
}
