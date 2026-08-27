/**
 * Provider self-registration registry.
 *
 * Mirrors `src/channels/channel-registry.ts` on the host. Each provider module
 * calls `registerProvider()` at top level; the barrel (`providers/index.ts`)
 * imports every provider module for its side effect so registrations fire
 * before `createProvider()` is called.
 */
import type { AgentProvider, ProviderOptions } from './types.js';
import type { ProviderRuntimeContract } from '../provider-contracts/registry.js';

export type ProviderFactory = (options: ProviderOptions) => AgentProvider;

export interface ProviderRegistration {
  create: ProviderFactory;
  contract?: ProviderRuntimeContract;
}

const registry = new Map<string, ProviderRegistration>();

export function registerProvider(name: string, registration: ProviderFactory | ProviderRegistration): void {
  if (registry.has(name)) {
    throw new Error(`Provider already registered: ${name}`);
  }
  registry.set(name, typeof registration === 'function' ? { create: registration } : registration);
}

export function getProviderFactory(name: string): ProviderFactory {
  const registration = registry.get(name);
  if (!registration) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown provider: ${name}. Registered: ${known}`);
  }
  return registration.create;
}

export function listProviderNames(): string[] {
  return [...registry.keys()];
}
