import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, spyOn } from 'bun:test';

import { TIMEZONE, formatLocalStamp } from '../timezone.js';
import { registerProvider } from '../providers/provider-registry.js';
import {
  newestRegisteredTrace,
  runProviderAfterExchange,
  runProviderBeforeCompact,
  runProviderBeforeQuery,
} from './realize.js';
import {
  PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
  type ProviderRuntimeContract,
  type RuntimeCallbackEffects,
} from './registry.js';
import { getProviderRuntimeContract, hasDeclaredProviderRuntimeContract } from '../providers/provider-registry.js';
import { assertProviderRuntimeContractShape, probeProviderRuntimeConfiguration } from './verifier.js';

function registerCheckedProvider(name: string, contract: ProviderRuntimeContract): void {
  assertProviderRuntimeContractShape(name, contract);
  probeProviderRuntimeConfiguration(name, contract);
  registerProvider(name, {
    create: () => ({
      registerMemorySessionHook: () => {},
      query: () => {
        throw new Error('unused');
      },
      isSessionInvalid: () => false,
    }),
    contract,
  });
}

function emptyContract(): ProviderRuntimeContract {
  return {
    seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
    configuration: {
      executionPolicy: { resolve: () => ({ boundary: 'container' }) },
      inference: { resolve: (input) => ({ model: input.model, effort: input.effort }) },
      memory: { resolve: (input) => ({ command: input.command }) },
      mcpServers: { resolve: (input) => ({ servers: Object.keys(input) }) },
    },
    textDelivery: 'result',
    commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
  };
}

function fixedClock(ms: number): RuntimeCallbackEffects {
  return { now: () => ms };
}

function contractName(field: string, suffix: string): string {
  return `runtime-${field}-${suffix}-${process.pid}`.replaceAll(/[^a-z0-9-]/g, '-');
}

describe('provider runtime contracts', () => {
  it('loads the complete Claude implementation from the provider registration', () => {
    const contract = getProviderRuntimeContract('claude');
    expect(contract).toBeDefined();

    expect(contract?.configuration.executionPolicy.resolve).toBeUndefined();
    expect(contract?.configuration.executionPolicy.value).toBeDefined();
    expect(typeof contract?.configuration.inference?.resolve).toBe('function');
    expect(typeof contract?.configuration.mcpServers?.resolve).toBe('function');
    expect(typeof contract?.configuration.memory?.resolve).toBe('function');
    expect(typeof contract?.lifecycle?.memorySessionHookRegistration).toBe('function');
    expect(typeof contract?.history?.beforeCompact).toBe('function');
    expect(typeof contract?.history?.rotateContinuation).toBe('function');
    expect(typeof contract?.history?.readTrace).toBe('function');
    expect(contract?.textDelivery).toBe('mid-turn-complete');
    expect(contract?.compaction).toBe('provider-hook');
    expect(contract?.commands.formatting).toBe('native');
    expect(contract?.seamVersion).toBe(PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION);
    expect(hasDeclaredProviderRuntimeContract('CLAUDE')).toBe(true);
    expect(hasDeclaredProviderRuntimeContract('legacy')).toBe(false);
  });

  it('resolves Claude execution policy, inference, and MCP config through the contract functions', () => {
    const contract = getProviderRuntimeContract('claude')!;
    const policy = contract.configuration.executionPolicy.value as {
      permissionMode: string;
      disallowedTools: string[];
    };
    expect(policy.permissionMode).toBe('bypassPermissions');
    expect(policy.disallowedTools).toContain('AskUserQuestion');

    const inference = contract.configuration.inference?.resolve!({ model: 'opus', effort: 'high', fastMode: true }, {});
    expect(inference).toEqual({ model: 'opus', effort: 'high', fastMode: true });

    const mcp = contract.configuration.mcpServers?.resolve!({ nanoclaw: { command: 'bun' } }, {}) as {
      allowedTools: string[];
    };
    expect(mcp.allowedTools).toContain('mcp__nanoclaw__*');
  });

  it('rejects duplicate registrations', () => {
    const name = `runtime-contract-${process.pid}`;
    registerCheckedProvider(name, emptyContract());
    expect(() => registerCheckedProvider(name, emptyContract())).toThrow(/already registered/);
  });

  it('rejects non-kebab-case provider names', () => {
    expect(() => registerCheckedProvider('Runtime Bad Name', emptyContract())).toThrow(/kebab-case/);
  });

  it('rejects mixed-version provider contracts with an operator fix', () => {
    const contract = emptyContract();
    contract.seamVersion = 0;
    expect(() => registerCheckedProvider(contractName('seam-version', 'old'), contract)).toThrow(/run \/update-skills/);
  });

  it('freezes the stored contract so later mutation attempts throw', () => {
    const name = `runtime-immutable-${process.pid}`;
    registerCheckedProvider(name, emptyContract());
    const stored = getProviderRuntimeContract(name)!;
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.commands.nativeAdmin!)).toBe(true);
    expect(() => (stored.commands.nativeAdmin as string[]).push('/later')).toThrow();
  });

  it('allows omitted and fixed-value optional capabilities', () => {
    const contract = emptyContract();
    delete contract.configuration.memory;
    contract.configuration.mcpServers = { value: {} };
    registerCheckedProvider(contractName('configuration-optional', 'valid'), contract);
  });

  it('rejects declared capabilities without a value or resolver', () => {
    const contract = emptyContract();
    contract.configuration.inference = {};
    expect(() => registerCheckedProvider(contractName('configuration-empty', 'invalid'), contract)).toThrow(
      /configuration\.inference must state value or resolve/,
    );
  });

  it('rejects a missing configuration block', () => {
    const missingBlock = emptyContract() as unknown as { configuration?: unknown };
    delete missingBlock.configuration;
    expect(() =>
      registerCheckedProvider(contractName('configuration-block', 'missing'), missingBlock as ProviderRuntimeContract),
    ).toThrow(/configuration is required/);
  });

  it('rejects invalid lifecycle and history declarations', () => {
    expect(() =>
      registerCheckedProvider(contractName('lifecycle-before-query', 'invalid'), {
        ...emptyContract(),
        lifecycle: {
          beforeQuery: 'bad' as unknown as NonNullable<ProviderRuntimeContract['lifecycle']>['beforeQuery'],
        },
      }),
    ).toThrow(/lifecycle\.beforeQuery must be a function/);

    expect(() =>
      registerCheckedProvider(contractName('history-before-compact', 'invalid'), {
        ...emptyContract(),
        history: {
          beforeCompact: 'bad' as unknown as NonNullable<ProviderRuntimeContract['history']>['beforeCompact'],
        },
        compaction: 'provider-hook',
      }),
    ).toThrow(/history\.beforeCompact must be a function/);

    expect(() =>
      registerCheckedProvider(contractName('history-compaction', 'invalid'), {
        ...emptyContract(),
        history: { beforeCompact: () => false },
      }),
    ).toThrow(/history\.beforeCompact requires compaction 'provider-hook'/);
  });

  it('rejects invalid text delivery, compaction, and command declarations', () => {
    expect(() =>
      registerCheckedProvider(contractName('text-delivery', 'invalid'), {
        ...emptyContract(),
        textDelivery: 'invalid' as ProviderRuntimeContract['textDelivery'],
      }),
    ).toThrow(/textDelivery/);

    expect(() =>
      registerCheckedProvider(contractName('compaction', 'invalid'), {
        ...emptyContract(),
        compaction: 'invalid' as ProviderRuntimeContract['compaction'],
      }),
    ).toThrow(/compaction/);

    expect(() =>
      registerCheckedProvider(contractName('commands-formatting', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'invalid' as 'xml', nativeAdmin: [], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.formatting/);

    expect(() =>
      registerCheckedProvider(contractName('commands-native', 'invalid'), {
        ...emptyContract(),
        commands: { formatting: 'xml', nativeAdmin: ['bad command'], nativeFiltered: [] },
      }),
    ).toThrow(/commands\.nativeAdmin/);
  });

  describe('registration probes', () => {
    it('rejects a capability that ignores its configuration input', () => {
      const contract = emptyContract();
      contract.configuration.inference = { resolve: () => ({ constant: true }) };
      expect(() => registerCheckedProvider(contractName('probe-insensitive', 'invalid'), contract)).toThrow(
        /configuration\.inference does not respond to its configuration input/,
      );
    });

    it('rejects a resolve that produces no value', () => {
      const contract = emptyContract();
      contract.configuration.executionPolicy = { resolve: () => undefined };
      expect(() => registerCheckedProvider(contractName('probe-undefined', 'invalid'), contract)).toThrow(
        /configuration\.executionPolicy\.resolve must produce a value/,
      );
    });

    it('rejects a capability that declares both value and resolve', () => {
      const contract = emptyContract();
      contract.configuration.inference = { value: {}, resolve: (input) => input };
      expect(() => registerCheckedProvider(contractName('configuration-surfaces', 'invalid'), contract)).toThrow(
        /configuration\.inference must state exactly one of value or resolve/,
      );
    });

    it('honors declared probe fixtures and probe environments', () => {
      const seenEnvironments: Array<Record<string, string | undefined>> = [];
      const effortOnly = (input: { model?: string; effort?: string }, environment: NodeJS.ProcessEnv): unknown => {
        seenEnvironments.push({ ...environment });
        return { effort: input.effort ?? 'none' };
      };

      const withoutProbes = emptyContract();
      withoutProbes.configuration.inference = { resolve: effortOnly };
      expect(() => registerCheckedProvider(contractName('probe-defaults-miss', 'invalid'), withoutProbes)).toThrow(
        /configuration\.inference does not respond/,
      );

      const withProbes = emptyContract();
      withProbes.configuration.inference = {
        resolve: effortOnly,
        probes: { a: { effort: 'low' }, b: { effort: 'high' }, environment: { NANOCLAW_PROBE: 'set' } },
      };
      registerCheckedProvider(contractName('probe-defaults-hit', 'valid'), withProbes);
      expect(seenEnvironments.at(-1)?.NANOCLAW_PROBE).toBe('set');
    });
  });

  it('runs provider-owned before-query lifecycle callbacks', () => {
    const name = `runtime-before-query-${process.pid}`;
    const calls: unknown[] = [];
    registerCheckedProvider(name, {
      ...emptyContract(),
      lifecycle: { beforeQuery: (inputs, context) => calls.push({ inputs, context }) },
    });
    const inputs = { inference: { model: 'opus' } };
    runProviderBeforeQuery(name, inputs, { turn: 1 });
    expect(calls).toEqual([{ inputs, context: { turn: 1 } }]);
  });

  it('runs provider-owned after-exchange callbacks', () => {
    const name = `runtime-after-exchange-${process.pid}`;
    const calls: unknown[] = [];
    registerCheckedProvider(name, {
      ...emptyContract(),
      history: {
        afterExchange: (input, fx) => {
          calls.push({ input, now: fx.now() });
          return 'exchange.md';
        },
      },
    });
    expect(runProviderAfterExchange(name, { prompt: 'hello', result: 'world', status: 'completed' })).toBe(
      'exchange.md',
    );
    expect(calls).toHaveLength(1);
  });

  it('archives a Claude transcript through the provider-owned pre-compact callback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');

    try {
      const clockMs = Date.parse('2027-02-03T23:59:59.900Z');
      const clockDate = new Date(clockMs);
      const logs: string[] = [];
      expect(
        getProviderRuntimeContract('claude')!.history!.beforeCompact!(
          { transcriptPath, sessionId: 'session', assistantName: 'Claude', log: (line) => logs.push(line) },
          fixedClock(clockMs),
        ),
      ).toBe(true);
      const [archive] = fs.readdirSync(conversationsDir);
      const time = `${clockDate.getHours().toString().padStart(2, '0')}${clockDate
        .getMinutes()
        .toString()
        .padStart(2, '0')}`;
      expect(archive).toBe(`${formatLocalStamp(clockDate, TIMEZONE).slice(0, 10)}-conversation-${time}.md`);
      expect(fs.readFileSync(path.join(conversationsDir, archive), 'utf-8')).toContain('**User**: hello');
      expect(logs[0]).toContain('Archived conversation to');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps empty Claude transcripts a no-op before reading the optional sessions index', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-noop-${process.pid}-`));
    const transcriptPath = path.join(root, 'empty.jsonl');
    const conversationsDir = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '');

    try {
      fs.mkdirSync(path.join(root, 'sessions-index.json'));
      const logs: string[] = [];
      expect(
        runProviderBeforeCompact('claude', { transcriptPath, sessionId: 'empty', log: (line) => logs.push(line) }),
      ).toBe(false);
      expect(logs).toEqual([]);
      expect(fs.existsSync(conversationsDir)).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a failed Claude transcript archive write instead of throwing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-transcript-blocked-${process.pid}-`));
    const transcriptPath = path.join(root, 'transcript.jsonl');
    const conversationsDir = path.join(root, 'not-a-directory');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversationsDir;
    fs.writeFileSync(transcriptPath, '{"type":"user","message":{"content":"hello"}}\n');
    fs.writeFileSync(conversationsDir, 'blocked');

    try {
      const logs: string[] = [];
      expect(
        runProviderBeforeCompact('claude', { transcriptPath, sessionId: 'session', log: (line) => logs.push(line) }),
      ).toBe(false);
      expect(logs[0]).toContain('Failed to archive transcript:');
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads Claude traces through the provider-owned history callback', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `runtime-trace-home-${process.pid}-`));
    const home = path.join(root, 'home');
    const config = path.join(root, 'config');
    const homeTrace = path.join(home, '.claude', 'projects', 'home-project', 'home.jsonl');
    const configTrace = path.join(config, 'projects', 'config-project', 'config.jsonl');
    fs.mkdirSync(path.dirname(homeTrace), { recursive: true });
    fs.mkdirSync(path.dirname(configTrace), { recursive: true });
    fs.writeFileSync(homeTrace, '{}\n');
    fs.writeFileSync(configTrace, '{}\n');
    const previousConfig = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = config;
    const homedirSpy = spyOn(os, 'homedir').mockReturnValue(home);

    try {
      expect(newestRegisteredTrace()).toBe(homeTrace);
    } finally {
      homedirSpy.mockRestore();
      if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
