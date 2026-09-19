import { z } from "zod";
import type { ApiKeyInput, ApiKeyRecord, ChannelConfig, ChannelInput } from "../../types";

const optionalNumber = (minimum: number, label: string) =>
  z
    .string()
    .refine(
      (value) => optionalInteger(value, minimum) !== null,
      `${label}必须是大于等于 ${minimum} 的整数`,
    );

export const channelSchema = z
  .object({
    id: z.string().trim().min(1, "请填写渠道 ID"),
    name: z.string(),
    providerId: z.string().min(1, "请选择 Provider"),
    authRef: z.string(),
    upstreamUrl: z.string().refine((value) => {
      if (!value.trim()) return true;
      try {
        return ["http:", "https:"].includes(new URL(value.trim()).protocol);
      } catch {
        return false;
      }
    }, "请输入有效的 http 或 https 地址"),
    priority: optionalNumber(0, "优先级"),
    weight: optionalNumber(1, "权重"),
    modelMappings: z.array(z.object({ publicModel: z.string(), upstreamModel: z.string() })),
  })
  .superRefine((draft, context) => {
    const names = new Set<string>();
    draft.modelMappings.forEach((mapping, index) => {
      const name = mapping.publicModel.trim();
      const upstream = mapping.upstreamModel.trim();
      if (!name && !upstream) return;
      if (!name)
        context.addIssue({
          code: "custom",
          message: "请填写公开模型名",
          path: ["modelMappings", index, "publicModel"],
        });
      if (!upstream)
        context.addIssue({
          code: "custom",
          message: "请填写上游模型名",
          path: ["modelMappings", index, "upstreamModel"],
        });
      if (names.has(name))
        context.addIssue({
          code: "custom",
          message: "公开模型名不能重复",
          path: ["modelMappings", index, "publicModel"],
        });
      names.add(name);
    });
  });

export const keySchema = z.object({
  name: z.string().trim().min(1, "请填写 Key 名称"),
  allowedModels: z.array(z.string().trim().min(1)),
  rpmLimit: optionalNumber(1, "RPM"),
  tpmLimit: optionalNumber(1, "TPM"),
  quotaTokens: optionalNumber(1, "Token 配额"),
});

export type ChannelDraft = z.infer<typeof channelSchema>;
export type ModelMappingDraft = ChannelDraft["modelMappings"][number];
export type KeyDraft = z.infer<typeof keySchema>;
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
  allowedModels: [],
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
    modelMappings: Object.entries(item.modelMappings ?? {}).map(([publicModel, upstreamModel]) => ({
      publicModel,
      upstreamModel,
    })),
  };
}

export function keyDraftFrom(item: ApiKeyRecord): KeyDraft {
  return {
    name: item.name,
    allowedModels: item.allowedModels,
    rpmLimit: item.rpmLimit === null ? "" : String(item.rpmLimit),
    tpmLimit: item.tpmLimit === null ? "" : String(item.tpmLimit),
    quotaTokens: item.quotaTokens === null ? "" : String(item.quotaTokens),
  };
}

export function optionalInteger(value: string, minimum: number): number | undefined | null {
  if (!value.trim()) return undefined;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) return null;
  return number;
}

export function suggestedChannelId(providerId: string, channels: ChannelConfig[]): string {
  const base = `${providerId}-default`;
  if (!channels.some((item) => item.id === base)) return base;
  let suffix = 2;
  while (channels.some((item) => item.id === `${providerId}-${suffix}`)) suffix += 1;
  return `${providerId}-${suffix}`;
}

export function channelInput(draft: ChannelDraft, existing?: ChannelConfig): ChannelInput {
  const id = draft.id.trim();
  const priority = optionalInteger(draft.priority, 0);
  const weight = optionalInteger(draft.weight, 1);
  const mappings = Object.fromEntries(
    draft.modelMappings
      .filter((row) => row.publicModel.trim() && row.upstreamModel.trim())
      .map((row) => [row.publicModel.trim(), row.upstreamModel.trim()]),
  );
  const input: ChannelInput = { id, providerId: draft.providerId };
  if (draft.name.trim() || existing) input.name = draft.name.trim() || id;
  if (draft.authRef.trim() || existing) input.authRef = draft.authRef.trim() || draft.providerId;
  if (existing) {
    Object.assign(input, {
      enabled: existing.enabled !== false,
      upstreamUrl: draft.upstreamUrl.trim(),
      priority: priority ?? 100,
      weight: weight ?? 1,
      modelMappings: mappings,
    });
  } else {
    if (draft.upstreamUrl.trim()) input.upstreamUrl = draft.upstreamUrl.trim();
    if (priority !== undefined && priority !== null && priority !== 100) input.priority = priority;
    if (weight !== undefined && weight !== null && weight !== 1) input.weight = weight;
    if (Object.keys(mappings).length) input.modelMappings = mappings;
  }
  return input;
}

export function keyInput(draft: KeyDraft, editing: boolean): ApiKeyInput {
  const input: ApiKeyInput = { name: draft.name.trim() };
  if (editing || draft.allowedModels.length)
    input.allowedModels = [...new Set(draft.allowedModels)];
  for (const name of ["rpmLimit", "tpmLimit", "quotaTokens"] as const) {
    const value = optionalInteger(draft[name], 1);
    if (editing || value !== undefined) input[name] = value ?? null;
  }
  return input;
}
