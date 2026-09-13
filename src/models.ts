import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from "node:fs";
import { dirname } from "node:path";

import { getAuth, invalidateAuth, type AuthHeaders } from "./auth.js";
import { FALLBACK_MODEL_IDS, type AppConfig } from "./config.js";

type ModelSource = "remote" | "cache" | "fallback";

interface ModelSnapshot {
  ids: string[];
  source: ModelSource;
  loadedAt: number;
}

interface StoredModels {
  version: 1;
  ids: string[];
  fetchedAt: number;
}

function asRecord(value: unknown): { [key: string]: unknown } {
  return value !== null && typeof value === "object"
    ? value as { [key: string]: unknown }
    : {};
}

function modelId(value: unknown): string {
  if (typeof value === "string") return value.trim();

  const record = asRecord(value);
  for (const key of ["id", "modelName", "model"]) {
    if (typeof record[key] === "string" && record[key].trim()) {
      return record[key].trim();
    }
  }
  return "";
}

function uniqueIds(values: unknown[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const id = modelId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function extractModelIds(value: unknown): string[] {
  const root = asRecord(value);
  if (root.code !== undefined && Number(root.code) !== 0) return [];

  const data = root.data;
  if (Array.isArray(data)) return uniqueIds(data);

  const dataRecord = asRecord(data);
  if (Array.isArray(dataRecord.models)) {
    return uniqueIds(dataRecord.models);
  }

  if (Array.isArray(dataRecord.groups)) {
    const values: unknown[] = [];
    for (const group of dataRecord.groups) {
      const models = asRecord(group).models;
      if (Array.isArray(models)) values.push(...models);
    }
    return uniqueIds(values);
  }

  return [];
}

function snapshot(ids: string[], source: ModelSource): ModelSnapshot {
  return { ids, source, loadedAt: Date.now() };
}

function readCachedModels(file: string): string[] {
  try {
    if (!existsSync(file)) return [];

    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    const record = asRecord(value);
    if (Number(record.version) !== 1 || !Array.isArray(record.ids)) return [];
    return uniqueIds(record.ids);
  } catch {
    return [];
  }
}

function writeCachedModels(file: string, ids: string[]): void {
  const stored: StoredModels = {
    version: 1,
    ids,
    fetchedAt: Date.now()
  };

  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(stored)}\n`);
    chmodSync(file, 0o600);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`无法保存模型列表缓存 ${file}: ${message}`);
  }
}

class ModelManager {
  private memory: ModelSnapshot | null = null;
  private loading: Promise<ModelSnapshot> | null = null;

  constructor(private readonly config: AppConfig) {}

  async get(): Promise<string[]> {
    if (
      this.memory &&
      Date.now() - this.memory.loadedAt < this.config.modelCacheTtlMs
    ) {
      return this.memory.ids;
    }

    if (this.loading) return (await this.loading).ids;

    this.loading = this.load();
    try {
      this.memory = await this.loading;
      return this.memory.ids;
    } finally {
      this.loading = null;
    }
  }

  private async load(): Promise<ModelSnapshot> {
    if (this.config.modelDiscoveryEnabled) {
      const remote = await this.fetchRemote();
      if (remote.length > 0) {
        writeCachedModels(this.config.modelCacheFile, remote);
        return snapshot(remote, "remote");
      }
    }

    const cached = readCachedModels(this.config.modelCacheFile);
    if (cached.length > 0) return snapshot(cached, "cache");

    return snapshot([...FALLBACK_MODEL_IDS], "fallback");
  }

  private async fetchRemote(): Promise<string[]> {
    let auth: AuthHeaders | null = this.config.modelApiKey
      ? { "api-key": this.config.modelApiKey }
      : null;

    if (!auth) {
      try {
        auth = await getAuth(this.config);
      } catch {
        return [];
      }
      if (!auth) return [];
    }

    try {
      const response = await fetch(this.config.modelListUrl, {
        headers: {
          ...auth,
          accept: "application/json"
        }
      });

      if (response.status === 401 || response.status === 403) {
        invalidateAuth(this.config);
        return [];
      }
      if (!response.ok) return [];
      return extractModelIds(await response.json());
    } catch {
      return [];
    }
  }
}

let defaultManager: ModelManager | null = null;
let defaultConfig: AppConfig | null = null;

function managerFor(config: AppConfig): ModelManager {
  if (!defaultManager || defaultConfig !== config) {
    defaultConfig = config;
    defaultManager = new ModelManager(config);
  }
  return defaultManager;
}

export async function getModelIds(config: AppConfig): Promise<string[]> {
  return managerFor(config).get();
}
