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
  resource: (baseUrl: string, resource: string) => ["gateway", baseUrl, resource] as const,
  metric: (baseUrl: string, resource: string, query: MetricsQuery) =>
    ["gateway", baseUrl, "metrics", resource, query] as const,
};

export function queryErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === "string" && error.trim()) return error;
  if (error && typeof error === "object") {
    const value = error as Record<string, unknown>;
    if (typeof value.message === "string" && value.message.trim()) return value.message;
    if (typeof value.error === "string" && value.error.trim()) return value.error;
    if (value.error && typeof value.error === "object")
      return queryErrorMessage(value.error, fallback);
  }
  return fallback;
}
