import type { JsonRecord, ResponseRequestOptions } from "../domain/types.js";

export interface StoredResponse {
  model: string;
  messages: JsonRecord[];
  options: JsonRecord;
  response: ResponseRequestOptions;
}

export interface ResponseStore {
  get(id: string, owner: string): StoredResponse | null;
  put(id: string, owner: string, value: StoredResponse): void;
}

export function cloneJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cloneJsonValue);
  if (value !== null && typeof value === "object") {
    const result: JsonRecord = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = cloneJsonValue(nested);
    }
    return result;
  }
  return value;
}

interface ResponseEntry {
  owner: string;
  value: StoredResponse;
  touchedAt: number;
  bytes: number;
}

/** Default single-process implementation; the interface allows a durable backend later. */
export class InMemoryResponseStore implements ResponseStore {
  private readonly entries = new Map<string, ResponseEntry>();
  private totalBytes = 0;

  constructor(
    private readonly maxEntries = 128,
    private readonly ttlMs = 60 * 60 * 1000,
    private readonly maxBytes = 8 * 1024 * 1024
  ) {}

  get(id: string, owner: string): StoredResponse | null {
    this.evictExpired();
    const entry = this.entries.get(id);
    if (!entry || entry.owner !== owner) return null;
    entry.touchedAt = Date.now();
    this.entries.delete(id);
    this.entries.set(id, entry);
    return cloneJsonValue(entry.value) as StoredResponse;
  }

  put(id: string, owner: string, value: StoredResponse): void {
    this.evictExpired();
    const cloned = cloneJsonValue(value) as StoredResponse;
    const bytes = this.serializedBytes(cloned);
    if (bytes > this.maxBytes) return;

    const previous = this.entries.get(id);
    if (previous) this.totalBytes -= previous.bytes;
    this.entries.delete(id);
    this.entries.set(id, {
      owner,
      value: cloned,
      touchedAt: Date.now(),
      bytes
    });
    this.totalBytes += bytes;
    this.evictOverflow();
  }

  private serializedBytes(value: StoredResponse): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (now - entry.touchedAt <= this.ttlMs) continue;
      this.entries.delete(id);
      this.totalBytes -= entry.bytes;
    }
  }

  private evictOverflow(): void {
    while (
      this.entries.size > this.maxEntries ||
      this.totalBytes > this.maxBytes
    ) {
      const first = this.entries.keys().next().value;
      if (first === undefined) break;
      const entry = this.entries.get(first);
      this.entries.delete(first);
      if (entry) this.totalBytes -= entry.bytes;
    }
  }
}

