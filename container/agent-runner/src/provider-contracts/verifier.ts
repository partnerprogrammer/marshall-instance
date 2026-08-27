import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type ProviderRuntimeContract,
  type RuntimeConfigurationInputs,
} from './registry.js';

const INPUT_CAPABILITY_NAMES = ['inference', 'memory', 'mcpServers'] as const;
type InputCapabilityName = (typeof INPUT_CAPABILITY_NAMES)[number];

/** Default probe fixtures for the input-sensitivity checks. */
const DEFAULT_PROBES: {
  [K in InputCapabilityName]: {
    a: RuntimeConfigurationInputs[K];
    b: RuntimeConfigurationInputs[K];
  };
} = {
  inference: { a: { model: 'nanoclaw-probe-model-a' }, b: { model: 'nanoclaw-probe-model-b' } },
  memory: {
    a: { command: 'nanoclaw-probe-hook-a', legacyCommands: [], sources: ['startup'] },
    b: { command: 'nanoclaw-probe-hook-b', legacyCommands: [], sources: ['startup'] },
  },
  mcpServers: {
    a: {},
    b: { 'nanoclaw-probe-server': { command: 'nanoclaw-probe-command' } },
  },
};

/** Shape check for one contract. Run by tests and install-time verification, not startup. */
export function assertProviderRuntimeContractShape(name: string, contract: ProviderRuntimeContract): void {
  validateContract(providerKey(name), contract);
}

/** Behavioral probes for one contract. Run by tests and install-time verification, not startup. */
export function probeProviderRuntimeConfiguration(name: string, contract: ProviderRuntimeContract): void {
  probeConfiguration(providerKey(name), contract);
}

function validateContract(provider: string, contract: ProviderRuntimeContract): void {
  if (contract.seamVersion !== PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION) {
    throw new Error(
      `${provider}.seamVersion ${String(contract.seamVersion)} is incompatible with runtime seam ${PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION}; run /update-skills`,
    );
  }
  if (contract.configuration === null || typeof contract.configuration !== 'object') {
    throw new Error(`${provider}.configuration is required`);
  }
  const policy = contract.configuration.executionPolicy;
  const policyField = `${provider}.configuration.executionPolicy`;
  if (policy === null || typeof policy !== 'object') throw new Error(`${policyField} is required`);
  const policySurfaces = [policy.value !== undefined, policy.resolve !== undefined].filter(Boolean).length;
  if (policySurfaces === 0) {
    throw new Error(`${policyField} must state a stance (value or resolve)`);
  }
  if (policySurfaces > 1) {
    throw new Error(`${policyField} must state exactly one of value or resolve`);
  }
  if (policy.resolve !== undefined) requireFunction(policy.resolve, `${policyField}.resolve`);

  for (const capability of INPUT_CAPABILITY_NAMES) {
    const field = `${provider}.configuration.${capability}`;
    const implementation = contract.configuration[capability];
    if (implementation === undefined) continue;
    if (implementation === null || typeof implementation !== 'object') {
      throw new Error(`${field} must be an object`);
    }
    const surfaces = [implementation.value !== undefined, implementation.resolve !== undefined].filter(Boolean).length;
    if (surfaces === 0) {
      throw new Error(`${field} must state value or resolve`);
    }
    if (surfaces > 1) {
      throw new Error(`${field} must state exactly one of value or resolve`);
    }
    if (implementation.resolve !== undefined) requireFunction(implementation.resolve, `${field}.resolve`);
  }

  if (contract.lifecycle !== undefined) {
    if (contract.lifecycle === null || typeof contract.lifecycle !== 'object') {
      throw new Error(`${provider}.lifecycle must be an object`);
    }
    if (contract.lifecycle.memorySessionHookRegistration !== undefined) {
      requireFunction(
        contract.lifecycle.memorySessionHookRegistration,
        `${provider}.lifecycle.memorySessionHookRegistration`,
      );
    }
    if (contract.lifecycle.beforeQuery !== undefined) {
      requireFunction(contract.lifecycle.beforeQuery, `${provider}.lifecycle.beforeQuery`);
    }
  }

  if (contract.history !== undefined) {
    if (contract.history === null || typeof contract.history !== 'object') {
      throw new Error(`${provider}.history must be an object`);
    }
    if (contract.history.beforeCompact !== undefined) {
      requireFunction(contract.history.beforeCompact, `${provider}.history.beforeCompact`);
      if (contract.compaction !== 'provider-hook') {
        throw new Error(`${provider}.history.beforeCompact requires compaction 'provider-hook'`);
      }
    }
    if (contract.history.afterExchange !== undefined) {
      requireFunction(contract.history.afterExchange, `${provider}.history.afterExchange`);
    }
    if (contract.history.rotateContinuation !== undefined) {
      requireFunction(contract.history.rotateContinuation, `${provider}.history.rotateContinuation`);
    }
    if (contract.history.readTrace !== undefined) {
      requireFunction(contract.history.readTrace, `${provider}.history.readTrace`);
    }
  }

  assertAllowed(contract.textDelivery, ['mid-turn-complete', 'result'], `${provider}.textDelivery`);
  if (contract.compaction !== undefined) {
    assertAllowed(contract.compaction, ['provider-hook', 'provider-native'], `${provider}.compaction`);
  }
  assertAllowed(contract.commands?.formatting, ['native', 'xml'], `${provider}.commands.formatting`);
  assertCommandArray(contract.commands?.nativeAdmin, `${provider}.commands.nativeAdmin`);
  assertCommandArray(contract.commands?.nativeFiltered, `${provider}.commands.nativeFiltered`);
  unique(contract.commands?.nativeAdmin ?? [], `${provider}.commands.nativeAdmin`);
  unique(contract.commands?.nativeFiltered ?? [], `${provider}.commands.nativeFiltered`);
}

function probeConfiguration(provider: string, contract: ProviderRuntimeContract): void {
  const probeInputs = (
    capability: InputCapabilityName,
    variant: 'a' | 'b',
  ): RuntimeConfigurationInputs[InputCapabilityName] => {
    const declared = contract.configuration[capability]?.probes as
      | { a: RuntimeConfigurationInputs[typeof capability]; b: RuntimeConfigurationInputs[typeof capability] }
      | undefined;
    return (declared ?? DEFAULT_PROBES[capability])[variant];
  };

  const probeEnvironment = (capability: InputCapabilityName): NodeJS.ProcessEnv =>
    contract.configuration[capability]?.probes?.environment ?? {};

  const policy = contract.configuration.executionPolicy;
  const policyField = `${provider}.configuration.executionPolicy`;
  if (policy.resolve && policy.resolve(undefined, {}) === undefined) {
    throw new Error(`${policyField}.resolve must produce a value`);
  }

  for (const capability of INPUT_CAPABILITY_NAMES) {
    const field = `${provider}.configuration.${capability}`;
    const implementation = contract.configuration[capability];
    if (implementation === undefined) continue;
    if (implementation.value !== undefined) continue;
    const resolvedA = implementation.resolve!(probeInputs(capability, 'a') as never, probeEnvironment(capability));
    if (resolvedA === undefined) {
      throw new Error(`${field}.resolve must produce a value for the probe input`);
    }

    const resolvedB = implementation.resolve!(probeInputs(capability, 'b') as never, probeEnvironment(capability));
    const lifecycleConsumesMemory =
      capability === 'memory' &&
      (contract.lifecycle?.memorySessionHookRegistration !== undefined ||
        contract.lifecycle?.beforeQuery !== undefined);
    if (!lifecycleConsumesMemory && stableStringify(resolvedA) === stableStringify(resolvedB)) {
      throw new Error(`${field} does not respond to its configuration input`);
    }
  }
}

function providerKey(name: string): string {
  const key = name.toLowerCase();
  if (name !== key || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`Provider runtime contract name must be lowercase kebab-case: '${name}'`);
  }
  return key;
}

function requireFunction(value: unknown, field: string): void {
  if (typeof value !== 'function') throw new Error(`${field} must be a function`);
}

function assertAllowed(value: unknown, allowed: readonly unknown[], field: string): void {
  if (!allowed.includes(value)) {
    throw new Error(`${field} must be one of ${allowed.map((entry) => `'${String(entry)}'`).join(', ')}`);
  }
}

function unique(values: readonly string[], field: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${field} must be unique; duplicate '${value}'`);
    seen.add(value);
  }
}

function assertCommandArray(value: unknown, field: string): asserts value is readonly string[] {
  if (value === undefined) return;
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const command of value) {
    if (typeof command !== 'string' || !/^\/[a-z0-9-]+$/.test(command)) {
      throw new Error(`${field} contains invalid command '${String(command)}'`);
    }
  }
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (typeof entry === 'function') return '[function]';
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
      );
    }
    return entry;
  });
}
