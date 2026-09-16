import { serve, type ServerType } from "@hono/node-server";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";

import { isLoopbackHost, loadConfig } from "./config.js";
import { createGatewayDeps, type GatewayDeps } from "./deps.js";
import { appError, adminAuthorized, readJsonRecord, requestCredential, sendError, sendJson, sendWebUi } from "./http-utils.js";
import type { GatewayContext, GatewayEnv } from "./http-types.js";
import type { ApiKeyIdentity, ApiKeyStore } from "./key-store.js";
import {
  MetricsStore,
  parseDuration,
  type MetricAdmission
} from "./metrics.js";
import { modelsResponse } from "./openai.js";
import { handleChat, handleResponses } from "./protocol-handlers.js";

function authenticateRequest(c: Context, apiKeys: ApiKeyStore): ApiKeyIdentity | null {
  const credential = requestCredential(c);
  if (!apiKeys.requiresAuthentication()) return apiKeys.anonymous();
  return apiKeys.authenticate(credential);
}

function metricScope(identity: ApiKeyIdentity): string | undefined {
  return identity.source === "managed" ? identity.keyId : undefined;
}

function admissionProtocol(
  method: string,
  path: string
): "chat" | "responses" | null {
  if (method !== "POST") return null;
  if (path === "/v1/responses") return "responses";
  if (path === "/v1/chat/completions") return "chat";
  return null;
}

function createGatewayAuth(deps: GatewayDeps): MiddlewareHandler<GatewayEnv> {
  return async (c, next) => {
    const protocol = admissionProtocol(c.req.method, c.req.path);
    const admission = protocol
      ? deps.metrics.beginAdmission(protocol)
      : undefined;
    c.set("admission", admission);
    const identity = authenticateRequest(c, deps.apiKeys);
    if (!identity) {
      deps.metrics.finishAdmission(admission, "unknown", {
        status: "error",
        errorType: "authentication_error"
      });
      if (admission) c.header("X-Request-ID", admission.id);
      return sendError(c, 401, "缺少或无效的代理 API Key", "authentication_error");
    }

    if (
      identity.source === "anonymous" &&
      !isLoopbackHost(deps.config.bindHost)
    ) {
      deps.metrics.finishAdmission(admission, "unknown", {
        status: "error",
        errorType: "configuration_error"
      });
      if (admission) c.header("X-Request-ID", admission.id);
      return sendError(
        c,
        503,
        "非本地监听必须配置 PROXY_API_KEY 或虚拟 API Key",
        "configuration_error"
      );
    }

    c.set("identity", identity);
    if (admission) admission.apiKeyId = identity.keyId;
    await next();
  };
}

function createAdminAuth(deps: GatewayDeps): MiddlewareHandler<GatewayEnv> {
  const adminKey = deps.config.adminKey || (
    isLoopbackHost(deps.config.bindHost) ? deps.config.apiKey : ""
  );
  return async (c, next) => {
    if (!adminKey && !isLoopbackHost(deps.config.bindHost)) {
      return sendError(
        c,
        503,
        "非本地监听必须配置 PROXY_ADMIN_KEY",
        "configuration_error"
      );
    }
    if (!adminAuthorized(c, adminKey)) {
      return sendError(c, 401, "缺少或无效的管理员 API Key", "authentication_error");
    }
    await next();
  };
}

function identityOf(c: GatewayContext): ApiKeyIdentity {
  return c.get("identity");
}

function admissionOf(c: GatewayContext): MetricAdmission | undefined {
  return c.get("admission");
}

type MetricScopeResolver = (c: GatewayContext) => string | undefined;

function registerMetricsRoutes(
  app: Hono<GatewayEnv>,
  metrics: MetricsStore,
  prefix: string,
  resolveScope: MetricScopeResolver
): void {
  const defaultWindowMs = 24 * 60 * 60 * 1000;

  app.get(`${prefix}/summary`, (c) => sendJson(c, 200, metrics.summary(
    parseDuration(c.req.query("window"), defaultWindowMs),
    resolveScope(c)
  )));

  app.get(`${prefix}/timeseries`, (c) => {
    const windowMs = parseDuration(c.req.query("window"), defaultWindowMs);
    const bucketValue = c.req.query("bucket");
    const bucketMs = bucketValue ? parseDuration(bucketValue, 0) : undefined;
    return sendJson(c, 200, metrics.timeseries(
      windowMs,
      bucketMs,
      resolveScope(c)
    ));
  });

  app.get(`${prefix}/requests`, (c) => {
    const statusValue = c.req.query("status");
    const status = statusValue === "success" ||
      statusValue === "error" ||
      statusValue === "canceled"
      ? statusValue
      : undefined;
    return sendJson(c, 200, metrics.recent({
      windowMs: parseDuration(c.req.query("window"), defaultWindowMs),
      limit: Number(c.req.query("limit")) || 50,
      provider: c.req.query("provider") || undefined,
      model: c.req.query("model") || undefined,
      status,
      apiKeyId: resolveScope(c)
    }));
  });

  app.get(`${prefix}/models`, (c) => sendJson(c, 200, metrics.models(
    parseDuration(c.req.query("window"), defaultWindowMs),
    resolveScope(c)
  )));
}

function registerAdminRoutes(app: Hono<GatewayEnv>, deps: GatewayDeps): void {
  const { config, channels, catalog, apiKeys, metrics } = deps;
  registerMetricsRoutes(app, metrics, "/admin/metrics", () => undefined);

  app.get("/admin/channels", (c) => sendJson(c, 200, {
    object: "llm-gateway.channels",
    data: channels.list()
  }));

  app.post("/admin/channels", async (c) => {
    const body = await readJsonRecord(c, config.maxBodyBytes);
    try {
      const channel = channels.upsert(body);
      catalog.clear();
      return sendJson(c, 200, { object: "llm-gateway.channel", data: channel });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendError(c, 400, message, "invalid_request_error");
    }
  });

  app.delete("/admin/channels/:id", (c) => {
    const id = c.req.param("id");
    const removed = channels.remove(id);
    if (!removed) return sendError(c, 404, "渠道不存在", "invalid_request_error");
    catalog.clear();
    return sendJson(c, 200, { object: "llm-gateway.channel.deleted", id });
  });

  app.get("/admin/keys", (c) => sendJson(c, 200, {
    object: "llm-gateway.api_keys",
    data: apiKeys.list()
  }));

  app.post("/admin/keys", async (c) => {
    const body = await readJsonRecord(c, config.maxBodyBytes);
    try {
      const created = apiKeys.create(body);
      return sendJson(c, 201, {
        object: "llm-gateway.api_key",
        data: created.record,
        secret: created.secret,
        warning: "secret 只在本次响应中返回，请立即保存"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return sendError(c, 400, message, "invalid_request_error");
    }
  });

  app.patch("/admin/keys/:id", async (c) => {
    const body = await readJsonRecord(c, config.maxBodyBytes);
    const id = c.req.param("id");
    const updated = apiKeys.update(id, body);
    if (!updated) return sendError(c, 404, "API Key 不存在", "invalid_request_error");
    return sendJson(c, 200, { object: "llm-gateway.api_key", data: updated });
  });

  app.delete("/admin/keys/:id", (c) => {
    const id = c.req.param("id");
    const revoked = apiKeys.revoke(id);
    if (!revoked) return sendError(c, 404, "API Key 不存在", "invalid_request_error");
    return sendJson(c, 200, { object: "llm-gateway.api_key.revoked", id });
  });

  app.all("/admin/*", (c) => sendError(c, 404, "管理接口不存在", "invalid_request_error"));
}

function registerPublicRoutes(app: Hono<GatewayEnv>, deps: GatewayDeps): void {
  const { authStore, catalog, apiKeys, metrics } = deps;
  const live = (c: Context): Response => sendJson(c, 200, {
    status: "ok",
    service: "llm-gateway",
    mode: "live",
    providers: deps.providers.list().map((provider) => provider.id)
  });
  for (const path of ["/", "/health", "/health/live"]) app.get(path, live);
  for (const path of ["/ui", "/ui/", "/ui/index.html"]) {
    app.get(path, (c) => sendWebUi(c));
  }

  app.get("/health/ready", async (c) => {
    const auth = authStore.status(deps.providers.list().map((provider) => provider.id));
    const models = await catalog.get();
    const ready = auth.ready && models.length > 0;
    return sendJson(c, ready ? 200 : 503, {
      status: ready ? "ok" : "not_ready",
      service: "llm-gateway",
      mode: "ready",
      authenticated: auth.ready,
      models: models.length,
      providers: auth.providers
    });
  });

  app.get("/health/auth", (c) => sendJson(
    c,
    200,
    authStore.status(deps.providers.list().map((provider) => provider.id))
  ));

  app.get("/.well-known/llm-gateway/capabilities", async (c) => {
    const auth = authStore.status(deps.providers.list().map((provider) => provider.id));
    const models = modelsResponse(await catalog.get());
    return sendJson(c, 200, {
      object: "llm-gateway.capabilities",
      version: 1,
      service: "llm-gateway",
      authRequired: apiKeys.requiresAuthentication(),
      protocols: {
        chatCompletions: {
          path: "/v1/chat/completions",
          stream: true,
          tools: true,
          reasoningContent: true,
          usageChunk: true,
          developerRole: false
        },
        responses: {
          path: "/v1/responses",
          stream: true,
          reasoningText: true,
          functionCalls: true,
          structuredOutputs: true,
          previousResponseId: "process"
        }
      },
      providers: deps.providers.list().map((provider) => ({
        id: provider.id,
        name: provider.name,
        authenticated: auth.providers[provider.id]?.ready === true
      })),
      models: models.data
    });
  });

  registerMetricsRoutes(
    app,
    metrics,
    "/metrics",
    (c) => metricScope(identityOf(c))
  );

  app.get("/v1/models", async (c) => sendJson(
    c,
    200,
    modelsResponse(await catalog.get())
  ));

  app.post("/v1/responses", (c) => handleResponses(deps, c, identityOf(c), admissionOf(c)));
  app.post("/v1/chat/completions", (c) => handleChat(deps, c, identityOf(c), admissionOf(c)));
}

export function createGatewayApp(
  deps: GatewayDeps = createGatewayDeps(loadConfig())
): Hono<GatewayEnv> {
  const { config } = deps;
  const app = new Hono<GatewayEnv>();
  app.use("*", cors({
    origin: config.corsOrigin,
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Authorization", "Content-Type", "X-API-Key"],
    exposeHeaders: ["X-Request-ID"]
  }));
  app.options("*", (c) => c.body(null, 204));
  app.use("/admin", createAdminAuth(deps));
  app.use("/admin/*", createAdminAuth(deps));
  const gatewayAuth = createGatewayAuth(deps);
  app.use("/v1/*", gatewayAuth);
  app.use("/metrics/*", gatewayAuth);

  registerAdminRoutes(app, deps);
  registerPublicRoutes(app, deps);

  app.onError((error, c) => {
    const failure = appError(error);
    return sendError(c, failure.status, failure.message, failure.type);
  });
  app.notFound((c) => sendError(c, 404, "Not found", "invalid_request_error"));
  return app;
}

let gatewayServer: ServerType | null = null;

export function startGateway(
  deps: GatewayDeps = createGatewayDeps(loadConfig())
): ServerType {
  if (gatewayServer) return gatewayServer;

  const { config } = deps;
  const app = createGatewayApp(deps);
  const server = serve(
    {
      fetch: app.fetch,
      hostname: config.bindHost,
      port: config.port
    },
    () => {
      console.log(
        `LLM Gateway 已启动: http://${config.bindHost}:${config.port}`
      );
      console.log(
        `- Chat Completions 接口: http://${config.bindHost}:${config.port}/v1/chat/completions`
      );
      console.log(
        `- Responses 接口: http://${config.bindHost}:${config.port}/v1/responses`
      );
      console.log(`- 模型列表: http://${config.bindHost}:${config.port}/v1/models`);
      console.log(`- Web 控制台: http://${config.bindHost}:${config.port}/ui`);
    }
  );

  server.on("error", (error) => {
    console.error("LLM Gateway 服务错误:", error.message);
  });
  server.on("close", () => {
    deps.apiKeys.flush();
    deps.metrics.flush();
    if (gatewayServer === server) gatewayServer = null;
  });
  gatewayServer = server;
  return server;
}
