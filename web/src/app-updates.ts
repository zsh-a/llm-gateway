import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface UpdateStatus {
  phase:
    | "idle"
    | "checking"
    | "up_to_date"
    | "available"
    | "downloading"
    | "ready"
    | "draining"
    | "stopping"
    | "installing";
  currentVersion: string;
  version: string | null;
  notes: string | null;
  downloadedBytes: number;
  totalBytes: number | null;
  lastChecked: number | null;
  error: string | null;
}

export type UpdateAction = "check_for_updates" | "download_update" | "install_update";

export function getUpdateStatus(): Promise<UpdateStatus> {
  return invoke("get_update_status");
}

export function runUpdateAction(action: UpdateAction): Promise<void> {
  return invoke(action);
}

export function cancelUpdate(): Promise<void> {
  return invoke("cancel_update");
}

export function listenUpdateStatus(callback: (status: UpdateStatus) => void): Promise<UnlistenFn> {
  return listen<UpdateStatus>("app-update-status", ({ payload }) => callback(payload));
}
