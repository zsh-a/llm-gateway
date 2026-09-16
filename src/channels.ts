import { readJsonFile, writeJsonFileAtomic } from "./file-store.js";
import { asBool, asNumber, asRecord, asTrimmedString } from "./json.js";
import {
  defaultProviderRegistry,
  type ProviderRegistry
} from "./provider.js";

export interface ChannelConfig {
  id: string;
  name: string;
  providerId: string;
  authRef: string;
  upstreamUrl?: string;
  enabled: boolean;
  priority: number;
  weight: number;
  modelMappings: { [key: string]: string };
}

export interface ChannelSelection {
  channel: ChannelConfig;
  upstreamModel: string;
}

interface StoredChannels {
  version: 1;
  channels: ChannelConfig[];
}

const MAX_CURSOR_KEYS = 1024;

function integerValue(value: unknown, fallback: number, minimum: number): number {
  const number = asNumber(value);
  return number !== undefined && Number.isInteger(number) && number >= minimum
    ? number
    : fallback;
}

function modelMappings(value: unknown): { [key: string]: string } {
  const record = asRecord(value);
  const result: { [key: string]: string } = {};
  for (const [key, model] of Object.entries(record)) {
    const normalizedKey = key.trim();
    const normalizedModel = asTrimmedString(model) ?? "";
    if (normalizedKey && normalizedModel) result[normalizedKey] = normalizedModel;
  }
  return result;
}

function defaultChannels(registry: ProviderRegistry): ChannelConfig[] {
  return registry.list().map((provider) => ({
    id: `${provider.id}-default`,
    name: `${provider.name} 默认渠道`,
    providerId: provider.id,
    authRef: provider.id,
    enabled: true,
    priority: 100,
    weight: 1,
    modelMappings: {}
  }));
}

function normalizeChannel(
  value: unknown,
  current: ChannelConfig | undefined,
  registry: ProviderRegistry
): ChannelConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = asRecord(value);
  const id = asTrimmedString(record.id) || current?.id || "";
  const providerId = asTrimmedString(record.providerId) ||
    current?.providerId || "";
  const provider = registry.get(providerId);
  if (!id || !provider) return null;

  const rawUrl = asTrimmedString(record.upstreamUrl) ?? "";
  let upstreamUrl: string | undefined;
  if (rawUrl) {
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      upstreamUrl = rawUrl.replace(/\/$/, "");
    } catch {
      return null;
    }
  }

  const mergedMappings = record.modelMappings ?? current?.modelMappings;
  const result: ChannelConfig = {
    id,
    name: asTrimmedString(record.name) || current?.name || id,
    providerId,
    authRef: asTrimmedString(record.authRef) ||
      current?.authRef || (id === providerId ? providerId : id),
    enabled: asBool(record.enabled) ?? current?.enabled ?? true,
    priority: integerValue(record.priority, current?.priority ?? 100, 0),
    weight: integerValue(record.weight, current?.weight ?? 1, 1),
    modelMappings: modelMappings(mergedMappings)
  };
  if (upstreamUrl) result.upstreamUrl = upstreamUrl;
  else if (current?.upstreamUrl) result.upstreamUrl = current.upstreamUrl;
  return result;
}

function cloneChannel(channel: ChannelConfig): ChannelConfig {
  return { ...channel, modelMappings: { ...channel.modelMappings } };
}

export class ChannelStore {
  private channels: ChannelConfig[] | null = null;
  private readonly cursors = new Map<string, number>();

  constructor(
    private readonly file: string,
    private readonly registry: ProviderRegistry = defaultProviderRegistry
  ) {}

  list(): ChannelConfig[] {
    this.ensureLoaded();
    return this.channels!.map(cloneChannel);
  }

  upsert(value: unknown): ChannelConfig {
    this.ensureLoaded();
    const input = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as { [key: string]: unknown }
      : {};
    const id = asTrimmedString(input.id) ?? "";
    const current = id ? this.channels!.find((channel) => channel.id === id) : undefined;
    const channel = normalizeChannel(value, current, this.registry);
    if (!channel) {
      throw new Error("渠道配置无效：需要有效的 id 和已注册 providerId");
    }
    const index = this.channels!.findIndex((item) => item.id === channel.id);
    if (index >= 0) this.channels![index] = channel;
    else this.channels!.push(channel);
    this.persist();
    return cloneChannel(channel);
  }

  remove(id: string): boolean {
    this.ensureLoaded();
    const index = this.channels!.findIndex((channel) => channel.id === id);
    if (index < 0) return false;
    this.channels!.splice(index, 1);
    this.persist();
    return true;
  }

  select(
    providerId: string,
    publicModel: string,
    upstreamModel: string
  ): ChannelSelection | null {
    return this.selectCandidates(providerId, publicModel, upstreamModel)[0] ?? null;
  }

  selectCandidates(
    providerId: string,
    publicModel: string,
    upstreamModel: string
  ): ChannelSelection[] {
    this.ensureLoaded();
    const candidates = this.channels!
      .filter((channel) => channel.enabled && channel.providerId === providerId)
      .map((channel) => {
        const mappings = channel.modelMappings;
        const hasMappings = Object.keys(mappings).length > 0;
        const mapped = mappings[publicModel] ?? mappings[upstreamModel] ?? mappings["*"];
        if (hasMappings && !mapped) return null;
        return { channel, upstreamModel: mapped || upstreamModel };
      })
      .filter((value): value is ChannelSelection => value !== null);

    const next = this.nextCursor(`${providerId}:${publicModel}`);

    const priorities = [...new Set(candidates.map((item) => item.channel.priority))]
      .sort((left, right) => right - left);
    const ordered: ChannelSelection[] = [];
    for (let priorityIndex = 0; priorityIndex < priorities.length; priorityIndex += 1) {
      const group = candidates.filter((item) => (
        item.channel.priority === priorities[priorityIndex]
      ));
      if (priorityIndex === 0) {
        const slots: ChannelSelection[] = [];
        for (const item of group) {
          for (let index = 0; index < item.channel.weight; index += 1) {
            slots.push(item);
          }
        }
        const offset = slots.length > 0 ? next % slots.length : 0;
        for (let index = 0; index < slots.length; index += 1) {
          const item = slots[(offset + index) % slots.length];
          if (!ordered.some((current) => current.channel.id === item.channel.id)) {
            ordered.push(item);
          }
        }
      } else {
        group.sort((left, right) => right.channel.weight - left.channel.weight);
        for (const item of group) {
          if (!ordered.some((current) => current.channel.id === item.channel.id)) {
            ordered.push(item);
          }
        }
      }
    }
    return ordered.map((item) => ({
      channel: cloneChannel(item.channel),
      upstreamModel: item.upstreamModel
    }));
  }

  private nextCursor(key: string): number {
    const next = (this.cursors.get(key) ?? -1) + 1;
    // Map insertion order gives us a small, dependency-free LRU. A caller can
    // supply arbitrary model names, so cursor state must have a hard bound.
    this.cursors.delete(key);
    this.cursors.set(key, next);
    while (this.cursors.size > MAX_CURSOR_KEYS) {
      const oldest = this.cursors.keys().next().value;
      if (oldest === undefined) break;
      this.cursors.delete(oldest);
    }
    return next;
  }

  private ensureLoaded(): void {
    if (this.channels) return;
    const defaults = defaultChannels(this.registry);
    try {
      const value = readJsonFile(this.file);
      if (value === null) {
        this.channels = defaults;
        return;
      }
      const record = asRecord(value);
      if (Number(record.version) !== 1 || !Array.isArray(record.channels)) {
        this.channels = defaults;
        return;
      }
      const channels: ChannelConfig[] = [];
      for (const item of record.channels) {
        const channel = normalizeChannel(item, undefined, this.registry);
        if (channel && !channels.some((current) => current.id === channel.id)) {
          channels.push(channel);
        }
      }
      this.channels = channels;
    } catch {
      this.channels = defaults;
    }
  }

  private persist(): void {
    const stored: StoredChannels = {
      version: 1,
      channels: this.channels!.map(cloneChannel)
    };
    writeJsonFileAtomic(this.file, stored);
  }
}
