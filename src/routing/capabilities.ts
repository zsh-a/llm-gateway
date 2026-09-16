import type { ModelDescriptor, NormalizedChatRequest } from "../domain/types.js";

export function validateModelRequest(
  request: NormalizedChatRequest,
  model: ModelDescriptor
): string | null {
  if (model.capabilities?.chat === false) {
    return `模型 ${model.publicId ?? model.id} 不支持 Chat Completions/Responses`;
  }
  if (!request.reasoningEffortExplicit || request.effort === "none") return null;
  if (model.capabilities?.reasoning === false) {
    return `模型 ${model.publicId ?? model.id} 不支持 reasoning_effort`;
  }

  const efforts = model.reasoningEfforts;
  if (efforts) {
    const supported = Object.prototype.hasOwnProperty.call(efforts, request.effort);
    if (!supported) {
      return `模型 ${model.publicId ?? model.id} 不支持 reasoning_effort=${request.effort}`;
    }
  }
  return null;
}
