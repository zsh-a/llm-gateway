import type { JsonRecord } from "./types.js";

/** Runtime guards for values crossing the JSON/provider boundary. */
export function asRecord(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asTrimmedString(value: unknown): string | undefined {
  const result = asString(value)?.trim();
  return result || undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value !== "number" && typeof value !== "string") return undefined;
  const result = typeof value === "number" ? value : Number(value);
  return Number.isFinite(result) ? result : undefined;
}

export function asNonNegativeNumber(value: unknown): number | undefined {
  const result = asNumber(value);
  return result !== undefined && result >= 0 ? result : undefined;
}

export function asPositiveNumber(value: unknown): number | undefined {
  const result = asNumber(value);
  return result !== undefined && result > 0 ? result : undefined;
}

export function asPositiveInt(value: unknown): number | undefined {
  const result = asNumber(value);
  return result !== undefined && Number.isInteger(result) && result > 0
    ? result
    : undefined;
}

export function asBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function serializedValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const result = JSON.stringify(value);
    return result === undefined ? String(value) : result;
  } catch {
    return String(value);
  }
}

