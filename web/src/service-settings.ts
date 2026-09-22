import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface ServiceSettings {
  host: string;
  port: number;
  corsOrigin: string;
}

export interface ServiceStatus {
  phase: "starting" | "running" | "stopping" | "stopped" | "failed";
  baseUrl: string;
  activeRequests: number;
  error: string | null;
  canForceExit: boolean;
}

export function getServiceStatus(): Promise<ServiceStatus> {
  return invoke<ServiceStatus>("get_service_status");
}

export function controlService(action: "start" | "stop" | "restart"): Promise<void> {
  return invoke<void>("control_service", { action });
}

export function forceQuit(): Promise<void> {
  return invoke<void>("force_quit");
}

export function listenServiceStatus(
  callback: (status: ServiceStatus) => void,
): Promise<UnlistenFn> {
  return listen<ServiceStatus>("gateway-service-status", (event) => callback(event.payload));
}

export function getServiceSettings(): Promise<ServiceSettings> {
  return invoke<ServiceSettings>("get_service_settings");
}

export function saveServiceSettings(settings: ServiceSettings): Promise<void> {
  return invoke<void>("save_service_settings", { settings });
}
