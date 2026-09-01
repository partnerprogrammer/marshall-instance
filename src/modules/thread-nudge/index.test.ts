/**
 * Thread nudge orchestration (CUP-4868): the poll (gating by messaging group,
 * wiring, and session filters), per-session checks (freshness, dedup via
 * persisted outbound history, and posting when classification finds a
 * related thread), and the in-process decision memo that makes repeated
 * ticks cheap. Classification itself is covered by classify.test.ts and
 * mocked here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HistoryRow {
  timestamp: string;
  kind: string;
  content: string;
}

const messagingGroups: Record<string, unknown> = {};
const wiringsByMg: Record<string, Array<{ agent_group_id: string; session_mode: string }>> = {};
const sessionsByAgentGroup: Record<string, Array<Record<string, unknown>>> = {};
const historyBySession: Record<string, HistoryRow[]> = {};
const outboundHistoryBySession: Record<string, Array<{ timestamp: string; kind: string; content: string }>> = {};
const collectCandidates = vi.fn();
const findRelatedThread = vi.fn();
const writeOutboundDirect = vi.fn();

vi.mock('../../channels/slack-lib.js', () => ({
  botTokenKeyForInstance: (instanceKey: string) => `SLACK_BOT_TOKEN_TEST_${instanceKey}`,
}));
vi.mock('../../env.js', () => ({
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 'test-bot-token'])),
}));
// chat.getPermalink is a GET call (see index.ts's own doc comment on
// slackPermalink for why it isn't routed through slack-lib.ts's slackCall),
// so it's exercised here via a mocked global fetch rather than a mocked
// slack-lib export.
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: async (id: string) => messagingGroups[id],
  getMessagingGroupAgents: async (id: string) => wiringsByMg[id] ?? [],
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: async (agentGroupId: string) => sessionsByAgentGroup[agentGroupId] ?? [],
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));
const writeSessionMessage = vi.fn();
const registeredHooks: Array<(event: unknown) => unknown> = [];

vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (_g: string, sessionId: string, action: (m: unknown) => unknown) =>
    action({
      getInboundHistory: () => historyBySession[sessionId] ?? [],
      getOutboundHistory: () => outboundHistoryBySession[sessionId] ?? [],
    }),
  writeOutboundDirect,
  writeSessionMessage,
}));
vi.mock('../../router.js', () => ({
  registerSessionCreatedHook: (hook: (event: unknown) => unknown) => registeredHooks.push(hook),
}));
// getThreadOpener is left as the REAL implementation (only collectCandidates
// and findRelatedThread — the actual classification step — are mocked), so
// these tests exercise it against the historyBySession fixtures above via
// the mocked session-manager. That's deliberate: getThreadOpener's own
// filtering edge cases (echo rows, system senders) are covered in
// classify.test.ts; here it just needs to correctly wire a wake=false
// session's history through to checkSession.
vi.mock('./classify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./classify.js')>();
  return { ...actual, collectCandidates, findRelatedThread };
});
vi.mock('./config.js', () => ({
  THREAD_NUDGE_MESSAGING_GROUPS: new Set(['mg-internal']),
  // Large enough that the module-level setInterval (started at import time
  // whenever the allowlist is non-empty) never actually fires during tests.
  POLL_INTERVAL_MS: 999_999_999,
  NUDGE_CHECK_WINDOW_MINUTES: 30,
  CANDIDATE_LIMIT: 8,
  CANDIDATE_MAX_AGE_MINUTES: 7 * 24 * 60,
  POSITION_DECAY: 0.7,
  NUDGE_SCORE_THRESHOLD: 1.0,
  ROOT_LOOKUP_HISTORY_LIMIT: 60,
  MIN_KEYWORD_LENGTH: 4,
  NUDGE_SNIPPET_MAX_CHARS: 80,
}));

const { checkSession, pollThreadNudge, handleEngagedSessionCreated } = await import('./index.js');

function chat(text: string, senderId = 'U1'): string {
  return JSON.stringify({ text, senderId });
}

/** Sets a session's inbound history to a single real opener row — the
 *  common case. Deliberately kind chat-sdk with no `trigger`/`echo`
 *  concept in play, since getThreadOpener no longer depends on either
 *  (see classify.ts) — this is what a wake=false session's history
 *  actually looks like. */
function setOpener(sessionId: string, text: string, timestamp = new Date().toISOString()): void {
  historyBySession[sessionId] = [{ timestamp, kind: 'chat-sdk', content: chat(text) }];
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
  for (const key of Object.keys(historyBySession)) delete historyBySession[key];
  for (const key of Object.keys(outboundHistoryBySession)) delete outboundHistoryBySession[key];
  collectCandidates.mockReset();
  findRelatedThread.mockReset();
  writeOutboundDirect.mockReset();
  writeSessionMessage.mockReset();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({
    json: async () => ({ ok: true, permalink: 'https://pp.slack.com/archives/C1/p1710000000000000' }),
  });
});

describe('checkSession', () => {
  it('skips task-thread sessions', async () => {
    await checkSession('ag-1', MG, freshSession({ thread_id: 'system:tasks:t-1' }) as never);
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('skips sessions with no real thread_id (non-threaded/shared-mode session — nowhere to post a nudge)', async () => {
    const session = freshSession({ thread_id: null });
    setOpener(session.id, 'hello');
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips sessions older than the nudge check window', async () => {
    const session = freshSession({ created_at: new Date(Date.now() - 60 * 60_000).toISOString() });
    setOpener(session.id, 'hello');
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips when the session has no root message', async () => {
    await checkSession('ag-1', MG, freshSession() as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips when the root message has no parseable text', async () => {
    const session = freshSession();
    historyBySession[session.id] = [{ timestamp: new Date().toISOString(), kind: 'chat-sdk', content: 'not json' }];
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('never nudges a session whose opener @-mentions the bot — the agent answers it in place', async () => {
    // Live-hit (2026-08-28): a "@Marshall do you have access to github?"
    // question got both a nudge ("go continue over there") and the agent's
    // full answer seconds apart — contradictory noise. A message TO the bot
    // is never an off-thread human↔human reply.
    const session = freshSession();
    historyBySession[session.id] = [
      {
        timestamp: new Date().toISOString(),
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'do you have access to github?', senderId: 'U1', isMention: true }),
      },
    ];
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);

    await checkSession('ag-1', MG, session as never);

    expect(collectCandidates).not.toHaveBeenCalled();
    expect(writeOutboundDirect).not.toHaveBeenCalled();

    // Decided once, memoized forever — later ticks do no further work.
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('skips a session already nudged (persisted outbound history)', async () => {
    const session = freshSession();
    setOpener(session.id, 'following up on the deploy');
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
    setOpener(session.id, 'following up on the deploy');
    outboundHistoryBySession[session.id] = [
      { timestamp: new Date().toISOString(), kind: 'chat', content: JSON.stringify({ text: 'unrelated agent reply' }) },
    ];
    collectCandidates.mockResolvedValue([]);
    await checkSession('ag-1', MG, session as never);
    expect(collectCandidates).toHaveBeenCalled();
  });

  it('skips when there are no candidates', async () => {
    const session = freshSession();
    setOpener(session.id, 'following up on the deploy');
    collectCandidates.mockResolvedValue([]);
    await checkSession('ag-1', MG, session as never);
    expect(findRelatedThread).not.toHaveBeenCalled();
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('skips when no candidate is related', async () => {
    const session = freshSession();
    setOpener(session.id, 'good morning');
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue(null);
    await checkSession('ag-1', MG, session as never);
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('posts a marked public reply, with a real Slack permalink and a quote of the matched thread, when a related thread is found', async () => {
    const session = freshSession();
    setOpener(session.id, 'following up on the deploy');
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0', rootText: 'the deploy pipeline is stuck' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
      score: 1.5,
    });

    await checkSession('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = writeOutboundDirect.mock.calls[0]!;
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe(session.id);
    expect(msg).toMatchObject({ platformId: 'slack:C1', channelType: 'slack', threadId: session.thread_id });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledOpts] = fetchMock.mock.calls[0]!;
    const url = new URL(calledUrl as string);
    expect(url.origin + url.pathname).toBe('https://slack.com/api/chat.getPermalink');
    expect(url.searchParams.get('channel')).toBe('C1');
    expect(url.searchParams.get('message_ts')).toBe('1.0');
    expect(calledOpts).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer test-bot-token' } });
    const content = JSON.parse(msg.content) as { text: string; threadNudge: boolean };
    expect(content.threadNudge).toBe(true);
    // Never the raw internal thread_id — a live-hit this regression test guards against.
    expect(content.text).not.toContain('slack:C1:1.0');
    expect(content.text).toContain('https://pp.slack.com/archives/C1/p1710000000000000');
    // The quote always ends in "…" — a consistent "this is a snippet" marker,
    // even here where the quoted text is short enough to need no truncation
    // (live feedback: it read as an odd, abruptly-complete sentence without it).
    expect(content.text).toContain('the deploy pipeline is stuck…');
  });

  it('still posts a nudge (without a link) when the Slack permalink lookup fails', async () => {
    fetchMock.mockRejectedValue(new Error('boom'));
    const session = freshSession();
    setOpener(session.id, 'following up on the deploy');
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0', rootText: 'the deploy pipeline is stuck' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
      score: 1.5,
    });

    await checkSession('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    const content = JSON.parse(writeOutboundDirect.mock.calls[0]![2].content) as { text: string };
    expect(content.text).not.toContain('slack:C1:1.0');
    expect(content.text).toContain('the related thread above');
    expect(content.text).toContain('the deploy pipeline is stuck');
  });

  it('still posts a nudge (without a link) when Slack responds ok:false — the exact live failure this regression test guards against', async () => {
    // Confirmed live: chat.getPermalink returned HTTP 200 with
    // {ok:false, error:'invalid_arguments'} the first time this shipped,
    // because it was called through slackCall's POST+JSON convention
    // instead of the GET query-string form the method actually requires.
    fetchMock.mockResolvedValue({ json: async () => ({ ok: false, error: 'invalid_arguments' }) });
    const session = freshSession();
    setOpener(session.id, 'following up on the deploy');
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0', rootText: 'the deploy pipeline is stuck' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
      score: 1.5,
    });

    await checkSession('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    const content = JSON.parse(writeOutboundDirect.mock.calls[0]![2].content) as { text: string };
    expect(content.text).not.toContain('slack:C1:1.0');
    expect(content.text).toContain('the related thread above');
  });

  it('memoizes a no-match decision — a later call for the same session does no further work', async () => {
    const session = freshSession();
    setOpener(session.id, 'good morning');
    collectCandidates.mockResolvedValue([]);

    await checkSession('ag-1', MG, session as never);
    collectCandidates.mockClear();
    await checkSession('ag-1', MG, session as never);

    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('memoizes a nudged decision — a later call for the same session never posts twice', async () => {
    const session = freshSession();
    setOpener(session.id, 'following up on the deploy');
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0', rootText: 'the deploy pipeline is stuck' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
      score: 1.5,
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
    setOpener(session.id, 'hi');
    await pollThreadNudge();
    expect(collectCandidates).not.toHaveBeenCalled();
  });

  it('still checks sessions when the wiring is stored as session_mode=shared — the router can override to per-thread per-message, so the stored label is not authoritative', async () => {
    // Regression: confirmed live on #marshall-test, whose wiring row stores
    // session_mode='shared' (the column's default) while its actual
    // sessions all carry real per-thread thread_ids, because
    // deliverToAgent's resolveThreadPolicy overrides the effective mode per
    // message. Filtering on the stored label here silently skipped the
    // channel on every poll tick; the per-session thread_id check in
    // checkSession is the only reliable gate now.
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1', session_mode: 'shared' }];
    const session = freshSession();
    sessionsByAgentGroup['ag-1'] = [session];
    setOpener(session.id, 'hi');
    collectCandidates.mockResolvedValue([]);

    await pollThreadNudge();

    expect(collectCandidates).toHaveBeenCalledTimes(1);
  });

  it('skips a session with no real thread_id even under an otherwise-checked wiring', async () => {
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1', session_mode: 'shared' }];
    const session = freshSession({ thread_id: null });
    sessionsByAgentGroup['ag-1'] = [session];
    setOpener(session.id, 'hi');

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
    setOpener(active.id, 'hi there');
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
    setOpener(good.id, 'hi there');
    setOpener(bad.id, 'hi there too');
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
    setOpener(session.id, 'hi there');
    collectCandidates.mockResolvedValue([]);

    await pollThreadNudge();
    collectCandidates.mockClear();
    await pollThreadNudge();

    expect(collectCandidates).not.toHaveBeenCalled();
  });
});

describe('handleEngagedSessionCreated', () => {
  function engagedEvent(session: Record<string, unknown>, text: string, mgOverrides: Record<string, unknown> = {}) {
    return {
      session,
      mg: { ...MG_BASE, ...mgOverrides },
      platformId: 'slack:C1',
      threadId: session.thread_id,
      sessionMode: 'per-thread',
      message: {
        id: 'msg-1',
        kind: 'chat-sdk',
        content: JSON.stringify({ text, senderId: 'U1', isMention: true }),
        timestamp: new Date().toISOString(),
      },
    } as never;
  }

  it('registers exactly one session-created hook at import time', () => {
    expect(registeredHooks).toHaveLength(1);
  });

  it('posts the STANDARD public nudge (👎 and all) and silences the agent when the mention continues another thread', async () => {
    const session = freshSession();
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue({
      candidate: { sessionId: 'sess-a', threadId: 'slack:C1:1.0', rootText: 'the deploy pipeline is stuck' },
      sharedKeywords: ['deploy'],
      reason: 'keywords',
      score: 1.5,
    });

    await handleEngagedSessionCreated(engagedEvent(session, 'any news on the deploy?'));

    // Same nudge as the poll path: same outbound id + threadNudge marker
    // (so the 👎 feedback module watches it), same text shape.
    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    const [nudgeAg, nudgeSession, nudgeMsg] = writeOutboundDirect.mock.calls[0]!;
    expect(nudgeAg).toBe(session.agent_group_id);
    expect(nudgeSession).toBe(session.id);
    expect(nudgeMsg).toMatchObject({
      id: `thread-nudge:${session.id}`,
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: session.thread_id,
    });
    const nudgeContent = JSON.parse(nudgeMsg.content) as { text: string; threadNudge: boolean };
    expect(nudgeContent.threadNudge).toBe(true);
    expect(nudgeContent.text).toContain('https://pp.slack.com/archives/C1/p1710000000000000');
    expect(nudgeContent.text).toContain('the deploy pipeline is stuck');
    expect(nudgeContent.text).toContain('👎');

    // Plus the silence note so the agent sends nothing on top of the nudge.
    expect(writeSessionMessage).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = writeSessionMessage.mock.calls[0]!;
    expect(agentGroupId).toBe(session.agent_group_id);
    expect(sessionId).toBe(session.id);
    expect(msg).toMatchObject({ channelType: 'session-echo', trigger: false });
    const content = JSON.parse(msg.content) as { text: string; echo?: unknown };
    // Marked as an echo so getThreadOpener never mistakes it for the real opener.
    expect(content.echo).toBeDefined();
    expect(content.text).toContain('Do NOT send any reply');
  });

  it('does nothing when the channel is not allowlisted', async () => {
    const session = freshSession();
    await handleEngagedSessionCreated(engagedEvent(session, 'any news on the deploy?', { id: 'mg-other' }));
    expect(collectCandidates).not.toHaveBeenCalled();
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('does nothing when no candidate matches', async () => {
    const session = freshSession();
    collectCandidates.mockResolvedValue([{ sessionId: 'sess-a', threadId: 'slack:C1:1.0' }]);
    findRelatedThread.mockReturnValue(null);
    await handleEngagedSessionCreated(engagedEvent(session, 'good morning'));
    expect(writeSessionMessage).not.toHaveBeenCalled();
  });

  it('does nothing for a session with no real thread_id', async () => {
    const session = freshSession({ thread_id: null });
    await handleEngagedSessionCreated(engagedEvent(session, 'any news on the deploy?'));
    expect(collectCandidates).not.toHaveBeenCalled();
  });
});
