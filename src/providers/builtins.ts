import type { JsonRecord, ModelDescriptor, NormalizedChatRequest } from "../domain/types.js";
import { baseRequestBody, OpenAICompatibleProvider } from "./openai-compatible.js";
import type { ProviderAdapter } from "./contracts.js";

function mimoRequestBody(request: NormalizedChatRequest): JsonRecord {
  const body = baseRequestBody(request);

  if (body.max_tokens !== undefined && body.max_completion_tokens === undefined) {
    body.max_completion_tokens = body.max_tokens;
    delete body.max_tokens;
  }

  if (
    request.modelDescriptor?.capabilities?.reasoning === false &&
    !request.reasoningEffortExplicit
  ) {
    delete body.reasoning_effort;
    delete body.thinking;
    return body;
  }

  if (request.effort === "none") {
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
  } else {
    body.reasoning_effort = request.effort;
  }

  return body;
}

function workbuddyRequestBody(request: NormalizedChatRequest): JsonRecord {
  const body = baseRequestBody(request);

  if (request.effort === "none") {
    body.thinking = { type: "disabled" };
    delete body.reasoning_effort;
  } else if (
    request.reasoningEffortExplicit ||
    request.effort !== "medium"
  ) {
    body.reasoning_effort = request.effort;
  }
  return body;
}

const MIMO_REASONING_EFFORTS = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max"
};

function mimoModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const id = model.id.toLowerCase();
  if (/(asr|tts|seedream|image|voiceclone|voicedesign|audio)/.test(id)) {
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        chat: false,
        reasoning: false
      }
    };
  }
  if (!id.startsWith("mimo-x-")) {
    return {
      ...model,
      capabilities: { ...model.capabilities, chat: true }
    };
  }

  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      chat: true,
      reasoning: true
    },
    reasoningEfforts: model.reasoningEfforts ?? { ...MIMO_REASONING_EFFORTS },
    defaultReasoningEffort: model.defaultReasoningEffort ?? "medium"
  };
}

function workbuddyModelDescriptor(model: ModelDescriptor): ModelDescriptor {
  const id = model.id.toLowerCase();
  if (/(image|kling|tts|asr|audio|voice)/.test(id)) {
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        chat: false,
        reasoning: false
      }
    };
  }
  return {
    ...model,
    capabilities: { ...model.capabilities, chat: true }
  };
}

function macApplicationBinaries(
  application: string,
  executables: string[]
): string[] {
  if (process.platform !== "darwin") return [];

  const roots = [
    "/Applications",
    process.env.HOME ? process.env.HOME + "/Applications" : ""
  ].filter(Boolean);

  return roots.flatMap((root) => executables.map((executable) => (
    root + "/" + application + ".app/Contents/MacOS/" + executable
  )));
}

export const defaultProviders: ProviderAdapter[] = [
  new OpenAICompatibleProvider({
    id: "mimo",
    name: "MiMo",
    upstreamUrl: "https://mimo-server-cn.xiaomimimo.com/api/route/chat/completions",
    modelListUrl: "https://mimo-server-cn.xiaomimimo.com/api/model/list",
    modelFile: "",
    fallbackModelIds: ["mimo-x-pro-preview", "mimo-pro", "mimo-flash"],
    authHosts: ["mimo-server-cn.xiaomimimo.com"],
    authPaths: ["/api/route/chat/completions"],
    authMethods: ["POST"],
    captureHeaders: ["cookie", "authorization", "x-*"],
    clientCandidates: macApplicationBinaries("Xiaomi MiMo", ["Xiaomi MiMo", "Electron"]),
    buildBody: mimoRequestBody,
    describeModel: mimoModelDescriptor
  }),
  new OpenAICompatibleProvider({
    id: "workbuddy",
    name: "WorkBuddy",
    upstreamUrl: "https://copilot.tencent.com/v2/chat/completions",
    modelListUrl: "",
    modelFile: "",
    fallbackModelIds: ["default"],
    authHosts: ["copilot.tencent.com"],
    authPaths: ["/v3/config", "/v2/report", "/v2/chat/completions"],
    authMethods: ["GET", "POST"],
    captureHeaders: ["cookie", "authorization", "x-*"],
    clientCandidates: macApplicationBinaries("WorkBuddy", ["Electron", "WorkBuddy"]),
    buildBody: workbuddyRequestBody,
    describeModel: workbuddyModelDescriptor
  })
];
