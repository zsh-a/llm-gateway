import { invoke } from "@tauri-apps/api/core";
import type { ApiKeyInput, ApiKeyUpdate, ChannelInput, MetricsQuery } from "./types";

export type ManagementRequest =
  | { operation: "list_channels" | "list_keys" | "models" }
  | { operation: "save_channel"; body: ChannelInput }
  | { operation: "delete_channel" | "revoke_key"; id: string }
  | { operation: "create_key"; body: ApiKeyInput }
  | { operation: "update_key"; id: string; body: ApiKeyUpdate }
  | { operation: "metrics"; view: "summary" | "timeseries" | "requests"; query: MetricsQuery };

export type ManagementTransport = (request: ManagementRequest) => Promise<{
  status: number;
  body: Record<string, unknown>;
}>;

export const nativeManagement: ManagementTransport = async (request) => {
  try {
    return await invoke("management_request", { request });
  } catch (error) {
    throw error instanceof Error ? error : new Error(String(error));
  }
};
