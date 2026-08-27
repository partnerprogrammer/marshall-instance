import { CODEX_PROJECT_DOC_MAX_BYTES } from '../providers/codex-agents-md.js';

import { registerProviderHostContract } from './registry.js';

const HOST_SEAM_VERSION = 1;

registerProviderHostContract('codex', {
  seamVersion: HOST_SEAM_VERSION,
  projectDocument: {
    fileName: 'AGENTS.md',
    maxBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    containerPath: '/workspace/agent/AGENTS.md',
    mountClass: 'allowlisted-extra',
    // Instruction prose is core-owned canon; Codex declares only the facts
    // rendered into it. No sourceProtection: the canonical template is
    // protected through the Claude declaration.
    instructions: {
      nativeOverrideFiles: ['AGENTS.local.md', 'AGENTS.override.md'],
      nativeSkills: {
        discoveryPath: '/workspace/agent/.agents/skills',
        sharedSource: '/app/skills',
        selfAuthoredHome: '~/.codex/skills',
        persistentRoots: ['~/.codex', '~/.agents'],
        ruleBearingInlined: true,
      },
    },
  },
  stateVolumes: [
    {
      id: 'codex-home',
      directory: '.codex-shared',
      containerPath: '/home/node/.codex',
      scope: 'group',
      mode: 'rw',
      mountClass: 'allowlisted-extra',
    },
  ],
  skillBackings: [
    {
      id: 'codex-skills',
      location: { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      skillsSubdirectory: 'skills',
      conflictDiagnostics: 'silent',
      sharedLinks: true,
      templateCopies: 'copy',
    },
  ],
  skillViews: [
    {
      backingId: 'codex-skills',
      containerPath: '/workspace/agent/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
      mount: 'bind',
    },
    {
      backingId: 'codex-skills',
      containerPath: '/home/node/.agents',
      mode: 'ro',
      mountClass: 'allowlisted-extra',
      mount: 'bind',
    },
  ],
  files: [
    {
      id: 'codex-auth-stub',
      volumeId: 'codex-home',
      relativePath: 'auth.json',
      prepare: { operation: 'append-open-close', when: 'every-spawn', mode: 'process-default' },
    },
  ],
  legacyHostAdapter: 'required',
});
