/**
 * Thread-nudge heuristic classification (CUP-4868): candidate gathering
 * (recent sibling threads in the same channel) and relatedness matching
 * (mention or keyword overlap, no semantic index).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

let siblingSessions: Array<{
  id: string;
  status: string;
  messaging_group_id: string | null;
  thread_id: string | null;
}> = [];
let rootsBySession: Record<string, { timestamp: string; content: string } | undefined> = {};

vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: () => siblingSessions,
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: (_g: string, sessionId: string, fn: (mailbox: unknown) => unknown) =>
    fn({ getConversationRoot: () => rootsBySession[sessionId] }),
}));

const { collectCandidates, findRelatedThread, significantKeywords, mentionedUserIds } = await import('./classify.js');

function chat(text: string, senderId = 'U1'): string {
  return JSON.stringify({ text, sender: 'someone', senderId });
}

const NEW_SESSION = {
  id: 'sess-new',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: 'slack:C1:9.0',
} as never;

beforeEach(() => {
  siblingSessions = [];
  rootsBySession = {};
});

describe('collectCandidates', () => {
  it('returns active siblings in the same messaging group, newest first', async () => {
    siblingSessions = [
      { id: 'sess-old-1', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' },
      { id: 'sess-old-2', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:2.0' },
      { id: 'sess-other-channel', status: 'active', messaging_group_id: 'mg-2', thread_id: 'slack:C2:1.0' },
      { id: 'sess-closed', status: 'closed', messaging_group_id: 'mg-1', thread_id: 'slack:C1:3.0' },
    ];
    rootsBySession = {
      'sess-old-1': {
        timestamp: new Date(Date.now() - 60 * 60_000).toISOString(),
        content: chat('deploy pipeline is stuck'),
      },
      'sess-old-2': {
        timestamp: new Date(Date.now() - 30 * 60_000).toISOString(),
        content: chat('client asked about invoice'),
      },
    };

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => c.sessionId)).toEqual(['sess-old-2', 'sess-old-1']);
  });

  it('excludes task-thread siblings and siblings with no root row', async () => {
    siblingSessions = [
      { id: 'sess-task', status: 'active', messaging_group_id: 'mg-1', thread_id: 'system:tasks:t-1' },
      { id: 'sess-no-root', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' },
    ];
    rootsBySession = {};

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toEqual([]);
  });

  it('excludes siblings whose root message is older than the recency window', async () => {
    siblingSessions = [{ id: 'sess-stale', status: 'active', messaging_group_id: 'mg-1', thread_id: 'slack:C1:1.0' }];
    rootsBySession = {
      'sess-stale': { timestamp: '2020-01-01T00:00:00Z', content: chat('ancient thread') },
    };

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toEqual([]);
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
