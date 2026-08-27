import {
  type RuntimeBeforeCompactInput,
  type RuntimeCallbackEffects,
  type RuntimeConfigurationInputs,
} from './registry.js';
import type { MemorySessionHookRegistration } from '../memory/session-hook.js';
import { getProviderRuntimeContract, listProviderRuntimeContracts } from '../providers/provider-registry.js';
import type { AgentProvider, ProviderExchange } from '../providers/types.js';

/** The production clock handed to planners; probes and tests pass a fake. */
const REAL_CLOCK: RuntimeCallbackEffects = { now: () => Date.now() };

/**
 * The configuration inputs are one object per provider instance, created in
 * the factory from the construction options. The render path closes over that
 * object directly, so nothing is looked up while a file is being written.
 *
 * This map exists for exactly one caller: the memory-session-hook
 * registration, which reaches the seam after construction holding nothing but
 * the instance. That one cannot be a closure without changing what
 * `createProvider` returns, so it stays an explicit, single lookup.
 */
const providerInputs = new WeakMap<AgentProvider, Partial<RuntimeConfigurationInputs>>();

export function bindProviderRuntimeInputs(instance: AgentProvider, inputs: Partial<RuntimeConfigurationInputs>): void {
  providerInputs.set(instance, inputs);
}

export function runProviderBeforeQuery(
  provider: string,
  inputs: Partial<RuntimeConfigurationInputs>,
  context: unknown = undefined,
): void {
  getProviderRuntimeContract(provider)?.lifecycle?.beforeQuery?.(inputs, context);
}

export function registerProviderMemorySessionHook(
  providerName: string,
  provider: AgentProvider,
  hook: MemorySessionHookRegistration,
): void {
  const inputs = providerInputs.get(provider) ?? {};
  inputs.memory = hook;
  providerInputs.set(provider, inputs);
  getProviderRuntimeContract(providerName)?.lifecycle?.memorySessionHookRegistration?.(hook);
  provider.registerMemorySessionHook(hook);
}

export function newestRegisteredTrace(): string | null {
  for (const contract of listProviderRuntimeContracts()) {
    const found = contract.history?.readTrace?.();
    if (found) return found;
  }
  return null;
}

export function runProviderBeforeCompact(provider: string, input: RuntimeBeforeCompactInput): boolean {
  return getProviderRuntimeContract(provider)?.history?.beforeCompact?.(input, REAL_CLOCK) ?? false;
}

export function runProviderAfterExchange(provider: string, exchange: ProviderExchange): string | null {
  return getProviderRuntimeContract(provider)?.history?.afterExchange?.({ exchange }, REAL_CLOCK) ?? null;
}

export function maybeRotateProviderContinuation(
  provider: string,
  continuation: string,
  assistantName: string | undefined,
  log: (message: string) => void,
): string | null {
  return (
    getProviderRuntimeContract(provider)?.history?.rotateContinuation?.(
      { continuation, assistantName, log },
      REAL_CLOCK,
    ) ?? null
  );
}
