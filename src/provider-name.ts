import './provider-contracts/index.js';
import './providers/index.js';

import { hasDeclaredProviderContract } from './provider-contracts/registry.js';
import { getProviderContainerConfig } from './providers/provider-container-registry.js';

/** Normalize and reject providers that this installed host cannot compose. */
export function requireProviderName(value: string): string {
  const provider = value.trim().toLowerCase();
  if (!provider || (!hasDeclaredProviderContract(provider) && !getProviderContainerConfig(provider))) {
    throw new Error(`Unknown provider: ${value}`);
  }
  return provider;
}
