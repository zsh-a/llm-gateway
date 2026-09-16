import type { GatewayModel } from "../types";

export function modelEfforts(model: GatewayModel | undefined): Record<string, string | null> {
  return model?.reasoningEfforts ?? {};
}

export function modelSupportsReasoning(model: GatewayModel | undefined): boolean {
  if (!model) return false;
  return model.reasoning === true || Object.keys(modelEfforts(model)).length > 0;
}
