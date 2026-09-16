import { AuthStore } from "./auth-store.js";
import { ChannelStore } from "./channels.js";
import type { GatewayConfig } from "./config.js";
import { ApiKeyStore } from "./key-store.js";
import { MetricsStore } from "./metrics.js";
import { ModelCatalog } from "./models.js";

/** All process-scoped gateway services. Construct once at the composition root. */
export interface GatewayDeps {
  config: GatewayConfig;
  authStore: AuthStore;
  channels: ChannelStore;
  catalog: ModelCatalog;
  apiKeys: ApiKeyStore;
  metrics: MetricsStore;
}

export function createGatewayDeps(config: GatewayConfig): GatewayDeps {
  const authStore = new AuthStore(config.authCacheDir);
  const channels = new ChannelStore(config.channelsFile);
  return {
    config,
    authStore,
    channels,
    catalog: new ModelCatalog(config, { authStore, channels }),
    apiKeys: new ApiKeyStore(config.apiKeysFile, config.apiKey),
    metrics: new MetricsStore(config.metricsMaxRecords, config.metricsFile)
  };
}
