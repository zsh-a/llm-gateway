import { AuthStore } from "./auth-store.js";
import { ChannelStore } from "./channels.js";
import type { GatewayConfig } from "./config.js";
import { ApiKeyStore } from "./key-store.js";
import { MetricsStore } from "./metrics.js";
import { ModelRouter } from "./model-router.js";
import { ModelCatalog } from "./models.js";
import { defaultProviderRegistry, type ProviderRegistry } from "./provider.js";
import { InMemoryResponseStore, type ResponseStore } from "./response-store.js";

/** All process-scoped gateway services. Construct once at the composition root. */
export interface GatewayDeps {
  config: GatewayConfig;
  providers: ProviderRegistry;
  authStore: AuthStore;
  channels: ChannelStore;
  catalog: ModelCatalog;
  router: ModelRouter;
  apiKeys: ApiKeyStore;
  metrics: MetricsStore;
  responseStore: ResponseStore;
}

export function createGatewayDeps(config: GatewayConfig): GatewayDeps {
  const providers = defaultProviderRegistry;
  const authStore = new AuthStore(config.authCacheDir);
  const channels = new ChannelStore(config.channelsFile, providers);
  const catalog = new ModelCatalog(config, { authStore, channels, providers });
  return {
    config,
    providers,
    authStore,
    channels,
    catalog,
    router: new ModelRouter(catalog, channels, providers),
    apiKeys: new ApiKeyStore(config.apiKeysFile, config.apiKey),
    metrics: new MetricsStore(config.metricsMaxRecords, config.metricsFile),
    responseStore: new InMemoryResponseStore(
      config.responseStoreMaxEntries,
      config.responseStoreTtlMs,
      config.responseStoreMaxBytes
    )
  };
}
