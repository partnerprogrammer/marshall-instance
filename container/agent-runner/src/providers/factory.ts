import type { AgentProvider, ProviderOptions } from './types.js';
import { getProviderFactory } from './provider-registry.js';
import { getProviderRuntimeContract } from './provider-registry.js';
import {
  bindProviderRuntimeInputs,
  maybeRotateProviderContinuation,
  runProviderAfterExchange,
  runProviderBeforeQuery,
} from '../provider-contracts/realize.js';
import type { RuntimeConfigurationInputs } from '../provider-contracts/registry.js';

export function createProvider(name: string, options: ProviderOptions = {}): AgentProvider {
  const contract = getProviderRuntimeContract(name);
  // The core-owned inputs for this instance: one object, owned here, closed
  // over by the render path below.
  const inputs: Partial<RuntimeConfigurationInputs> = {
    inference: { model: options.model, effort: options.effort, speed: options.speed },
    mcpServers: options.mcpServers ?? {},
  };
  const provider = getProviderFactory(name)(options);
  if (contract) {
    bindProviderRuntimeInputs(provider, inputs);

    if (contract.lifecycle?.beforeQuery) {
      const query = provider.query.bind(provider);
      provider.query = (input) => {
        runProviderBeforeQuery(name, inputs);
        return query(input);
      };
    }

    if (contract.history?.afterExchange) {
      provider.onExchangeComplete = (exchange) => {
        runProviderAfterExchange(name, exchange);
      };
    }

    if (contract.history?.rotateContinuation) {
      provider.maybeRotateContinuation = (continuation) =>
        maybeRotateProviderContinuation(name, continuation, options.assistantName, (message) =>
          console.error(`[${name}-provider] ${message}`),
        );
    }
  }
  return provider;
}
