import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./platform";

export interface RemoteSyncSettings {
  url: string;
  token: string;
  vaultId: string;
}

export interface RemoteSyncDraft extends RemoteSyncSettings {}

export interface RemoteSyncStatus {
  vaultId: string;
  exists: boolean;
  revision?: number;
  updatedAt?: number;
  localRevision?: number;
  localProviders: string[];
}

export interface RemoteSyncPullResult {
  vaultId: string;
  revision: number;
  updatedAt: number;
  providers: string[];
  workbuddyModelCount?: number;
}

const URL_KEY = "llm-gateway.sync-url";
const TOKEN_KEY = "llm-gateway.sync-token";
const VAULT_KEY = "llm-gateway.sync-vault-id";

function configuredSyncUrl(): string {
  return (import.meta.env.VITE_SYNC_URL ?? import.meta.env.SYNC_URL ?? "")
    .trim()
    .replace(/\/+$/, "");
}

function readStorage(storage: Storage, key: string): string {
  try {
    return storage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeStorage(storage: Storage, key: string, value: string): void {
  try {
    if (value) storage.setItem(key, value);
    else storage.removeItem(key);
  } catch {
    // Storage is optional; the native command still receives the current form values.
  }
}

export function loadRemoteSyncDraft(): RemoteSyncDraft {
  return {
    url: readStorage(localStorage, URL_KEY) || configuredSyncUrl(),
    token: readStorage(sessionStorage, TOKEN_KEY),
    vaultId: readStorage(localStorage, VAULT_KEY) || "default",
  };
}

export function saveRemoteSyncDraft(settings: RemoteSyncSettings): void {
  writeStorage(localStorage, URL_KEY, settings.url);
  writeStorage(sessionStorage, TOKEN_KEY, settings.token);
  writeStorage(localStorage, VAULT_KEY, settings.vaultId || "default");
}

function requireTauri(): void {
  if (!isTauriRuntime()) {
    throw new Error("远端认证拉取仅支持 Tauri 桌面应用");
  }
}

export async function remoteSyncStatus(settings: RemoteSyncSettings): Promise<RemoteSyncStatus> {
  requireTauri();
  return invoke<RemoteSyncStatus>("remote_sync_status", { settings });
}

export async function remoteSyncPull(
  settings: RemoteSyncSettings,
  passphrase: string,
  force: boolean,
): Promise<RemoteSyncPullResult> {
  requireTauri();
  return invoke<RemoteSyncPullResult>("remote_sync_pull", {
    settings,
    passphrase,
    force,
  });
}
