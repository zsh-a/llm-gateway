import type { GatewayModel } from "../types";

// The management catalog can contain the same upstream ID in several providers.
// Qualify those IDs before using them as selectable values or permission entries.
export function qualifyModelIds(models: GatewayModel[]): GatewayModel[] {
  const providers = new Map<string, Set<string>>();
  for (const model of models) {
    const group = providers.get(model.id) ?? new Set<string>();
    group.add(model.provider ?? model.owned_by ?? "");
    providers.set(model.id, group);
  }
  return models.map((model) => {
    const provider = model.provider ?? model.owned_by;
    return provider && (providers.get(model.id)?.size ?? 0) > 1
      ? { ...model, id: `${provider}/${model.id}` }
      : model;
  });
}

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
