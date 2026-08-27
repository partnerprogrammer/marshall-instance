import { mcpServersToOpenCodeConfig } from '../providers/mcp-to-opencode.js';
import type { ProviderRuntimeContract } from './registry.js';

const RUNTIME_SEAM_VERSION = 1;

export const OPENCODE_PERMISSION_POLICY = {
  read: 'allow',
  edit: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'allow',
  task: 'allow',
  external_directory: 'allow',
  todowrite: 'allow',
  question: 'deny',
  webfetch: 'allow',
  websearch: 'allow',
  codesearch: 'allow',
  lsp: 'allow',
  doom_loop: 'allow',
  skill: 'allow',
} as const;

export const opencodeRuntimeContract: ProviderRuntimeContract = {
  seamVersion: RUNTIME_SEAM_VERSION,
  configuration: {
    executionPolicy: { value: OPENCODE_PERMISSION_POLICY },
    mcpServers: { resolve: mcpServersToOpenCodeConfig },
  },
  textDelivery: 'result',
  commands: { formatting: 'xml' },
};
