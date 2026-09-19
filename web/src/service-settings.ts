import { invoke } from "@tauri-apps/api/core";

export interface ServiceSettings {
  host: string;
  port: number;
}

export function serviceBaseUrl(settings: ServiceSettings): string {
  let host = settings.host.trim();
  if (["0.0.0.0", "::", "[::]"].includes(host)) host = "127.0.0.1";
  if (host.includes(":") && !host.startsWith("[")) host = `[${host}]`;
  return `http://${host}:${settings.port}`;
}

export function getServiceSettings(): Promise<ServiceSettings> {
  return invoke<ServiceSettings>("get_service_settings");
}

export function saveServiceSettings(settings: ServiceSettings): Promise<void> {
  return invoke<void>("save_service_settings", { settings });
}
