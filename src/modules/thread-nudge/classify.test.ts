/**
 * Thread-nudge relevance classification (CUP-4868, scoring model of
 * 2026-09-01): candidate pool = the channel's last CANDIDATE_LIMIT threads
 * (position is the cutoff, wall-clock only a sanity ceiling), dead-end
 * exclusion, and score = Σ(1/df) over shared words × POSITION_DECAY^position
 * gated by NUDGE_SCORE_THRESHOLD — built to kill the live false positives
 * where common English ("i would like to know…") matched everything.
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
  created_at: string;
}> = [];
let historyBySession: Record<string, HistoryRow[] | undefined> = {};
let outboundBySession: Record<string, HistoryRow[] | undefined> = {};

vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: () => siblingSessions,
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));
vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: (_g: string, sessionId: string, fn: (mailbox: unknown) => unknown) =>
    fn({
      getInboundHistory: () => historyBySession[sessionId] ?? [],
      getOutboundHistory: () => outboundBySession[sessionId] ?? [],
    }),
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

function minutesAgo(min: number): string {
  return new Date(Date.now() - min * 60_000).toISOString();
}

let siblingCounter = 0;
/** Registers a sibling session with its opener; returns its id. */
function addSibling(ageMinutes: number, text: string, senderId = 'U1'): string {
  siblingCounter += 1;
  const id = `sib-${siblingCounter}`;
  siblingSessions.push({
    id,
    status: 'active',
    messaging_group_id: 'mg-1',
    thread_id: `slack:C1:${siblingCounter}.0`,
    created_at: minutesAgo(ageMinutes),
  });
  historyBySession[id] = rootHistory(minutesAgo(ageMinutes), text, senderId);
  return id;
}

const NEW_SESSION_BASE = {
  id: 'sess-new',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-1',
  thread_id: 'slack:C1:9.0',
  created_at: new Date().toISOString(),
};
const NEW_SESSION = NEW_SESSION_BASE as never;

/** Candidate literal for findRelatedThread tests. */
function cand(
  sessionId: string,
  position: number,
  rootText: string,
  overrides: Partial<{ rootSenderId: string; threadId: string }> = {},
) {
  return {
    sessionId,
    threadId: overrides.threadId ?? `slack:C1:${position}.0`,
    rootText,
    rootSenderId: overrides.rootSenderId ?? 'U100',
    rootTimestamp: minutesAgo(position * 10),
    position,
  };
}

beforeEach(() => {
  siblingSessions = [];
  historyBySession = {};
  outboundBySession = {};
  siblingCounter = 0;
});

describe('collectCandidates', () => {
  it('returns the last threads with position 0 = newest', async () => {
    const older = addSibling(60, 'deploy pipeline is stuck');
    const newest = addSibling(30, 'client asked about invoice');

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => [c.sessionId, c.position])).toEqual([
      [newest, 0],
      [older, 1],
    ]);
  });

  it('caps the pool at CANDIDATE_LIMIT (8) most recent threads — position is the cutoff', async () => {
    for (let i = 0; i < 11; i++) addSibling(10 + i, `topic${i} discussion`);

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toHaveLength(8);
    expect(candidates[0]?.rootText).toBe('topic0 discussion');
    expect(candidates[7]?.rootText).toBe('topic7 discussion');
  });

  it('keeps a thread hours old fully in the pool — wall-clock does not expire candidates', async () => {
    // Live requirement (operator, 2026-09-01): in a low-traffic channel the
    // last conversation IS the current conversation even 2h+ later.
    const id = addSibling(5 * 60, 'prisma migration is failing');

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => [c.sessionId, c.position])).toEqual([[id, 0]]);
  });

  it('excludes threads older than the 3-day sanity ceiling', async () => {
    addSibling(4 * 24 * 60, 'archaeological thread');
    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');
    expect(candidates).toEqual([]);
  });

  it('excludes task threads, other channels, non-active sessions, and openerless threads', async () => {
    siblingSessions = [
      {
        id: 'sess-task',
        status: 'active',
        messaging_group_id: 'mg-1',
        thread_id: 'system:tasks:t-1',
        created_at: minutesAgo(10),
      },
      {
        id: 'sess-other',
        status: 'active',
        messaging_group_id: 'mg-2',
        thread_id: 'slack:C2:1.0',
        created_at: minutesAgo(10),
      },
      {
        id: 'sess-closed',
        status: 'closed',
        messaging_group_id: 'mg-1',
        thread_id: 'slack:C1:2.0',
        created_at: minutesAgo(10),
      },
      {
        id: 'sess-no-root',
        status: 'active',
        messaging_group_id: 'mg-1',
        thread_id: 'slack:C1:3.0',
        created_at: minutesAgo(10),
      },
    ];

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates).toEqual([]);
  });

  it('excludes a sibling whose opener is newer than the session being checked', async () => {
    const newSession = { ...NEW_SESSION_BASE, created_at: minutesAgo(10) } as never;
    addSibling(5, 'deploy pipeline is stuck'); // newer than the checked session

    const candidates = await collectCandidates('ag-1', newSession, 'mg-1');

    expect(candidates).toEqual([]);
  });

  it('excludes dead-end threads (nudge-only content) but keeps their position occupied', async () => {
    // Live-hit (2026-09-01): nudges chained into nudges — a thread whose
    // only content is Marshall's own nudge must never be a target, but it
    // still happened in the channel, so older threads stay pushed down.
    const deadEnd = addSibling(10, 'vercel deploy status question');
    outboundBySession[deadEnd] = [
      {
        timestamp: minutesAgo(9),
        kind: 'chat',
        content: JSON.stringify({ text: 'This looks like it might belong…', threadNudge: true }),
      },
    ];
    const real = addSibling(20, 'prisma migration is failing');

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => [c.sessionId, c.position])).toEqual([[real, 1]]);
  });

  it('keeps a nudged thread that also has a real agent answer', async () => {
    const answered = addSibling(10, 'ci status of the release');
    outboundBySession[answered] = [
      { timestamp: minutesAgo(9), kind: 'chat', content: JSON.stringify({ text: 'nudge', threadNudge: true }) },
      { timestamp: minutesAgo(8), kind: 'chat', content: JSON.stringify({ text: 'CI is green.' }) },
    ];

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => c.sessionId)).toEqual([answered]);
  });

  it('keeps a nudged thread where humans kept talking (real replies beyond the opener)', async () => {
    const busy = addSibling(10, 'workload points formula');
    historyBySession[busy] = [
      { timestamp: minutesAgo(8), kind: 'chat-sdk', content: chat('i think ×1.5 is too much', 'U2') },
      ...rootHistory(minutesAgo(10), 'workload points formula'),
    ];
    outboundBySession[busy] = [
      { timestamp: minutesAgo(9), kind: 'chat', content: JSON.stringify({ text: 'nudge', threadNudge: true }) },
    ];

    const candidates = await collectCandidates('ag-1', NEW_SESSION, 'mg-1');

    expect(candidates.map((c) => c.sessionId)).toEqual([busy]);
  });
});

describe('findRelatedThread scoring', () => {
  it('a word essentially unique to one thread clears the threshold at position 0', () => {
    const candidates = [
      cand('sess-a', 0, 'the prisma migration is failing on staging'),
      cand('sess-b', 1, 'client asked about the invoice'),
    ];
    const match = findRelatedThread('any update on that prisma issue?', candidates);
    expect(match?.candidate.sessionId).toBe('sess-a');
    expect(match?.reason).toBe('keywords');
    expect(match?.score).toBeGreaterThanOrEqual(1);
  });

  it('common polite English shared by most openers never triggers — the live "i would like to know" case', () => {
    // "like" and "know" appear in every candidate opener → df = 4 each →
    // weight 0.25 each. Total 0.5 < 1.0 even at position 0.
    const candidates = [
      cand('sess-a', 0, 'i would like to know all tasks in progress'),
      cand('sess-b', 1, 'i would like to know the deploy list'),
      cand('sess-c', 2, 'i would like to know the ci status'),
      cand('sess-d', 3, 'i would like to know the backlog'),
    ];
    const match = findRelatedThread('i would like to know about the CUP-4604 task status', candidates);
    expect(match).toBeNull();
  });

  it('an old thread needs a proportionally stronger match — position discounts, never adds', () => {
    // Unique word (weight 1.0) at position 3: 1.0 × 0.7³ = 0.343 → silence.
    const candidates = [
      cand('sess-new1', 0, 'client asked about the invoice'),
      cand('sess-new2', 1, 'standup notes for today'),
      cand('sess-new3', 2, 'lunch order coordination'),
      cand('sess-old', 3, 'the prisma migration is failing'),
    ];
    expect(findRelatedThread('any update on prisma?', candidates)).toBeNull();

    // But several rare words together still rescue an old thread:
    // 3 unique words × 0.7³ = 1.03 ≥ 1.0 → nudge.
    const strong = findRelatedThread('any update on the prisma migration failing?', candidates);
    expect(strong?.candidate.sessionId).toBe('sess-old');
  });

  it('prefers the higher-scoring candidate when several clear the bar', () => {
    const candidates = [
      cand('sess-weak', 0, 'deploy checklist for friday'),
      cand('sess-strong', 1, 'vercel deploy of pp-hub failing with prisma error'),
    ];
    // shared with weak: deploy (df=2 → 0.5) → 0.5. shared with strong:
    // deploy(0.5) + vercel(1) + prisma(1) = 2.5 × 0.7 = 1.75.
    const match = findRelatedThread('vercel deploy prisma issue again', candidates);
    expect(match?.candidate.sessionId).toBe('sess-strong');
  });

  it('a direct @-mention of a candidate opener bypasses the score threshold', () => {
    const candidates = [cand('sess-a', 4, 'totally unrelated words here', { rootSenderId: 'U200' })];
    const match = findRelatedThread('following up on this <@U200>', candidates);
    expect(match?.candidate.sessionId).toBe('sess-a');
    expect(match?.reason).toBe('mention');
  });

  it('returns null when nothing is related at all', () => {
    const candidates = [cand('sess-a', 0, 'the prisma migration is failing')];
    expect(findRelatedThread('good morning everyone, happy friday!', candidates)).toBeNull();
  });
});

describe('getThreadOpener', () => {
  it("surfaces the opener's isMention flag (true when the message @-mentioned the bot, false otherwise)", async () => {
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

  it('skips cross-session-context echo rows seeded before the real opener', async () => {
    historyBySession['sess-seeded'] = [
      {
        timestamp: minutesAgo(4),
        kind: 'chat-sdk',
        content: chat('the real opening message', 'U2'),
      },
      {
        timestamp: minutesAgo(6),
        kind: 'chat',
        content: JSON.stringify({
          text: 'echoed context from another thread',
          senderId: 'U3',
          echo: { surface: 'x', label: 'y' },
        }),
      },
    ];

    expect((await getThreadOpener('ag-1', 'sess-seeded'))?.text).toBe('the real opening message');
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
