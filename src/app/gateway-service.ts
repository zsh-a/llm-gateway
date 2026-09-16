import type { AuthStore } from "../auth/auth-store.js";
import type { GatewayConfig } from "./config.js";
import { GatewayError } from "./errors.js";
import type { ApiKeyIdentity, ApiKeyStore } from "../auth/api-key-store.js";
import type { ModelRouter, ModelRoute } from "../routing/model-router.js";
import { validateModelRequest } from "../routing/capabilities.js";
import type { ResponseNormalizationContext } from "../protocols/responses/index.js";
import type { ResponseStore } from "../infrastructure/response-store.js";
import type { JsonRecord, NormalizedChatRequest } from "../domain/types.js";

export interface PreparedRequest {
  route: ModelRoute;
  request: NormalizedChatRequest;
  identity: ApiKeyIdentity;
}

export type RequestNormalizer = (
  value: unknown,
  defaultModel?: string,
  context?: ResponseNormalizationContext
) => NormalizedChatRequest;

export type RequestValidator = (request: NormalizedChatRequest) => string | null;

export interface GatewayRequestDeps {
  config: GatewayConfig;
  authStore: AuthStore;
  router: ModelRouter;
  apiKeys: ApiKeyStore;
  responseStore: ResponseStore;
}

/** Protocol-independent request admission and route preparation. */
export async function prepareGatewayRequest(
  deps: GatewayRequestDeps,
  value: JsonRecord,
  normalize: RequestNormalizer,
  validate: RequestValidator,
  identity: ApiKeyIdentity
): Promise<PreparedRequest> {
  let request: NormalizedChatRequest;
  try {
    request = normalize(value, deps.config.defaultModel, {
      responseStore: deps.responseStore,
      owner: identity.keyId
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GatewayError(400, "invalid_request_error", message);
  }

  const validationError = validate(request);
  if (validationError) {
    throw new GatewayError(
      400,
      "invalid_request_error",
      validationError,
      request.model
    );
  }

  const route = await deps.router.resolve(request.model);
  if (!route) {
    throw new GatewayError(
      400,
      "invalid_request_error",
      request.model
        ? "未找到模型 " + request.model + "，请先请求 /v1/models"
        : "请求必须包含 model",
      request.model
    );
  }

  const modelValidationError = validateModelRequest(request, route.model);
  if (modelValidationError) {
    throw new GatewayError(
      400,
      "invalid_request_error",
      modelValidationError,
      route.publicModel
    );
  }

  const modelAccessError = deps.apiKeys.authorizeModel(
    identity,
    request.model || route.publicModel
  );
  if (modelAccessError) {
    throw new GatewayError(403, "permission_error", modelAccessError, route.publicModel);
  }

  const hasAuth = route.candidates.some((candidate) => (
    deps.authStore.get(candidate.channel.authRef) !== null
  ));
  if (!hasAuth) {
    throw new GatewayError(
      503,
      "auth_error",
      "未找到 " + route.provider.name + " 渠道 " + route.channel.id +
        " 认证，请先执行 npm run auth -- --provider " + route.provider.id,
      route.publicModel
    );
  }

  const reservationError = deps.apiKeys.reserve(identity);
  if (reservationError) {
    throw new GatewayError(429, "rate_limit_error", reservationError, route.publicModel);
  }

  return {
    route,
    identity,
    request: {
      ...request,
      model: route.upstreamModel,
      modelDescriptor: route.model
    }
  };
}
