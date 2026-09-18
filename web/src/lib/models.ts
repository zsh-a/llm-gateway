import type { GatewayModel } from "../types";

export function searchModels(models: GatewayModel[], query: string): GatewayModel[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return models;
  return models.filter((model) => {
    const text = [model.id, model.name, model.provider, model.owned_by].join(" ").toLowerCase();
    return terms.every((term) => text.includes(term));
  });
}

export function modelEfforts(model: GatewayModel | undefined): Record<string, string | null> {
  return model?.reasoningEfforts ?? {};
}

export function modelSupportsReasoning(model: GatewayModel | undefined): boolean {
  if (!model) return false;
  return model.reasoning === true || Object.keys(modelEfforts(model)).length > 0;
}
