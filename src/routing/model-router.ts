import type { ChannelConfig, ChannelStore } from "./channels.js";
import type { ModelCatalog } from "./model-catalog.js";
import type { ProviderAdapter } from "../providers/contracts.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { ModelDescriptor } from "../domain/types.js";

export interface ModelRoute {
  provider: ProviderAdapter;
  channel: ChannelConfig;
  candidates: Array<{
    channel: ChannelConfig;
    upstreamModel: string;
  }>;
  model: ModelDescriptor;
  upstreamModel: string;
  publicModel: string;
}

/** Resolve public model identifiers independently from model discovery/cache logic. */
export class ModelRouter {
  constructor(
    private readonly catalog: ModelCatalog,
    private readonly channels: ChannelStore,
    private readonly providers: ProviderRegistry
  ) {}

  async resolve(requestedModel: string): Promise<ModelRoute | null> {
    const models = await this.catalog.get();
    const requested = requestedModel.trim();
    const exact = models.find((model) => model.publicId === requested);
    if (exact && exact.providerId) {
      const provider = this.providers.get(exact.providerId);
      if (provider) return this.routeFromModel(exact, provider);
    }

    const separator = requested.indexOf("/");
    if (separator > 0) {
      const provider = this.providers.get(requested.slice(0, separator));
      const upstreamModel = requested.slice(separator + 1).trim();
      if (provider && upstreamModel) {
        const candidates = this.channels.selectCandidates(
          provider.id,
          requested,
          upstreamModel
        );
        if (candidates.length === 0) return null;
        const selection = candidates[0];
        return {
          provider,
          channel: selection.channel,
          candidates,
          model: {
            id: upstreamModel,
            providerId: provider.id,
            publicId: requested,
            ownedBy: provider.name
          },
          upstreamModel: selection.upstreamModel,
          publicModel: requested
        };
      }
    }

    const rawMatches = models.filter((model) => model.id === requested);
    if (rawMatches.length === 1 && rawMatches[0].providerId) {
      const provider = this.providers.get(rawMatches[0].providerId);
      if (provider) return this.routeFromModel(rawMatches[0], provider);
    }

    if (!requested) {
      for (const model of models) {
        if (model.capabilities?.chat === false || !model.providerId) continue;
        const provider = this.providers.get(model.providerId);
        const route = provider ? this.routeFromModel(model, provider) : null;
        if (route) return route;
      }
    }

    return null;
  }

  private routeFromModel(
    model: ModelDescriptor,
    provider: ProviderAdapter
  ): ModelRoute | null {
    const publicModel = model.publicId ?? model.id;
    const candidates = this.channels.selectCandidates(
      provider.id,
      publicModel,
      model.id
    );
    if (candidates.length === 0) return null;
    const selection = candidates[0];
    return {
      provider,
      channel: selection.channel,
      candidates,
      model,
      upstreamModel: selection.upstreamModel,
      publicModel
    };
  }
}
