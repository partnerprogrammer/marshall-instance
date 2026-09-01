/**
 * Thread-nudge dismissal feedback (CUP-4870): the poll gating, the
 * only-the-nudged-person's-👎-counts rule, the public dismissal post that
 * doubles as the persistence marker, and the operator DM. Reaction reads
 * go through a mocked global fetch (conversations.replies is GET-only,
 * same reasoning as slackPermalink in the nudge module).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const messagingGroups: Record<string, unknown> = {};
const wiringsByMg: Record<string, Array<{ agent_group_id: string }>> = {};
const sessionsByAgentGroup: Record<string, Array<Record<string, unknown>>> = {};
const outboundHistoryBySession: Record<string, Array<{ timestamp: string; kind: string; content: string }>> = {};
const openersBySession: Record<string, { timestamp: string; text: string; senderId: string } | undefined> = {};
const deliveredNudgeTs = vi.fn();
const writeOutboundDirect = vi.fn();
const adapterDeliver = vi.fn();
const pickApprover = vi.fn();
const pickApprovalDelivery = vi.fn();
const slackPermalink = vi.fn();
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: async (id: string) => messagingGroups[id],
  getMessagingGroupAgents: async (id: string) => wiringsByMg[id] ?? [],
}));
vi.mock('../../db/sessions.js', () => ({
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));
vi.mock('../thread-nudge/sessions-query.js', () => ({
  recentChannelSessions: async (agentGroupId: string, mgId: string, windowMs: number) =>
    (sessionsByAgentGroup[agentGroupId] ?? []).filter(
      (s) =>
        s.messaging_group_id === mgId &&
        s.status === 'active' &&
        Date.parse(s.created_at as string) >= Date.now() - windowMs,
    ),
}));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: async (_g: string, sessionId: string, action: (m: unknown) => unknown) =>
    action({ getOutboundHistory: () => outboundHistoryBySession[sessionId] ?? [] }),
  writeOutboundDirect,
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({ deliver: adapterDeliver }),
}));
vi.mock('../approvals/primitive.js', () => ({ pickApprover, pickApprovalDelivery }));
vi.mock('../thread-nudge/classify.js', () => ({
  getThreadOpener: async (_g: string, sessionId: string) => openersBySession[sessionId],
}));
// Mocking the nudge module's index also prevents its import-time
// setInterval from starting during this test run.
vi.mock('../thread-nudge/index.js', () => ({ slackPermalink }));
vi.mock('../thread-nudge/config.js', () => ({
  THREAD_NUDGE_MESSAGING_GROUPS: new Set(['mg-internal']),
}));
vi.mock('../../channels/slack-lib.js', () => ({
  botTokenKeyForInstance: () => 'SLACK_BOT_TOKEN_TEST',
}));
vi.mock('../../env.js', () => ({
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.map((k) => [k, 'test-bot-token'])),
}));
vi.mock('./delivered.js', () => ({ deliveredNudgeTs }));
vi.mock('./config.js', () => ({
  // Large enough that the module-level setInterval never fires in tests.
  FEEDBACK_POLL_INTERVAL_MS: 999_999_999,
  DISMISSAL_WATCH_WINDOW_MINUTES: 24 * 60,
  DISMISS_REACTIONS: ['-1', 'thumbsdown'],
}));

const { checkFeedback, pollThreadNudgeFeedback } = await import('./index.js');

let sessionCounter = 0;
function freshSession(overrides: Record<string, unknown> = {}) {
  sessionCounter += 1;
  return {
    id: `fsess-${sessionCounter}`,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-internal',
    thread_id: `slack:C1:${sessionCounter}.0`,
    status: 'active',
    created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    ...overrides,
  };
}

const MG_BASE = {
  id: 'mg-internal',
  channel_type: 'slack',
  platform_id: 'slack:C1',
  is_group: 1,
  name: 'test-channel',
};
const MG = MG_BASE as never;

const OPENER_ID = 'U_OPENER';

function setOpener(sessionId: string): void {
  openersBySession[sessionId] = {
    timestamp: new Date().toISOString(),
    text: 'the nudged message',
    senderId: OPENER_ID,
  };
}

/** conversations.replies response whose nudge message (ts 'nudge.ts')
 *  carries the given reactions. */
function repliesWith(reactions: Array<{ name: string; users: string[] }>): void {
  fetchMock.mockResolvedValue({
    json: async () => ({
      ok: true,
      messages: [
        { ts: 'thread.ts', reactions: [] },
        { ts: 'nudge.ts', reactions },
      ],
    }),
  });
}

beforeEach(() => {
  for (const key of Object.keys(messagingGroups)) delete messagingGroups[key];
  for (const key of Object.keys(wiringsByMg)) delete wiringsByMg[key];
  for (const key of Object.keys(sessionsByAgentGroup)) delete sessionsByAgentGroup[key];
  for (const key of Object.keys(outboundHistoryBySession)) delete outboundHistoryBySession[key];
  for (const key of Object.keys(openersBySession)) delete openersBySession[key];
  deliveredNudgeTs.mockReset();
  deliveredNudgeTs.mockReturnValue('nudge.ts');
  writeOutboundDirect.mockReset();
  adapterDeliver.mockReset();
  pickApprover.mockReset();
  pickApprover.mockResolvedValue(['slack:U_OPERATOR']);
  pickApprovalDelivery.mockReset();
  pickApprovalDelivery.mockResolvedValue({
    userId: 'slack:U_OPERATOR',
    messagingGroup: { channel_type: 'slack', platform_id: 'slack:D_OP', instance: 'slack' },
  });
  slackPermalink.mockReset();
  slackPermalink.mockResolvedValue('https://pp.slack.com/archives/C1/p123');
  fetchMock.mockReset();
  repliesWith([]);
});

describe('checkFeedback', () => {
  it('skips sessions with no real thread_id', async () => {
    await checkFeedback('ag-1', MG, freshSession({ thread_id: null }) as never);
    expect(deliveredNudgeTs).not.toHaveBeenCalled();
  });

  it('skips task-thread sessions', async () => {
    await checkFeedback('ag-1', MG, freshSession({ thread_id: 'system:tasks:t-1' }) as never);
    expect(deliveredNudgeTs).not.toHaveBeenCalled();
  });

  it('skips sessions older than the watch window', async () => {
    const session = freshSession({ created_at: new Date(Date.now() - 25 * 60 * 60_000).toISOString() });
    await checkFeedback('ag-1', MG, session as never);
    expect(deliveredNudgeTs).not.toHaveBeenCalled();
  });

  it('does nothing for a session that was never nudged (no delivered nudge ts)', async () => {
    deliveredNudgeTs.mockReturnValue(null);
    const session = freshSession();
    setOpener(session.id);
    await checkFeedback('ag-1', MG, session as never);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeOutboundDirect).not.toHaveBeenCalled();
  });

  it('memoizes a dismissal already persisted in outbound history — never re-posts after a restart', async () => {
    const session = freshSession();
    setOpener(session.id);
    outboundHistoryBySession[session.id] = [
      {
        timestamp: new Date().toISOString(),
        kind: 'chat',
        content: JSON.stringify({ text: 'dismissed earlier', threadNudgeDismissal: true }),
      },
    ];
    await checkFeedback('ag-1', MG, session as never);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(writeOutboundDirect).not.toHaveBeenCalled();

    // Memoized: a later call does not even re-read history.
    deliveredNudgeTs.mockClear();
    await checkFeedback('ag-1', MG, session as never);
    expect(deliveredNudgeTs).not.toHaveBeenCalled();
  });

  it('keeps watching (no memo, no post) while the nudge has no dismiss reaction', async () => {
    const session = freshSession();
    setOpener(session.id);
    repliesWith([{ name: 'eyes', users: [OPENER_ID] }]);

    await checkFeedback('ag-1', MG, session as never);
    expect(writeOutboundDirect).not.toHaveBeenCalled();

    // Still watched: the next call checks reactions again.
    fetchMock.mockClear();
    repliesWith([]);
    await checkFeedback('ag-1', MG, session as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a 👎 from anyone who is NOT the nudged person — only the flagged user's dismissal counts", async () => {
    const session = freshSession();
    setOpener(session.id);
    repliesWith([{ name: '-1', users: ['U_SOMEONE_ELSE', 'U_ANOTHER'] }]);

    await checkFeedback('ag-1', MG, session as never);

    expect(writeOutboundDirect).not.toHaveBeenCalled();
    expect(adapterDeliver).not.toHaveBeenCalled();
  });

  it('posts a public dismissal in the same thread and DMs the operator when the nudged person reacts 👎', async () => {
    const session = freshSession();
    setOpener(session.id);
    repliesWith([{ name: '-1', users: ['U_SOMEONE_ELSE', OPENER_ID] }]);

    await checkFeedback('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    const [agentGroupId, sessionId, msg] = writeOutboundDirect.mock.calls[0]!;
    expect(agentGroupId).toBe('ag-1');
    expect(sessionId).toBe(session.id);
    expect(msg).toMatchObject({
      id: `thread-nudge-dismissal:${session.id}`,
      platformId: 'slack:C1',
      channelType: 'slack',
      threadId: session.thread_id,
    });
    const content = JSON.parse(msg.content) as { text: string; threadNudgeDismissal: boolean };
    expect(content.threadNudgeDismissal).toBe(true);
    expect(content.text).toContain(`<@${OPENER_ID}>`);

    expect(pickApprover).toHaveBeenCalledWith('ag-1');
    expect(adapterDeliver).toHaveBeenCalledTimes(1);
    const [dmChannelType, dmPlatformId, dmThreadId, dmKind, dmContent] = adapterDeliver.mock.calls[0]!;
    expect(dmChannelType).toBe('slack');
    expect(dmPlatformId).toBe('slack:D_OP');
    expect(dmThreadId).toBeNull();
    expect(dmKind).toBe('chat');
    const dmText = (JSON.parse(dmContent) as { text: string }).text;
    expect(dmText).toContain(`<@${OPENER_ID}>`);
    expect(dmText).toContain('#test-channel');
    expect(dmText).toContain('https://pp.slack.com/archives/C1/p123');
  });

  it('memoizes a posted dismissal — a later call for the same session never posts twice', async () => {
    const session = freshSession();
    setOpener(session.id);
    repliesWith([{ name: '-1', users: [OPENER_ID] }]);

    await checkFeedback('ag-1', MG, session as never);
    await checkFeedback('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    expect(adapterDeliver).toHaveBeenCalledTimes(1);
  });

  it('counts skin-tone variants of 👎', async () => {
    const session = freshSession();
    setOpener(session.id);
    repliesWith([{ name: '-1::skin-tone-3', users: [OPENER_ID] }]);

    await checkFeedback('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
  });

  it('retries next tick when the reactions read fails — never gives up on a watched nudge', async () => {
    const session = freshSession();
    setOpener(session.id);
    fetchMock.mockRejectedValue(new Error('network down'));

    await expect(checkFeedback('ag-1', MG, session as never)).resolves.toBeUndefined();
    expect(writeOutboundDirect).not.toHaveBeenCalled();

    repliesWith([{ name: '-1', users: [OPENER_ID] }]);
    await checkFeedback('ag-1', MG, session as never);
    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
  });

  it('still posts the public dismissal when no operator is reachable for the DM', async () => {
    pickApprovalDelivery.mockResolvedValue(null);
    const session = freshSession();
    setOpener(session.id);
    repliesWith([{ name: '-1', users: [OPENER_ID] }]);

    await checkFeedback('ag-1', MG, session as never);

    expect(writeOutboundDirect).toHaveBeenCalledTimes(1);
    expect(adapterDeliver).not.toHaveBeenCalled();
  });
});

describe('pollThreadNudgeFeedback', () => {
  it('skips when the allowlisted messaging group no longer exists', async () => {
    await pollThreadNudgeFeedback();
    expect(deliveredNudgeTs).not.toHaveBeenCalled();
  });

  it('skips a DM (is_group = 0) even if allowlisted', async () => {
    messagingGroups['mg-internal'] = { ...MG_BASE, is_group: 0 };
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1' }];
    const session = freshSession();
    sessionsByAgentGroup['ag-1'] = [session];
    setOpener(session.id);
    await pollThreadNudgeFeedback();
    expect(deliveredNudgeTs).not.toHaveBeenCalled();
  });

  it('only checks active sessions belonging to the polled messaging group', async () => {
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1' }];
    const active = freshSession();
    const closed = freshSession({ status: 'closed' });
    const otherMg = freshSession({ messaging_group_id: 'mg-other' });
    sessionsByAgentGroup['ag-1'] = [active, closed, otherMg];
    setOpener(active.id);
    deliveredNudgeTs.mockReturnValue(null);

    await pollThreadNudgeFeedback();

    expect(deliveredNudgeTs).toHaveBeenCalledTimes(1);
    expect(deliveredNudgeTs).toHaveBeenCalledWith('ag-1', active.id);
  });

  it('keeps checking remaining sessions when one session throws', async () => {
    messagingGroups['mg-internal'] = MG_BASE;
    wiringsByMg['mg-internal'] = [{ agent_group_id: 'ag-1' }];
    const bad = freshSession();
    const good = freshSession();
    sessionsByAgentGroup['ag-1'] = [bad, good];
    setOpener(bad.id);
    setOpener(good.id);
    deliveredNudgeTs.mockImplementation((_ag: string, sessionId: string) => {
      if (sessionId === bad.id) throw new Error('boom');
      return null;
    });

    await expect(pollThreadNudgeFeedback()).resolves.toBeUndefined();
    expect(deliveredNudgeTs).toHaveBeenCalledTimes(2);
  });
});
