import type { Context } from "hono";

import type { ApiKeyIdentity } from "./key-store.js";
import type { MetricAdmission } from "./metrics.js";

export interface GatewayVariables {
  identity: ApiKeyIdentity;
  admission: MetricAdmission | undefined;
}

export type GatewayEnv = { Variables: GatewayVariables };
export type GatewayContext = Context<GatewayEnv>;
