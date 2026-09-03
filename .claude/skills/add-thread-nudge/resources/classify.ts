/**
 * Heuristic thread-relatedness classification (CUP-4868).
 *
 * Given a brand-new session's opening message, decide whether it's plausibly
 * a continuation of one of the channel's other recent threads. No semantic
 * index or embeddings — but NOT naive shared-word counting either (that
 * shipped first and live testing killed it: "i would like to know…" matched
 * every other politely-worded English message, 2026-09-01). The score is:
 *
 *   score = Σ (1/df(word)) over shared words × POSITION_DECAY^position
 *
 * - 1/df: a word's weight is the inverse of how many candidate openers use
 *   it — the channel's own usage defines what's common. Everyday verbs
 *   shared by most openers weigh ~nothing; a CUP id or project name unique
 *   to one thread weighs 1.0. No stopword list to maintain (the small one
 *   below survives only as a cheap first pass), works in any language.
 * - position decay: multiplied, never added — shared words are the only
 *   source of points, position only discounts. The channel's LAST thread is
 *   ×1 even if it's hours old (low-traffic channels must not decay by
 *   wall-clock; operator decision 2026-09-01).
 * - nudge only when score ≥ NUDGE_SCORE_THRESHOLD.
 *
 * Root-message lookup deliberately does NOT use
 * mailbox.getConversationRoot() — that method means "the message that
 * triggered container wake" (its own query filters `trigger = 1`), which is
 * undefined by construction for exactly the sessions this module exists to
 * catch: a top-level reply that never mentions the bot creates a session
 * with wake=false and so never gets a trigger=1 row. getThreadOpener()
 * below reads inbound history directly instead — see its own doc comment.
 */
import { isTaskThread } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { recentChannelSessions } from './sessions-query.js';
import type { Session } from '../../types.js';
import {
  CANDIDATE_LIMIT,
  CANDIDATE_MAX_AGE_MINUTES,
  MIN_KEYWORD_LENGTH,
  NUDGE_SCORE_THRESHOLD,
  POSITION_DECAY,
  ROOT_LOOKUP_HISTORY_LIMIT,
} from './config.js';

export interface CandidateThread {
  sessionId: string;
  threadId: string | null;
  rootText: string;
  rootSenderId: string;
  rootTimestamp: string;
  /** 0 = the channel's most recent candidate thread, counting up as threads
   *  get older. Assigned BEFORE dead-end/unreadable exclusions so a skipped
   *  newer thread still pushes older ones down — position reflects the
   *  channel's real timeline, not the surviving pool's. */
  position: number;
}

export interface RelatedMatch {
  candidate: CandidateThread;
  sharedKeywords: string[];
  reason: 'mention' | 'keywords';
  /** Final relevance score (word weights × position decay). For 'mention'
   *  matches this is informational only — a direct @-mention of the
   *  candidate's opener bypasses the threshold. */
  score: number;
}

/** Cold-start belt only: 1/df makes channel-common words weigh ~nothing
 *  once they repeat in the pool, but in a small/fresh pool the FIRST
 *  repetition of polite filler ("i would like to know…") would look rare.
 *  Content-free conversational English is therefore dropped up front;
 *  domain nouns stay out of this list on purpose — df handles them. */
const STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'about',
  'what',
  'when',
  'where',
  'which',
  'there',
  'their',
  'would',
  'could',
  'should',
  'please',
  'thanks',
  'hello',
  'like',
  'know',
  'want',
  'need',
  'needs',
  'going',
  'today',
  'everyone',
  'someone',
  'anyone',
  'quick',
  'still',
  'again',
  'just',
  'really',
  'right',
  'good',
  'great',
  'sure',
  'maybe',
  'status',
  'update',
  'updates',
  'latest',
  'news',
  'question',
  'questions',
  // Live-hit, real Breez traffic (2026-09-04): generic function
  // words/pronouns and meta-discourse ("will put this in reply thread")
  // that scored as if they were topical content in a small/early pool —
  // same cold-start problem, just words the first pass hadn't hit yet.
  'them',
  'were',
  'into',
  'here',
  'thread',
  'reply',
  'will',
  'look',
  'review',
  'morning',
  'afternoon',
  'evening',
]);

function parseContent(raw: string): {
  text?: string;
  sender?: string;
  senderId?: string;
  echo?: unknown;
  isMention?: boolean;
} {
  try {
    return JSON.parse(raw) as {
      text?: string;
      sender?: string;
      senderId?: string;
      echo?: unknown;
      isMention?: boolean;
    };
  } catch {
    return {};
  }
}

export interface ThreadOpener {
  timestamp: string;
  text: string;
  senderId: string;
  /** The opener @-mentioned the bot (chat-sdk's isMention flag) — i.e. this
   *  is a message TO Marshall, which the agent will answer in place. */
  isMention: boolean;
}

/**
 * The human message that actually opened this session's thread.
 *
 * Deliberately not mailbox.getConversationRoot() — see this file's module
 * doc comment. Instead, scans inbound history (newest-first) for the oldest
 * row that's a real platform chat message: kind chat/chat-sdk, not a
 * cross-session-context echo (fan.ts and backfill.ts both mark their rows
 * with an `echo` key — backfill.ts in particular writes echoes at LOWER seq
 * than the real opener, since it seeds a brand-new session before the
 * triggering message lands, so "oldest chat row" alone would return an
 * echo), and not a host-injected system message (mirrors backfill.ts's own
 * senderId/sender 'system' guard).
 */
export async function getThreadOpener(agentGroupId: string, sessionId: string): Promise<ThreadOpener | undefined> {
  const history = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    mailbox.getInboundHistory(ROOT_LOOKUP_HISTORY_LIMIT),
  );
  if (!history) return undefined;

  for (let i = history.length - 1; i >= 0; i--) {
    const row = history[i]!;
    if (row.kind !== 'chat' && row.kind !== 'chat-sdk') continue;
    const c = parseContent(row.content);
    if (c.echo !== undefined) continue;
    if (!c.text || !c.senderId || c.senderId === 'system' || c.sender === 'system') continue;
    return { timestamp: row.timestamp, text: c.text, senderId: c.senderId, isMention: c.isMention === true };
  }
  return undefined;
}

/** Lowercased, punctuation-stripped, stopword- and short-token-filtered keyword set.
 *  Mention markup is stripped first — `mentionedUserIds` already handles mentions on
 *  their own path; leaving `<@U123>` in would otherwise survive punctuation-stripping
 *  as the bare token "u123" and count as a "shared keyword" between any two messages
 *  that mention the same person, trivially satisfying the mention-bypass's relevance
 *  floor in `findRelatedThread` even with zero real topical overlap (live-hit, real
 *  Breez traffic 2026-09-03: a channel's frequently-addressed contact gets @-mentioned
 *  in nearly every message). */
export function significantKeywords(text: string): Set<string> {
  const tokens = text
    .replace(/<@[A-Z0-9]+>/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= MIN_KEYWORD_LENGTH && !STOPWORDS.has(t));
  return new Set(tokens);
}

/** Slack-style <@U123> mention ids referenced in a message. */
export function mentionedUserIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const m of text.matchAll(/<@([A-Z0-9]+)>/g)) {
    ids.add(m[1]!);
  }
  return ids;
}

/**
 * A candidate thread nobody should be pointed at: its only content beyond
 * the opener is Marshall's own nudge (and/or the dismissal of one) — no
 * agent answer, no human replies. Live-hit (2026-09-01): nudges chained
 * into nudges, each linking a thread whose sole message was another nudge.
 * A thread with just one unanswered HUMAN message is NOT a dead end — that
 * is exactly the classic "continue the conversation there" target.
 */
async function isDeadEndThread(agentGroupId: string, sessionId: string): Promise<boolean> {
  const data = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) => ({
    inbound: mailbox.getInboundHistory(ROOT_LOOKUP_HISTORY_LIMIT),
    outbound: mailbox.getOutboundHistory(20),
  }));
  if (!data) return false;

  const outboundMarked = data.outbound.map((row) => {
    try {
      const c = JSON.parse(row.content) as { threadNudge?: boolean; threadNudgeDismissal?: boolean };
      return c.threadNudge === true || c.threadNudgeDismissal === true;
    } catch {
      return false;
    }
  });
  const hasNudge = outboundMarked.some(Boolean);
  const hasRealOutbound = outboundMarked.some((marked) => !marked);
  if (!hasNudge || hasRealOutbound) return false;

  const realInbound = data.inbound.filter((row) => {
    if (row.kind !== 'chat' && row.kind !== 'chat-sdk') return false;
    const c = parseContent(row.content);
    return c.echo === undefined && !!c.text && !!c.senderId && c.senderId !== 'system' && c.sender !== 'system';
  });
  return realInbound.length <= 1;
}

/**
 * The channel's last CANDIDATE_LIMIT threads (same agent group + messaging
 * group, active, older than the message being checked) with their opening
 * messages — the candidate pool a new top-level message might belong to.
 * Position is the primary cutoff (see config.ts); the age ceiling is
 * sanity/cost only. Dead-end threads (nudge-only content) are excluded but
 * still occupy their position in the timeline.
 */
export async function collectCandidates(
  agentGroupId: string,
  session: Session,
  messagingGroupId: string,
): Promise<CandidateThread[]> {
  const cutoff = Date.now() - CANDIDATE_MAX_AGE_MINUTES * 60_000;
  // A message can only be a continuation of something said BEFORE it — never
  // after. Without this, a sibling created later than `session` could get
  // picked as a "candidate" the new message is supposedly replying to,
  // which breaks the memoization safety argument in index.ts (a decided
  // session's outcome never changes on a later tick precisely because
  // candidates are always older, never newer).
  const sessionCreatedAt = Date.parse(session.created_at);

  // thread_id === null means a non-threaded/shared-mode session — there's
  // no navigable thread to point a nudge at, so it can't be a candidate.
  const siblings = (await recentChannelSessions(agentGroupId, messagingGroupId, CANDIDATE_MAX_AGE_MINUTES * 60_000))
    .filter(
      (s) =>
        s.id !== session.id &&
        s.thread_id !== null &&
        !isTaskThread(s.thread_id) &&
        !Number.isNaN(Date.parse(s.created_at)) &&
        Date.parse(s.created_at) >= cutoff &&
        (Number.isNaN(sessionCreatedAt) || Date.parse(s.created_at) < sessionCreatedAt),
    )
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, CANDIDATE_LIMIT);

  const candidates: CandidateThread[] = [];
  for (const [position, sibling] of siblings.entries()) {
    const opener = await getThreadOpener(agentGroupId, sibling.id);
    if (!opener) continue;
    if (await isDeadEndThread(agentGroupId, sibling.id)) continue;

    candidates.push({
      sessionId: sibling.id,
      threadId: sibling.thread_id,
      rootText: opener.text,
      rootSenderId: opener.senderId,
      rootTimestamp: opener.timestamp,
      position,
    });
  }
  return candidates;
}

/**
 * Pick the best-matching candidate for a new message, if any clears the
 * relevance bar. A direct @-mention of a candidate thread's opener is
 * always a match (strong signal, bypasses the score threshold); otherwise:
 *
 *   score = Σ (1 / df(word)) over shared words × POSITION_DECAY^position
 *
 * where df(word) = how many candidate openers contain that word. See the
 * module doc comment for the rationale; NUDGE_SCORE_THRESHOLD gates the
 * result.
 */
export function findRelatedThread(messageText: string, candidates: CandidateThread[]): RelatedMatch | null {
  const mentions = mentionedUserIds(messageText);
  const messageKeywords = significantKeywords(messageText);

  // Document frequency over the candidate pool: the channel's own recent
  // usage defines how much information each word carries.
  const df = new Map<string, number>();
  const keywordsByCandidate = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const kw = significantKeywords(candidate.rootText);
    keywordsByCandidate.set(candidate.sessionId, kw);
    for (const w of kw) df.set(w, (df.get(w) ?? 0) + 1);
  }

  let best: RelatedMatch | null = null;

  for (const candidate of candidates) {
    const candidateKeywords = keywordsByCandidate.get(candidate.sessionId)!;
    const shared = [...messageKeywords].filter((k) => candidateKeywords.has(k));
    const wordScore = shared.reduce((sum, w) => sum + 1 / (df.get(w) ?? 1), 0);
    const score = wordScore * POSITION_DECAY ** candidate.position;

    // A direct @-mention of the candidate's opener bypasses the score
    // THRESHOLD, but never the relevance floor (shared.length > 0): a
    // channel's frequently-addressed contact (the person everyone escalates
    // to) gets @-mentioned in nearly every message, so a bare mention with
    // zero shared keywords carries no information about which of their
    // threads is meant. Live-hit on real Breez traffic (2026-09-03): bare
    // mentions of the channel's go-to contact "matched" unrelated threads at
    // score=0.000, and — because this used to return on the first mention
    // hit by position order — sometimes pre-empted a later candidate that
    // actually scored well on real keyword overlap. Now every candidate is
    // scored and the single best-scoring eligible one wins, mention or not.
    const isMentionMatch = mentions.has(candidate.rootSenderId) && shared.length > 0;
    const eligible = isMentionMatch || score >= NUDGE_SCORE_THRESHOLD;
    if (eligible && (!best || score > best.score)) {
      best = { candidate, sharedKeywords: shared, reason: isMentionMatch ? 'mention' : 'keywords', score };
    }
  }

  return best;
}
