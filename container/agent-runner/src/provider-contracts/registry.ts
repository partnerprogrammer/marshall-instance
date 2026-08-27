/**
 * Container-runtime provider contracts.
 *
 * A contract is an implementation object, not a description: every declared
 * capability carries the function that implements it, and core calls those
 * functions at the declared moments.
 *
 * Registration itself is a map write. The optional shape checks and behavioral
 * probes live in verifier code, not in the startup registry path.
 */

import type { McpServerConfig, ProviderExchange } from '../providers/types.js';

export const PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION = 1;

/** Shared shape of the memory session-hook registration (structural mirror of memory/session-hook.ts). */
export interface RuntimeMemoryHookInput {
  readonly command: string;
  readonly legacyCommands: readonly string[];
  readonly sources: readonly string[];
}

/**
 * Core-owned inputs for each configuration capability that has one.
 * `executionPolicy` is absent by design: it is a stance, not a function of
 * anything core varies, so it carries no input member.
 */
export interface RuntimeConfigurationInputs {
  inference: { model?: string; effort?: string; fastMode?: boolean };
  memory: RuntimeMemoryHookInput;
  mcpServers: Record<string, McpServerConfig>;
}

/**
 * How a provider implements one configuration capability. Omit the whole
 * capability when the provider has no surface there; use `value` for a fixed
 * answer and `resolve` only when the answer depends on the core-owned input.
 *
 * `probes` overrides the registry's default probe inputs when the default
 * fixtures cannot exercise the implementation (e.g. env-gated config).
 */
export interface RuntimeConfigurationCapability<I> {
  value?: unknown;
  resolve?(input: I, environment: NodeJS.ProcessEnv): unknown;
  probes?: { a: I; b: I; environment?: NodeJS.ProcessEnv };
}

/**
 * A provider's sandbox/permission stance. Stating one is mandatory — it is a
 * fact every provider has — but a fixed stance says so with `value` instead of
 * a `resolve` that ignores what it is handed. `resolve` remains for a stance
 * that genuinely reads the environment.
 */
export interface RuntimeExecutionPolicyCapability {
  /** A constant stance. */
  value?: unknown;
  /** An environment-derived stance. */
  resolve?(input: void, environment: NodeJS.ProcessEnv): unknown;
}

export interface ProviderRuntimeConfiguration {
  executionPolicy: RuntimeExecutionPolicyCapability;
  inference?: RuntimeConfigurationCapability<RuntimeConfigurationInputs['inference']>;
  memory?: RuntimeConfigurationCapability<RuntimeConfigurationInputs['memory']>;
  mcpServers?: RuntimeConfigurationCapability<RuntimeConfigurationInputs['mcpServers']>;
}

export interface RuntimeLifecycleCallbacks {
  /** Provider-owned setup after core registers the shared memory hook. */
  memorySessionHookRegistration?(hook: RuntimeMemoryHookInput): void;
  /** Provider-owned setup immediately before starting a query. */
  beforeQuery?(inputs: Partial<RuntimeConfigurationInputs>, context: unknown): void;
}

/**
 * Effects a provider callback is handed instead of reaching for them. Tests
 * pass a fake clock; production passes the real one.
 */
export interface RuntimeCallbackEffects {
  now(): number;
}

export interface RuntimeBeforeCompactInput {
  transcriptPath?: string;
  sessionId?: string;
  assistantName?: string;
  log(message: string): void;
}

export interface RuntimeAfterExchangeInput {
  exchange: ProviderExchange;
}

export interface RuntimeContinuationRotationInput {
  continuation: string;
  assistantName?: string;
  log(message: string): void;
}

export interface RuntimeHistoryCallbacks {
  /** Provider-owned work when the provider reports a pre-compact event. */
  beforeCompact?(input: RuntimeBeforeCompactInput, fx: RuntimeCallbackEffects): boolean;
  /** Provider-owned work after core observes a completed exchange. */
  afterExchange?(input: RuntimeAfterExchangeInput, fx: RuntimeCallbackEffects): string | null;
  /** Provider-owned continuation maintenance before resuming a prior session. */
  rotateContinuation?(input: RuntimeContinuationRotationInput, fx: RuntimeCallbackEffects): string | null;
  /** Provider-owned trace lookup for diagnostics. */
  readTrace?(): string | null;
}

export interface ProviderRuntimeContract {
  seamVersion: number;
  /** Provider-declared configuration surfaces. */
  configuration: ProviderRuntimeConfiguration;
  /** Provider-owned lifecycle effects. */
  lifecycle?: RuntimeLifecycleCallbacks;
  /** Provider-owned history hooks; core only decides when to invoke them. */
  history?: RuntimeHistoryCallbacks;
  textDelivery: 'mid-turn-complete' | 'result';
  /** How context compaction is observed; absent when the provider owns its context lifecycle opaquely. */
  compaction?: 'provider-hook' | 'provider-native';
  commands: {
    formatting: 'native' | 'xml';
    nativeAdmin?: readonly string[];
    nativeFiltered?: readonly string[];
  };
}
