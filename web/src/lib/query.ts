import { QueryClient } from "@tanstack/react-query";
import type { MetricsQuery } from "../types";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: 5 * 60 * 1000,
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 5 * 1000,
    },
    mutations: {
      retry: 0,
    },
  },
});

export const gatewayQueryKeys = {
  all: ["gateway"] as const,
  dashboard: (baseUrl: string) => ["gateway", "dashboard", baseUrl] as const,
  metrics: (baseUrl: string, query: MetricsQuery) =>
    ["gateway", "metrics", baseUrl, query] as const,
};

export function queryErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string" && value.message.trim()) return value.message;
  }
  return fallback;
}
