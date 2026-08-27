import { DEFAULT_PROJECT_DOC } from '../project-doc-compose.js';
import { CLAUDE_DEFAULT_SETTINGS } from '../migrate-claude-memory-settings.js';

import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  registerProviderHostContract,
  type ProviderHostContract,
} from './registry.js';

export const CLAUDE_COMPATIBLE_HOST_SURFACES = {
  projectDocument: {
    fileName: DEFAULT_PROJECT_DOC.fileName,
    maxBytes: DEFAULT_PROJECT_DOC.maxBytes,
    containerPath: '/workspace/agent/CLAUDE.md',
    mountClass: 'group-state',
    sourceProtection: 'install-surface',
  },
  stateVolumes: [
    {
      id: 'claude-home',
      directory: '.claude-shared',
      containerPath: '/home/node/.claude',
      scope: 'group',
      mode: 'rw',
      mountClass: 'group-state',
    },
  ],
  skillBackings: [
    {
      id: 'claude-skills',
      location: { kind: 'state-volume', volumeId: 'claude-home', subdirectory: '' },
      skillsSubdirectory: 'skills',
      sharedLinks: true,
      conflictDiagnostics: 'warn',
      templateCopies: 'in-place',
    },
  ],
  skillViews: [
    {
      backingId: 'claude-skills',
      containerPath: '/home/node/.claude/skills',
      mode: 'rw',
      mountClass: 'group-state',
      mount: 'parent-volume',
    },
  ],
  files: [
    {
      id: 'claude-settings',
      volumeId: 'claude-home',
      relativePath: 'settings.json',
      prepare: {
        operation: 'create-if-missing',
        when: 'group-init',
        content: CLAUDE_DEFAULT_SETTINGS,
        mode: 'process-default',
      },
      reconcile: { transformer: 'claude-settings' },
    },
  ],
} satisfies Pick<ProviderHostContract, 'projectDocument' | 'stateVolumes' | 'skillBackings' | 'skillViews' | 'files'>;

registerProviderHostContract('claude', {
  seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  ...CLAUDE_COMPATIBLE_HOST_SURFACES,
  commands: {
    nativeAdmin: ['/compact', '/context', '/cost', '/files'],
    nativeFiltered: ['/start', '/help', '/login', '/logout', '/doctor', '/config', '/remote-control'],
  },
});
