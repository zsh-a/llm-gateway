import type { ApiKeyRecord, ChannelConfig } from "../../types";

export interface ModelMappingDraft {
  id: string;
  publicModel: string;
  upstreamModel: string;
}

export interface ChannelDraft {
  id: string;
  name: string;
  providerId: string;
  authRef: string;
  upstreamUrl: string;
  priority: string;
  weight: string;
  modelMappings: ModelMappingDraft[];
}

export interface KeyDraft {
  name: string;
  allowedModels: string;
  rpmLimit: string;
  tpmLimit: string;
  quotaTokens: string;
}

export type SavingForm = "channel" | "key" | null;

export type Confirmation =
  | { kind: "channel"; item: ChannelConfig }
  | { kind: "key"; item: ApiKeyRecord };

export const initialChannel: ChannelDraft = {
  id: "",
  name: "",
  providerId: "",
  authRef: "",
  upstreamUrl: "",
  priority: "100",
  weight: "1",
  modelMappings: [],
};

export const initialKey: KeyDraft = {
  name: "",
  allowedModels: "",
  rpmLimit: "",
  tpmLimit: "",
  quotaTokens: "",
};

export function channelDraftFrom(item: ChannelConfig): ChannelDraft {
  return {
    id: item.id,
    name: item.name ?? "",
    providerId: item.providerId,
    authRef: item.authRef,
    upstreamUrl: item.upstreamUrl ?? "",
    priority: String(item.priority ?? 100),
    weight: String(item.weight ?? 1),
    modelMappings: Object.entries(item.modelMappings ?? {}).map(
      ([publicModel, upstreamModel], index) => ({
        id: `${publicModel}-${index}`,
        publicModel,
        upstreamModel,
      }),
    ),
  };
}

export function keyDraftFrom(item: ApiKeyRecord): KeyDraft {
  return {
    name: item.name,
    allowedModels: item.allowedModels.join(", "),
    rpmLimit: item.rpmLimit === null ? "" : String(item.rpmLimit),
    tpmLimit: item.tpmLimit === null ? "" : String(item.tpmLimit),
    quotaTokens: item.quotaTokens === null ? "" : String(item.quotaTokens),
  };
}

export function optionalInteger(value: string, minimum: number): number | undefined | null {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum) return null;
  return number;
}

export function serializeMappings(value: ModelMappingDraft[]): Record<string, string> | null {
  const result: Record<string, string> = {};
  for (const mapping of value) {
    const publicModel = mapping.publicModel.trim();
    const upstreamModel = mapping.upstreamModel.trim();
    if (!publicModel && !upstreamModel) continue;
    if (!publicModel || !upstreamModel || Object.hasOwn(result, publicModel)) return null;
    result[publicModel] = upstreamModel;
  }
  return result;
}

export function suggestedChannelId(providerId: string, channels: ChannelConfig[]): string {
  const base = `${providerId}-default`;
  if (!channels.some((item) => item.id === base && item.providerId !== providerId)) return base;
  let suffix = 2;
  while (channels.some((item) => item.id === `${providerId}-${suffix}`)) suffix += 1;
  return `${providerId}-${suffix}`;
}
