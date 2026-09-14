import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import type { GatewayConfig } from "./config.js";
import { getProvider, getProviders } from "./provider.js";

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

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function integerValue(value: unknown, fallback: number, minimum: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) && number >= minimum ? number : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function modelMappings(value: unknown): { [key: string]: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const result: { [key: string]: string } = {};
  for (const [key, model] of Object.entries(value as { [key: string]: unknown })) {
    const normalizedKey = key.trim();
    const normalizedModel = stringValue(model);
    if (normalizedKey && normalizedModel) result[normalizedKey] = normalizedModel;
  }
  return result;
}

function defaultChannels(): ChannelConfig[] {
  return getProviders().map((provider) => ({
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

function normalizeChannel(value: unknown, current?: ChannelConfig): ChannelConfig | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as { [key: string]: unknown };
  const id = stringValue(record.id) || current?.id || "";
  const providerId = stringValue(record.providerId ?? record.provider_id) ||
    current?.providerId || "";
  const provider = getProvider(providerId);
  if (!id || !provider) return null;

  const rawUrl = stringValue(record.upstreamUrl ?? record.baseUrl ?? record.base_url);
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

  const mergedMappings = record.modelMappings ?? record.model_mappings ??
    current?.modelMappings;
  const result: ChannelConfig = {
    id,
    name: stringValue(record.name) || current?.name || id,
    providerId,
    authRef: stringValue(record.authRef ?? record.auth_ref) ||
      current?.authRef || (id === providerId ? providerId : id),
    enabled: booleanValue(record.enabled, current?.enabled ?? true),
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

  constructor(private readonly file: string) {}

  list(): ChannelConfig[] {
    this.ensureLoaded();
    return this.channels!.map(cloneChannel);
  }

  upsert(value: unknown): ChannelConfig {
    this.ensureLoaded();
    const input = value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as { [key: string]: unknown }
      : {};
    const id = stringValue(input.id);
    const current = id ? this.channels!.find((channel) => channel.id === id) : undefined;
    const channel = normalizeChannel(value, current);
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

    const key = `${providerId}:${publicModel}`;
    const next = (this.cursors.get(key) ?? -1) + 1;
    this.cursors.set(key, next);

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

  private ensureLoaded(): void {
    if (this.channels) return;
    const defaults = defaultChannels();
    try {
      if (!existsSync(this.file)) {
        this.channels = defaults;
        return;
      }
      const value: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      const record = value !== null && typeof value === "object"
        ? value as { [key: string]: unknown }
        : {};
      if (Number(record.version) !== 1 || !Array.isArray(record.channels)) {
        this.channels = defaults;
        return;
      }
      const channels: ChannelConfig[] = [];
      for (const item of record.channels) {
        const channel = normalizeChannel(item);
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
    mkdirSync(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const stored: StoredChannels = {
      version: 1,
      channels: this.channels!.map(cloneChannel)
    };
    try {
      writeFileSync(temporary, `${JSON.stringify(stored)}\n`, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.file);
      chmodSync(this.file, 0o600);
    } finally {
      try {
        if (existsSync(temporary)) unlinkSync(temporary);
      } catch {
        // Best-effort cleanup after an atomic rename.
      }
    }
  }
}

let defaultStore: ChannelStore | null = null;
let defaultConfig: GatewayConfig | null = null;

export function getChannelStore(config: GatewayConfig): ChannelStore {
  if (!defaultStore || defaultConfig !== config) {
    defaultConfig = config;
    defaultStore = new ChannelStore(config.channelsFile);
  }
  return defaultStore;
}

export function getChannels(config: GatewayConfig): ChannelConfig[] {
  return getChannelStore(config).list();
}
