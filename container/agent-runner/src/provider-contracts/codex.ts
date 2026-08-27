import {
  codexExecutionPolicySection,
  codexInferenceSection,
  codexMcpServersSection,
  codexMemorySection,
  type CodexMemorySessionHook,
  writeCodexConfigToml,
} from '../providers/codex-app-server.js';
import { archiveProviderExchange } from '../providers/exchange-archive.js';

import {
  type ProviderRuntimeContract,
  type RuntimeAfterExchangeInput,
  type RuntimeCallbackEffects,
  type RuntimeConfigurationInputs,
} from './registry.js';

const provider = 'codex';
const RUNTIME_SEAM_VERSION = 1;

export const codexRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    executionPolicy: { value: codexExecutionPolicySection(undefined) },
    inference: { resolve: codexInferenceSection },
    memory: { resolve: codexMemorySection },
    mcpServers: { resolve: codexMcpServersSection },
  },
  lifecycle: { beforeQuery: writeCodexRuntimeFiles },
  history: { afterExchange: archiveCodexExchange },
  textDelivery: 'result',
  commands: { formatting: 'xml' },
};

function writeCodexRuntimeFiles(inputs: Partial<RuntimeConfigurationInputs>): void {
  const hook = inputs.memory as CodexMemorySessionHook | undefined;
  if (!hook) throw new Error('Codex provider requires a registered memory hook before query');
  writeCodexConfigToml(inputs.mcpServers ?? {}, hook, codexInferenceSection(inputs.inference ?? {}));
}

function archiveCodexExchange({ exchange }: RuntimeAfterExchangeInput, fx: RuntimeCallbackEffects): string | null {
  return archiveProviderExchange({
    provider,
    prompt: exchange.prompt,
    result: exchange.result,
    continuation: exchange.continuation,
    status: exchange.status,
    timestamp: new Date(fx.now()),
  });
}
