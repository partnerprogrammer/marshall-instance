import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'bun:test';

import { createProvider } from './factory.js';
import { ClaudeProvider } from './claude.js';
import { MockProvider } from './mock.js';
import { registerProvider, requireProviderName } from './provider-registry.js';
import { PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION } from '../provider-contracts/registry.js';

describe('createProvider', () => {
  it('returns ClaudeProvider for claude', () => {
    expect(createProvider('claude')).toBeInstanceOf(ClaudeProvider);
  });

  it('returns MockProvider for mock', () => {
    expect(createProvider('mock')).toBeInstanceOf(MockProvider);
  });

  it('throws for unknown name', () => {
    expect(() => createProvider('bogus')).toThrow(/Unknown provider/);
  });

  it('normalizes and validates the selected provider before startup', () => {
    expect(requireProviderName('CLAUDE')).toBe('claude');
    expect(() => requireProviderName('bogus')).toThrow(/Unknown provider/);
  });

  it('dispatches provider-owned contract callbacks without calling provider fallbacks', () => {
    const name = `factory-core-owner-${process.pid}`;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
    const conversations = path.join(root, 'conversations');
    const previous = process.env.NANOCLAW_CONVERSATIONS_DIR;
    process.env.NANOCLAW_CONVERSATIONS_DIR = conversations;
    let fallbackCalls = 0;
    let exchangePlannerCalls = 0;
    let rotationCalls = 0;
    let beforeQueryCalls = 0;

    registerProvider(name, {
      create: () => ({
        registerMemorySessionHook: () => {},
        onExchangeComplete: () => fallbackCalls++,
        maybeRotateContinuation: () => {
          fallbackCalls++;
          return null;
        },
        query: () => {
          throw new Error('unused');
        },
        isSessionInvalid: () => false,
      }),
      contract: {
        seamVersion: PROVIDER_RUNTIME_CONTRACT_SEAM_VERSION,
        configuration: {
          executionPolicy: { value: { boundary: 'container' } },
          inference: { resolve: (input) => ({ model: input.model }) },
          memory: { resolve: (input) => ({ command: input.command }) },
          mcpServers: { resolve: (input) => ({ servers: Object.keys(input) }) },
        },
        lifecycle: {
          beforeQuery: () => {
            beforeQueryCalls++;
          },
        },
        history: {
          afterExchange: () => {
            exchangePlannerCalls++;
            fs.mkdirSync(conversations, { recursive: true });
            fs.writeFileSync(path.join(conversations, 'exchange.md'), 'archived\n');
            return 'exchange.md';
          },
          rotateContinuation: () => {
            rotationCalls++;
            return 'rotate';
          },
        },
        textDelivery: 'result',
        commands: { formatting: 'xml', nativeAdmin: [], nativeFiltered: [] },
      },
    });

    try {
      const provider = createProvider(name);
      provider.onExchangeComplete?.({ prompt: 'hello', result: 'world', status: 'completed' });
      const archiveCalls = exchangePlannerCalls;
      expect(provider.maybeRotateContinuation?.('session', '/unused')).toBe('rotate');
      expect(() => provider.query({ prompt: 'hello', cwd: '/workspace/agent' })).toThrow(/unused/);
      expect(fs.readFileSync(path.join(conversations, 'exchange.md'), 'utf8')).toBe('archived\n');
      expect(exchangePlannerCalls).toBe(archiveCalls);
      expect(rotationCalls).toBe(1);
      expect(fallbackCalls).toBe(0);
      expect(beforeQueryCalls).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.NANOCLAW_CONVERSATIONS_DIR;
      else process.env.NANOCLAW_CONVERSATIONS_DIR = previous;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
