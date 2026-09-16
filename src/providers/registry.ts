import { defaultProviders } from "./builtins.js";
import type { ProviderAdapter } from "./contracts.js";

export class ProviderRegistry {
  private readonly providerMap = new Map<string, ProviderAdapter>();

  constructor(providerList: ReadonlyArray<ProviderAdapter>) {
    for (const provider of providerList) {
      if (this.providerMap.has(provider.id)) {
        throw new Error(`重复的 Provider ID: ${provider.id}`);
      }
      this.providerMap.set(provider.id, provider);
    }
  }

  list(): ProviderAdapter[] {
    return [...this.providerMap.values()];
  }

  get(id: string): ProviderAdapter | null {
    return this.providerMap.get(id) ?? null;
  }
}

export const defaultProviderRegistry = new ProviderRegistry(defaultProviders);

export function getProviders(): ProviderAdapter[] {
  return defaultProviderRegistry.list();
}

export function getProvider(id: string): ProviderAdapter | null {
  return defaultProviderRegistry.get(id);
}
