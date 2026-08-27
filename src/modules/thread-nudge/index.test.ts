/**
 * Thread nudge orchestration (CUP-4868): the poll (gating by messaging group,
 * wiring, and session filters), per-session checks (freshness, dedup via
 * persisted outbound history, and posting when classification finds a
 * related thread), and the in-process decision memo that makes repeated
 * ticks cheap. Classification itself is covered by classify.test.ts and
 * mocked here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagingGroups: Record<string, unknown> = {};
const wiringsByMg: Record<string, Array<{ agent_group_id: string; session_mode: string }>> = {};
const sessionsByAgentGroup: Record<string, Array<Record<string, unknown>>> = {};
const rootsBySession: Record<string, { timestamp: string; content: string } | undefined> = {};
const outboundHistoryBySession: Record<string, Array<{ timestamp: string; kind: string; content: string }>> = {};
const collectCandidates = vi.fn();
const findRelatedThread = vi.fn();
const writeOutboundDirect = vi.fn();

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: async (id: string) => messagingGroups[id],
  getMessagingGroupAgents: async (id: string) => wiringsByMg[id] ?? [],
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: async (agentGroupId: string) => sessionsByAgentGroup[agentGroupId] ?? [],
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (_g: string, sessionId: string, action: (m: unknown) => unknown) =>
    action({
      getConversationRoot: () => rootsBySession[sessionId],
      getOutboundHistory: () => outboundHistoryBySession[sessionId] ?? [],
    }),
  writeOutboundDirect,
}));
vi.mock('./classify.js', () => ({ collectCandidates, findRelatedThread }));
vi.mock('./config.js', () => ({
  THREAD_NUDGE_MESSAGING_GROUPS: new Set(['mg-internal']),
  // Large enough that the module-level setInterval (started at import time
  // whenever the allowlist is non-empty) never actually fires during tests.
  POLL_INTERVAL_MS: 999_999_999,
  NUDGE_CHECK_WINDOW_MINUTES: 30,
  CANDIDATE_LIMIT: 12,
  CANDIDATE_MAX_AGE_MINUTES: 180,
  MIN_SHARED_KEYWORDS: 2,
  MIN_KEYWORD_LENGTH: 4,
}));

const { checkSession, pollThreadNudge } = await import('./index.js');

function chat(text: string): string {
  return JSON.stringify({ text });
}

let sessionCounter = 0;
function freshSession(overrides: Record<string, unknown> = {}) {
  sessionCounter += 1;
  return {
    id: `sess-${sessionCounter}`,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-internal',
    thread_id: `slack:C1:${sessionCounter}.0`,
    status: 'active',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    ...overrides,
  };
}

const MG_BASE = { id: 'mg-internal', channel_type: 'slack', platform_id: 'slack:C1', is_group: 1 };
const MG = MG_BASE as never;

beforeEach(() => {
  for (const key of Object.keys(messagingGroups)) delete messagingGroups[key];
  for (const key of Object.keys(wiringsByMg)) delete wiringsByMg[key];
  for (const key of Object.keys(sessionsByAgentGroup)) delete sessionsByAgentGroup[key];
  for (const key of Object.keys(rootsBySession)) delete rootsBySession[key];
  for (const key of Object.keys(outboundHistoryBySession)) delete outboundHistoryBySession[key];
  collectCandidates.mockReset();
  findRelatedThread.mockReset();
  writeOutboundDirect.mockReset();
});

describe('checkSession', () => {
  it('skips task-thread sessions', async () => {
    await checkSession('ag-1', MG, freshSession({ thread_id: 'system:tasks:t-1' }) as never);
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('skips sessions older than the nudge check window', async () => {
    const session = freshSession({ created_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('hello') };
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips when the session has no root message', async () => {
    await checkSession('ag-1', MG, freshSession() as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips when the root message has no parseable text', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: 'not json' };
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips a session already nudged (persisted outbound history)', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('following up on the deploy') };
    outboundHistoryBySession[session.id] = [
      {
        timestamp: new Date().toISOString(),
        kind: 'chat',
        content: JSON.stringify({ text: 'already nudged', threadNudge: true }),
      },
    ];
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('does not re-nudge just because unrelated outbound history exists', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('following up on the deploy') };
    outboundHistoryBySession[session.id] = [
      { timestamp: new Date().toISOString(), kind: 'chat', content: JSON.stringify({ text: 'unrelated agent reply' }) },
    ];
    collectCandidates.mockResolvedValue([]);
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).toHaveBeenCalled();
  });

  it('skips when there are no candidates', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('following up on the deploy') };
    collectCandidates.mockResolvedValue([]);
    await checkSession('ag-1', MG, session as never);
    expect(findRelatedThread).not.toHaveBeenCalled();
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('skips when no candidate is related', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('good morning') };
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue(null);
    await checkSession('ag-1', MG, session as never);
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('posts a marked public reply in the session own thread when a related thread is found', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('following up on the deploy') };
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
    });

    await checkSession('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = writeOutboundDirect.mock.calls[0]!;
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe(session.id);
    expect(msg).toMatchObject({ platformId: 'slack:C1', channelType: 'slack', threadId: session.thread_id });
    const content = JSON.parse(msg.content) as { text: string; threadNudge: boolean };
    expect(content.threadNudge).toBe(true);
    expect(content.text).toContain('slack:C1:1.0');
  });

  it('memoizes a no-match decision — a later call for the same session does no further work', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('good morning') };
    collectCandidates.mockResolvedValue([]);

    await checkSession('ag-1', MG, session as never);
    collectCandidates.mockClear();
    await checkSession('ag-1', MG, session as never);

    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('memoizes a nudged decision — a later call for the same session never posts twice', async () => {
    const session = freshSession();
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('following up on the deploy') };
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
    });

    await checkSession('ag-1', MG, session as never);
    await checkSession('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
  });
});

describe('pollThreadNudge', () => {
  it('skips when the allowlisted messaging group no longer exists', async () => {
    await pollThreadNudge();
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips a DM (is_group = 0) even if allowlisted', async () => {
    messagingGroups['mg-internal'] = { ...MG_BASE, is_group: 0 };
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1', session_mode: 'per-thread' }];
    const session = freshSession();
    sessionsByAgentGroup['ag-1'] = [session];
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('hi') };
    await pollThreadNudge();
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips wirings not in per-thread session mode', async () => {
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1', session_mode: 'shared' }];
    const session = freshSession();
    sessionsByAgentGroup['ag-1'] = [session];
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('hi') };
    await pollThreadNudge();
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('only checks active sessions belonging to the polled messaging group', async () => {
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1', session_mode: 'per-thread' }];
    const active = freshSession({ status: 'active', messaging_group_id: 'mg-internal' });
    const closed = freshSession({ status: 'closed', messaging_group_id: 'mg-internal' });
    const otherMg = freshSession({ status: 'active', messaging_group_id: 'mg-other' });
    sessionsByAgentGroup['ag-1'] = [active, closed, otherMg];
    rootsBySession[active.id] = { timestamp: new Date().toISOString(), content: chat('hi there') };
    collectCandidates.mockResolvedValue([]);

    await pollThreadNudge();

    expect(collectCandidates).toHaveBeenCalledTimes(1);
    expect(collectCandidates).toHaveBeenCalledWith('ag-1', expect.objectContaining({ id: active.id }), 'mg-internal');
  });

  it('keeps checking remaining sessions when one session throws', async () => {
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1', session_mode: 'per-thread' }];
    const bad = freshSession();
    const good = freshSession();
    sessionsByAgentGroup['ag-1'] = [bad, good];
    rootsBySession[good.id] = { timestamp: new Date().toISOString(), content: chat('hi there') };
    rootsBySession[bad.id] = { timestamp: new Date().toISOString(), content: chat('hi there too') };
    collectCandidates.mockImplementation(async (_ag: string, session: { id: string }) => {
      if (session.id === good.id) return [];
      throw new Error('boom');
    });

    await expect(pollThreadNudge()).resolves.toBeUndefined();
    expect(collectCandidates).toHaveBeenCalledTimes(2);
  });

  it('does not re-check a session already decided on an earlier poll', async () => {
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1', session_mode: 'per-thread' }];
    const session = freshSession();
    sessionsByAgentGroup['ag-1'] = [session];
    rootsBySession[session.id] = { timestamp: new Date().toISOString(), content: chat('hi there') };
    collectCandidates.mockResolvedValue([]);

    await pollThreadNudge();
    collectCandidates.mockClear();
    await pollThreadNudge();

    expect(collectCandidates).not.toHaveBeenCalled();
  });
});
