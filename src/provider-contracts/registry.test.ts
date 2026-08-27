import { describe, expect, it } from 'vitest';

import './index.js';
import {
  PROVIDER_HOST_CONTRACT_SEAM_VERSION,
  getProviderHostContract,
  hasDeclaredProviderContract,
  assertProviderHostContractShape,
  listProviderHostContractNames,
  registerProviderHostContract,
  type ProviderHostContract,
} from './registry.js';

function emptyContract(): ProviderHostContract {
  return {
    seamVersion: PROVIDER_HOST_CONTRACT_SEAM_VERSION,
    projectDocument: {
      fileName: 'AGENTS.md',
      containerPath: '/workspace/agent/AGENTS.md',
      mountClass: 'group-state',
    },
    stateVolumes: [],
    skillBackings: [],
    skillViews: [],
    files: [],
    commands: { nativeAdmin: [], nativeFiltered: [] },
  };
}

const missing = Symbol('missing');

function cloneContract<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function claudeContractWith(path: string, value: unknown | typeof missing): ProviderHostContract {
  const contract = cloneContract(getProviderHostContract('claude')!);
  const parts = path.split('.');
  let target = contract as unknown as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) target = target[part] as Record<string, unknown>;
  const field = parts.at(-1)!;
  if (value === missing) delete target[field];
  else target[field] = value;
  return contract;
}

function contractName(field: string, suffix: string): string {
  return `invalid-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

function checkedRegisterProviderHostContract(name: string, contract: ProviderHostContract): void {
  assertProviderHostContractShape(name, contract);
  registerProviderHostContract(name, contract);
}

describe('provider host contracts', () => {
  it('loads the complete Claude base declaration from the separate contract barrel', () => {
    const contract = getProviderHostContract('claude');

    expect(contract).toBeDefined();
    expect(contract?.projectDocument).toMatchObject({
      fileName: 'CLAUDE.md',
      containerPath: '/workspace/agent/CLAUDE.md',
      sourceProtection: 'install-surface',
    });
    expect(contract?.stateVolumes).toEqual([
      expect.objectContaining({ id: 'claude-home', directory: '.claude-shared', scope: 'group' }),
    ]);
    expect(contract?.skillBackings).toEqual([
      expect.objectContaining({ id: 'claude-skills', templateCopies: 'in-place' }),
    ]);
    expect(contract?.files).toEqual([
      expect.objectContaining({
        id: 'claude-settings',
        prepare: expect.objectContaining({ operation: 'create-if-missing', when: 'group-init' }),
        reconcile: { transformer: 'claude-settings' },
      }),
    ]);
    expect(contract?.environment).toBeUndefined();
    expect(contract?.legacyHostAdapter).toBeUndefined();
    expect(contract?.seamVersion).toBe(PROVIDER_HOST_CONTRACT_SEAM_VERSION);
    expect(contract?.commands?.nativeFiltered).toContain('/remote-control');
  });

  it('keeps installed contracts data-only', () => {
    for (const name of listProviderHostContractNames()) {
      const contract = getProviderHostContract(name)!;
      expect(JSON.parse(JSON.stringify(contract))).toEqual(contract);
    }
  });

  it('keeps provider lookup case-insensitive and unknown providers undeclared', () => {
    expect(hasDeclaredProviderContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderContract('not-installed')).toBe(false);
    expect(listProviderHostContractNames()).toContain('claude');
  });

  it('rejects duplicate declarations at registration', () => {
    const name = `duplicate-contract-${process.pid}`;
    const empty = emptyContract();
    checkedRegisterProviderHostContract(name, empty);
    expect(() => checkedRegisterProviderHostContract(name, empty)).toThrow(/already registered/);
  });

  it('rejects mixed-version provider contracts with an operator fix', () => {
    const contract = emptyContract();
    contract.seamVersion = 0;
    expect(() => checkedRegisterProviderHostContract(contractName('seam-version', 'old'), contract)).toThrow(
      /run \/update-skills/,
    );
  });

  it('freezes the stored contract so later mutation attempts throw', () => {
    const name = `immutable-contract-${process.pid}`;
    checkedRegisterProviderHostContract(name, emptyContract());

    const stored = getProviderHostContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands!.nativeAdmin)).toBe(true);
    expect(() => (stored.commands!.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it('requires a project document', () => {
    expect(() =>
      checkedRegisterProviderHostContract(
        contractName('project-document', 'missing'),
        claudeContractWith('projectDocument', missing),
      ),
    ).toThrow(/projectDocument is required/);
  });

  it.each([
    [
      'host path in override files',
      () => ({
        ...emptyContract(),
        projectDocument: {
          fileName: 'AGENTS.md',
          containerPath: '/workspace/agent/AGENTS.md',
          mountClass: 'group-state' as const,
          instructions: { nativeOverrideFiles: ['/tmp/AGENTS.local.md'] },
        },
      }),
      /one file or directory name/,
    ],
    [
      'duplicate volume identity',
      () => ({
        ...emptyContract(),
        stateVolumes: [
          {
            id: 'state',
            directory: '.one',
            containerPath: '/one',
            scope: 'group' as const,
            mode: 'rw' as const,
            mountClass: 'group-state' as const,
          },
          {
            id: 'state',
            directory: '.two',
            containerPath: '/two',
            scope: 'session' as const,
            mode: 'rw' as const,
            mountClass: 'allowlisted-extra' as const,
          },
        ],
      }),
      /must be unique/,
    ],
    [
      'missing backing volume',
      () => ({
        ...emptyContract(),
        skillBackings: [
          {
            id: 'skills',
            location: { kind: 'state-volume' as const, volumeId: 'missing', subdirectory: 'skills' },
            skillsSubdirectory: 'skills',
            conflictDiagnostics: 'silent' as const,
            templateCopies: 'in-place' as const,
          },
        ],
      }),
      /references unknown/,
    ],
  ])('rejects %s at registration', (_label, makeContract, expected) => {
    const name = `invalid-${_label.toLowerCase().replaceAll(' ', '-')}-${process.pid}`;
    expect(() => checkedRegisterProviderHostContract(name, makeContract())).toThrow(expected);
  });

  it.each([
    ['non-object facts', 'projectDocument.instructions', 'invalid', /instructions must be an object/],
    [
      'empty override files',
      'projectDocument.instructions',
      { nativeOverrideFiles: [] },
      /nativeOverrideFiles must be a non-empty array/,
    ],
    [
      'relative skills discovery path',
      'projectDocument.instructions',
      {
        nativeSkills: {
          discoveryPath: 'skills',
          sharedSource: '/app/skills',
          selfAuthoredHome: '~/.codex/skills',
          persistentRoots: ['~/.codex'],
        },
      },
      /nativeSkills\.discoveryPath/,
    ],
    [
      'empty persistent roots',
      'projectDocument.instructions',
      {
        nativeSkills: {
          discoveryPath: '/workspace/agent/.agents/skills',
          sharedSource: '/app/skills',
          selfAuthoredHome: '~/.codex/skills',
          persistentRoots: [],
        },
      },
      /persistentRoots must be a non-empty array/,
    ],
  ])('rejects malformed project-document instruction facts: %s', (_label, field, value, expected) => {
    expect(() =>
      checkedRegisterProviderHostContract(
        contractName(`instruction-facts-${_label}`, 'invalid'),
        claudeContractWith(field, value),
      ),
    ).toThrow(expected);
  });

  it.each(['stateVolumes', 'skillBackings', 'skillViews', 'files'])('requires top-level host array %s', (field) => {
    expect(() =>
      checkedRegisterProviderHostContract(contractName(`array-${field}`, 'wrong'), claudeContractWith(field, {})),
    ).toThrow(`.${field} must be an array`);
    expect(() =>
      checkedRegisterProviderHostContract(
        contractName(`array-${field}`, 'missing'),
        claudeContractWith(field, missing),
      ),
    ).toThrow(`.${field} must be an array`);
  });

  it.each([
    ['projectDocument.mountClass', 'claude.projectDocument.mountClass'],
    ['projectDocument.sourceProtection', 'claude.projectDocument.sourceProtection'],
    ['stateVolumes.0.scope', 'claude.stateVolumes.claude-home.scope'],
    ['stateVolumes.0.mode', 'claude.stateVolumes.claude-home.mode'],
    ['stateVolumes.0.mountClass', 'claude.stateVolumes.claude-home.mountClass'],
    ['skillBackings.0.location.kind', 'claude.skillBackings.claude-skills.location.kind'],
    ['skillBackings.0.sharedLinks', 'claude.skillBackings.claude-skills.sharedLinks'],
    ['skillBackings.0.conflictDiagnostics', 'claude.skillBackings.claude-skills.conflictDiagnostics'],
    ['skillBackings.0.templateCopies', 'claude.skillBackings.claude-skills.templateCopies'],
    ['skillViews.0.mode', 'claude.skillViews.claude-skills.mode'],
    ['skillViews.0.mountClass', 'claude.skillViews.claude-skills.mountClass'],
    ['skillViews.0.mount', 'claude.skillViews.claude-skills.mount'],
    ['files.0.prepare.operation', 'claude.files.claude-settings.prepare.operation'],
    ['files.0.prepare.when', 'claude.files.claude-settings.prepare.when'],
    ['files.0.prepare.mode', 'claude.files.claude-settings.prepare.mode'],
    ['commands.nativeAdmin', 'claude.commands.nativeAdmin'],
    ['commands.nativeFiltered', 'claude.commands.nativeFiltered'],
  ])('rejects invalid %s at registration', (path, field) => {
    expect(() =>
      checkedRegisterProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
  });

  it.each([['environment', 'claude.environment']])('rejects invalid %s at registration', (path, field) => {
    expect(() =>
      checkedRegisterProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
  });

  it.each([['legacyHostAdapter', 'claude.legacyHostAdapter']])('rejects invalid %s at registration', (path, field) => {
    expect(() =>
      checkedRegisterProviderHostContract(contractName(path, 'invalid'), claudeContractWith(path, 'invalid')),
    ).toThrow(field.slice('claude'.length));
  });

  it('rejects unknown reconcile transformers', () => {
    expect(() =>
      checkedRegisterProviderHostContract(
        contractName('reconcile-transform', 'invalid'),
        claudeContractWith('files.0.reconcile.transformer', 'unknown-transformer'),
      ),
    ).toThrow(/reconcile\.transformer/);
  });

  it("requires the legacy host adapter when environment uses 'legacy-overlay'", () => {
    expect(() =>
      checkedRegisterProviderHostContract(contractName('legacy-overlay-adapter', 'optional'), {
        ...emptyContract(),
        environment: 'legacy-overlay',
      }),
    ).toThrow(/environment 'legacy-overlay' requires legacyHostAdapter 'required'/);
  });

  it('rejects invalid prepared-file content and reconciliation', () => {
    expect(() =>
      checkedRegisterProviderHostContract(
        contractName('prepare-content', 'missing'),
        claudeContractWith('files.0.prepare.content', missing),
      ),
    ).toThrow(/files\.claude-settings\.prepare\.content/);
    // A gateway-owned file has nothing to reconcile: that rule is about the
    // prepare variant, which is the only place ownership is stated now.
    const appendReconcile = claudeContractWith('files.0.prepare', {
      operation: 'append-open-close',
      when: 'every-spawn',
      mode: 'process-default',
    });
    expect(() =>
      checkedRegisterProviderHostContract(contractName('append-reconcile', 'kept'), appendReconcile),
    ).toThrow(/reconcile must be omitted for append-open-close/);
  });

  it('reconciles a prepared file on the schedule its prepare variant fixes', () => {
    const contract = getProviderHostContract('claude')!;
    // The reconciliation used to carry its own `when`, validated to equal this
    // one. Deleting it cannot change the schedule.
    expect(contract.files[0].prepare.when).toBe('group-init');
    expect(contract.files[0].reconcile).toBeDefined();
  });

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['too-large', 0o10000],
  ])('rejects invalid numeric prepared-file mode %s', (label, mode) => {
    expect(() =>
      checkedRegisterProviderHostContract(
        contractName('prepare-mode', label),
        claudeContractWith('files.0.prepare.mode', mode),
      ),
    ).toThrow(/prepare\.mode must be 'process-default' or an integer from 0 to 0o7777/);
  });

  it('rejects group-init prepared files in session volumes', () => {
    const contract = claudeContractWith('stateVolumes', [
      ...cloneContract(getProviderHostContract('claude')!.stateVolumes),
      {
        id: 'session-state',
        directory: 'session-state',
        containerPath: '/session-state',
        scope: 'session',
        mode: 'rw',
        mountClass: 'allowlisted-extra',
      },
    ]);
    contract.files = [
      ...contract.files,
      {
        id: 'session-file',
        volumeId: 'session-state',
        relativePath: 'state.json',
        prepare: { operation: 'create-if-missing', when: 'group-init', content: '{}\n', mode: 0o600 },
      },
    ];
    expect(() =>
      checkedRegisterProviderHostContract(contractName('session-group-init-file', 'invalid'), contract),
    ).toThrow(/prepare cannot initialize session volume 'session-state'/);
  });

  it.each([
    [
      'non-state backing',
      'skillBackings.0.location',
      { kind: 'group-directory', directory: '.agents', subdirectory: '' },
      /requires a state-volume backing/,
    ],
    [
      'wrong destination',
      'skillViews.0.containerPath',
      '/home/node/.claude/other',
      /containerPath must be .* for parent-volume/,
    ],
    ['wrong mode', 'skillViews.0.mode', 'ro', /mode must match parent volume/],
    ['wrong mount class', 'skillViews.0.mountClass', 'allowlisted-extra', /mountClass must match parent volume/],
  ])('rejects unrealizable parent-volume view: %s', (_label, field, value, expected) => {
    expect(() =>
      checkedRegisterProviderHostContract(
        contractName(`parent-volume-${_label}`, 'invalid'),
        claudeContractWith(field, value),
      ),
    ).toThrow(expected);
  });

  it.each([
    [
      'container path alias',
      'stateVolumes.0.containerPath',
      '/home/node//.claude',
      /canonical absolute container path/,
    ],
    ['relative dot alias', 'files.0.relativePath', './settings.json', /canonical relative path/],
    ['relative parent alias', 'files.0.relativePath', 'config/../settings.json', /canonical relative path/],
    ['leading relative parent', 'files.0.relativePath', '../settings.json', /canonical relative path/],
    ['backing relative parent', 'skillBackings.0.location.subdirectory', '../skills', /canonical relative path/],
    ['skills relative parent', 'skillBackings.0.skillsSubdirectory', '../skills', /canonical relative path/],
    ['relative slash alias', 'files.0.relativePath', 'config//settings.json', /canonical relative path/],
  ])('rejects noncanonical %s', (_label, field, value, expected) => {
    expect(() =>
      checkedRegisterProviderHostContract(contractName(`path-${_label}`, 'invalid'), claudeContractWith(field, value)),
    ).toThrow(expected);
  });
});
