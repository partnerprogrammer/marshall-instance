/**
 * Thread nudge orchestration (CUP-4868): gating (allowlist, group-only,
 * per-thread sessions) and posting the public reply when classification
 * finds a related thread. Classification itself is covered by classify.test.ts
 * and mocked here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const allowedGroups = new Set(['mg-internal']);
const collectCandidates = vi.fn();
const findRelatedThread = vi.fn();
const writeOutboundDirect = vi.fn();

vi.mock('../../router.js', () => ({ registerSessionCreatedHook: vi.fn() }));
vi.mock('../../session-manager.js', () => ({ writeOutboundDirect }));
vi.mock('./config.js', () => ({ THREAD_NUDGE_MESSAGING_GROUPS: allowedGroups }));
vi.mock('./classify.js', () => ({ collectCandidates, findRelatedThread }));

const { handleSessionCreated } = await import('./index.js');

function baseEvent(overrides: Record<string, unknown> = {}) {
  return {
    session: { id: 'sess-new', agent_group_id: 'ag-1', messaging_group_id: 'mg-internal', thread_id: 'slack:C1:9.0' },
    mg: { id: 'mg-internal', channel_type: 'slack', is_group: 1 },
    platformId: 'slack:C1',
    threadId: 'slack:C1:9.0',
    sessionMode: 'per-thread',
    message: {
      id: 'm1',
      kind: 'chat',
      content: JSON.stringify({ text: 'following up on the deploy' }),
      timestamp: '2026-08-24T10:00:00Z',
    },
    ...overrides,
  } as never;
}

beforeEach(() => {
  collectCandidates.mockReset();
  findRelatedThread.mockReset();
  writeOutboundDirect.mockReset();
});

describe('handleSessionCreated', () => {
  it('no-ops when the messaging group is not in the allowlist', async () => {
    await handleSessionCreated(baseEvent({ mg: { id: 'mg-breez', channel_type: 'slack', is_group: 1 } }));
    expect(collectCandidates).not.toHaveBeenCalled();
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('no-ops for DMs (is_group !== 1)', async () => {
    await handleSessionCreated(baseEvent({ mg: { id: 'mg-internal', channel_type: 'slack', is_group: 0 } }));
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('no-ops for non-per-thread session modes', async () => {
    await handleSessionCreated(baseEvent({ sessionMode: 'shared' }));
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('no-ops when the triggering message has no parseable text', async () => {
    await handleSessionCreated(baseEvent({ message: { id: 'm1', kind: 'chat', content: 'not json', timestamp: 't' } }));
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('no-ops when there are no candidates', async () => {
    collectCandidates.mockResolvedValue([]);
    await handleSessionCreated(baseEvent());
    expect(findRelatedThread).not.toHaveBeenCalled();
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('no-ops when no candidate is related', async () => {
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue(null);
    await handleSessionCreated(baseEvent());
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('posts a public reply in the new message thread when a related thread is found', async () => {
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
    });

    await handleSessionCreated(baseEvent());

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = writeOutboundDirect.mock.calls[0]!;
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe('sess-new');
    expect(msg).toMatchObject({ platformId: 'slack:C1', channelType: 'slack', threadId: 'slack:C1:9.0' });
    const content = JSON.parse(msg.content) as { text: string };
    expect(content.text).toContain('slack:C1:1.0');
  });
});
