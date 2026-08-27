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
  const key = providerKey(name);
  if (registry.has(key)) {
    throw new Error(`Provider already registered: ${key}`);
  }
  registry.set(key, deepFreeze(typeof registration === 'function' ? { create: registration } : registration));
}

export function getProviderFactory(name: string): ProviderFactory {
  const registration = registry.get(name);
  if (!registration) {
    const known = [...registry.keys()].join(', ') || '(none)';
    throw new Error(`Unknown provider: ${name}. Registered: ${known}`);
  }
  return registration.create;
}

export function getProviderRuntimeContract(name: string | null | undefined): ProviderRuntimeContract | undefined {
  return name ? registry.get(name.toLowerCase())?.contract : undefined;
}

export function hasDeclaredProviderRuntimeContract(name: string | null | undefined): boolean {
  return getProviderRuntimeContract(name) !== undefined;
}

export function listProviderRuntimeContractNames(): string[] {
  return [...registry.entries()].filter(([, registration]) => registration.contract).map(([name]) => name);
}

export function listProviderRuntimeContracts(): readonly ProviderRuntimeContract[] {
  return [...registry.values()].flatMap((registration) => (registration.contract ? [registration.contract] : []));
}

/** Normalize and validate a provider selected from config before startup work begins. */
export function requireProviderName(name: string): string {
  const normalized = name.toLowerCase();
  getProviderFactory(normalized);
  return normalized;
}

export function listProviderNames(): string[] {
  return [...registry.keys()];
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
