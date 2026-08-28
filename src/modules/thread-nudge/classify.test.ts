/**
 * Thread-nudge heuristic classification (CUP-4868): candidate gathering
 * (recent sibling threads in the same channel) and relatedness matching
 * (mention or keyword overlap, no semantic index).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

interface HistoryRow {
  timestamp: string;
  kind: string;
  content: string;
}

let siblingSessions: Array<{
  id: string;
  status: string;
  messaging_group_id: string | null;
  thread_id: string | null;
}> = [];
let historyBySession: Record<string, HistoryRow[] | undefined> = {};

vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: () => siblingSessions,
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: (_g: string, sessionId: string, fn: (mailbox: unknown) => unknown) =>
    fn({ getInboundHistory: () => historyBySession[sessionId] ?? [] }),
}));

const { collectCandidates, findRelatedThread, getThreadOpener, significantKeywords, mentionedUserIds } =
  await import('./classify.js');

function chat(text: string, senderId = 'U1'): string {
  return JSON.stringify({ text, sender: 'someone', senderId });
}

/** A sibling's inbound history as getInboundHistory returns it: newest-first
 *  (seq DESC). A single real opener row, matching the common case. */
function rootHistory(timestamp: string, text: string, senderId = 'U1'): HistoryRow[] {
  return [{ timestamp, kind: 'chat-sdk', content: chat(text, senderId) }];
}

const NEW_SESSION_BASE = {
  id: 'sess-new',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: 'slack:C1:9.0',
  created_at: new Date().toISOString(),
};
const NEW_SESSION = NEW_SESSION_BASE as never;

beforeEach(() => {
  siblingSessions = [];
  historyBySession = {};
});

describe('collectCandidates', () => {
  it('returns active siblings in the same messaging group, newest first', async () => {
    siblingSessions = [
      { id: 'sess-old-1', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' },
      { id: 'sess-old-2', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:2.0' },
      { id: 'sess-other-channel', status: 'active', messaging_group_id: 'mg-2', thread_id: 'slack:C2:1.0' },
      { id: 'sess-closed', status: 'closed', messaging_group_id: 'mg-1', thread_id: 'slack:C1:3.0' },
    ];
    historyBySession = {
      'sess-old-1': rootHistory(new Date(Date.now() - 60 * 60_000).toISOString(), 'deploy pipeline is stuck'),
      'sess-old-2': rootHistory(new Date(Date.now() - 30 * 60_000).toISOString(), 'client asked about invoice'),
    };

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => c.sessionId)).toEqual(['sess-old-2', 'sess-old-1']);
  });

  it('excludes task-thread siblings and siblings with no root row', async () => {
    siblingSessions = [
      { id: 'sess-task', status: 'active', messaging_group_id: 'mg-1', thread_id: 'system:tasks:t-1' },
      { id: 'sess-no-root', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' },
    ];
    historyBySession = {};

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toEqual([]);
  });

  it('excludes a sibling with no real thread_id (non-threaded/shared-mode session)', async () => {
    // There's no navigable thread to point a nudge at, so it can't be a
    // candidate even if its opening message would otherwise match well.
    siblingSessions = [{ id: 'sess-shared', status: 'active', messaging_group_id: 'mg-1', thread_id: null }];
    historyBySession = {
      'sess-shared': rootHistory(new Date(Date.now() - 5 * 60_000).toISOString(), 'deploy pipeline is stuck'),
    };

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toEqual([]);
  });

  it('excludes siblings whose root message is older than the recency window', async () => {
    siblingSessions = [{ id: 'sess-stale', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' }];
    historyBySession = {
      'sess-stale': rootHistory('2020-01-01T00:00:00Z', 'ancient thread'),
    };

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toEqual([]);
  });

  it('finds a sibling whose only message never triggered its container (wake=false) — the CUP-4868 target case', async () => {
    // Regression: mailbox.getConversationRoot() only returns rows written
    // with trigger=1 (i.e. wake=true), so a sibling that only ever posted a
    // top-level message without mentioning the bot was previously invisible
    // as a candidate — exactly the sessions this module exists to nudge.
    siblingSessions = [
      { id: 'sess-never-engaged', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' },
    ];
    historyBySession = {
      'sess-never-engaged': rootHistory(new Date(Date.now() - 5 * 60_000).toISOString(), 'deploy pipeline is stuck'),
    };

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => c.sessionId)).toEqual(['sess-never-engaged']);
  });

  it('skips cross-session-context echo rows seeded before the real opener', async () => {
    // backfill.ts writes echo rows at LOWER seq than the real triggering
    // message, so getInboundHistory's oldest-first walk would otherwise
    // return an echo (someone else's message, quoted for context) as this
    // sibling's "opener".
    siblingSessions = [{ id: 'sess-seeded', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' }];
    historyBySession = {
      'sess-seeded': [
        {
          timestamp: new Date(Date.now() - 4 * 60_000).toISOString(),
          kind: 'chat-sdk',
          content: chat('the real opening message', 'U2'),
        },
        {
          timestamp: new Date(Date.now() - 6 * 60_000).toISOString(),
          kind: 'chat',
          content: JSON.stringify({
            text: 'echoed context from another thread',
            senderId: 'U3',
            echo: { surface: 'x', label: 'y' },
          }),
        },
      ],
    };

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.rootText).toBe('the real opening message');
  });

  it('excludes a sibling whose opener is newer than the session being checked', async () => {
    // A message can only continue something said BEFORE it. A sibling
    // created after `session` must never be offered as a candidate, even if
    // it would otherwise score well — this is the invariant index.ts's
    // memoization relies on (a decided session's outcome never changes on a
    // later tick because candidates are always older, never newer).
    const newSession = { ...NEW_SESSION_BASE, created_at: new Date(Date.now() - 10 * 60_000).toISOString() } as never;
    siblingSessions = [{ id: 'sess-future', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' }];
    historyBySession = {
      'sess-future': rootHistory(new Date().toISOString(), 'deploy pipeline is stuck'),
    };

    const candidates = await collectCandidates('ag-1', newSession, 'mg-1');

    expect(candidates).toEqual([]);
  });
});

describe('getThreadOpener', () => {
  it("surfaces the opener's isMention flag (true when the message @-mentioned the bot, false otherwise)", async () => {
    siblingSessions = [];
    historyBySession['sess-m'] = [
      {
        timestamp: new Date().toISOString(),
        kind: 'chat-sdk',
        content: JSON.stringify({ text: 'hey bot', senderId: 'U1', isMention: true }),
      },
    ];
    historyBySession['sess-plain'] = rootHistory(new Date().toISOString(), 'just humans talking');

    expect((await getThreadOpener('ag-1', 'sess-m'))?.isMention).toBe(true);
    expect((await getThreadOpener('ag-1', 'sess-plain'))?.isMention).toBe(false);
  });
});

describe('findRelatedThread', () => {
  const candidates = [
    {
      sessionId: 'sess-a',
      threadId: 'slack:C1:1.0',
      rootText: 'the deploy pipeline is stuck on the staging environment',
      rootSenderId: 'U100',
      rootTimestamp: '2026-08-24T10:00:00Z',
    },
    {
      sessionId: 'sess-b',
      threadId: 'slack:C1:2.0',
      rootText: 'client asked about the invoice for last month',
      rootSenderId: 'U200',
      rootTimestamp: '2026-08-24T12:00:00Z',
    },
  ];

  it('matches on a direct mention of a candidate thread opener', () => {
    const match = findRelatedThread('following up on this <@U200> any update?', candidates);
    expect(match?.candidate.sessionId).toBe('sess-b');
    expect(match?.reason).toBe('mention');
  });

  it('matches on shared significant keywords above the threshold', () => {
    const match = findRelatedThread('any news on the staging deploy pipeline?', candidates);
    expect(match?.candidate.sessionId).toBe('sess-a');
    expect(match?.reason).toBe('keywords');
    expect(match?.sharedKeywords.sort()).toEqual(['deploy', 'pipeline', 'staging'].sort());
  });

  it('returns null when nothing clears the relatedness bar', () => {
    const match = findRelatedThread('good morning everyone, happy friday!', candidates);
    expect(match).toBeNull();
  });
});

describe('significantKeywords', () => {
  it('lowercases, strips punctuation, and drops short/stopword tokens', () => {
    // "hello"/"what"/"about" are stopwords, "the" is below MIN_KEYWORD_LENGTH.
    expect(significantKeywords('Hello! What about the Deploy-Pipeline?')).toEqual(new Set(['deploy', 'pipeline']));
  });
});

describe('mentionedUserIds', () => {
  it('extracts slack-style mention ids', () => {
    expect(mentionedUserIds('hey <@U123> and <@U456>, see above')).toEqual(new Set(['U123', 'U456']));
  });

  it('returns an empty set when there are no mentions', () => {
    expect(mentionedUserIds('no mentions here')).toEqual(new Set());
  });
});
