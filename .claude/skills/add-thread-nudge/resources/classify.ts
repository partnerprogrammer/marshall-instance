/**
 * Heuristic thread-relatedness classification (CUP-4868).
 *
 * Given a brand-new session's opening message, decide whether it's plausibly
 * a continuation of one of the channel's other recently-active threads —
 * the "this looks like a reply that landed at the top level" case. No
 * semantic index or embeddings, same posture as the rest of
 * cross-session-context: recency-bounded candidates + keyword/mention
 * overlap. Tune thresholds in config.ts during internal testing.
 *
 * Root-message lookup deliberately does NOT use
 * mailbox.getConversationRoot() — that method means "the message that
 * triggered container wake" (its own query filters `trigger = 1`), which is
 * undefined by construction for exactly the sessions this module exists to
 * catch: a top-level reply that never mentions the bot creates a session
 * with wake=false and so never gets a trigger=1 row. getThreadOpener()
 * below reads inbound history directly instead — see its own doc comment.
 */
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  CANDIDATE_LIMIT,
  CANDIDATE_MAX_AGE_MINUTES,
  MIN_KEYWORD_LENGTH,
  MIN_SHARED_KEYWORDS,
  ROOT_LOOKUP_HISTORY_LIMIT,
} from './config.js';

export interface CandidateThread {
  sessionId: string;
  threadId: string | null;
  rootText: string;
  rootSenderId: string;
  rootTimestamp: string;
}

export interface RelatedMatch {
  candidate: CandidateThread;
  sharedKeywords: string[];
  reason: 'mention' | 'keywords';
}

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

/** Lowercased, punctuation-stripped, stopword- and short-token-filtered keyword set. */
export function significantKeywords(text: string): Set<string> {
  const tokens = text
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
 * Recent sibling threads (same agent group + messaging group, active,
 * excluding the new session itself) with their opening message — the
 * candidate pool a new top-level message might actually belong to.
 */
export async function collectCandidates(
  agentGroupId: string,
  session: Session,
  messagingGroupId: string,
): Promise<CandidateThread[]> {
  // thread_id === null means a non-threaded/shared-mode session — there's
  // no navigable thread to point a nudge at, so it can't be a candidate.
  const siblings = (await getSessionsByAgentGroup(agentGroupId)).filter(
    (s) =>
      s.id !== session.id &&
      s.status === 'active' &&
      s.messaging_group_id === messagingGroupId &&
      s.thread_id !== null &&
      !isTaskThread(s.thread_id),
  );
  if (siblings.length === 0) return [];

  const cutoff = Date.now() - CANDIDATE_MAX_AGE_MINUTES * 60_000;
  // A message can only be a continuation of something said BEFORE it — never
  // after. Without this, a sibling created later than `session` (e.g. by
  // another poll target that happens to score higher) could get picked as
  // a "candidate" the new message is supposedly replying to, which breaks
  // the memoization safety argument in index.ts (a decided session's
  // outcome is assumed to never change on a later tick precisely because
  // candidates are always older, never newer).
  const sessionCreatedAt = Date.parse(session.created_at);
  const candidates: CandidateThread[] = [];

  for (const sibling of siblings) {
    const opener = await getThreadOpener(agentGroupId, sibling.id);
    if (!opener) continue;
    const rootTime = Date.parse(opener.timestamp);
    if (Number.isNaN(rootTime) || rootTime < cutoff) continue;
    if (!Number.isNaN(sessionCreatedAt) && rootTime >= sessionCreatedAt) continue;

    candidates.push({
      sessionId: sibling.id,
      threadId: sibling.thread_id,
      rootText: opener.text,
      rootSenderId: opener.senderId,
      rootTimestamp: opener.timestamp,
    });
  }

  candidates.sort((a, b) => (a.rootTimestamp < b.rootTimestamp ? 1 : a.rootTimestamp > b.rootTimestamp ? -1 : 0));
  return candidates.slice(0, CANDIDATE_LIMIT);
}

/**
 * Pick the best-matching candidate for a new message, if any clears the
 * relatedness bar. A direct @-mention of a candidate thread's opener is
 * always a match (strong signal); otherwise, distinct significant keyword
 * overlap must meet MIN_SHARED_KEYWORDS. Ties broken by recency (candidates
 * arrive pre-sorted newest-first).
 */
export function findRelatedThread(messageText: string, candidates: CandidateThread[]): RelatedMatch | null {
  const mentions = mentionedUserIds(messageText);
  const messageKeywords = significantKeywords(messageText);

  let best: RelatedMatch | null = null;

  for (const candidate of candidates) {
    if (mentions.has(candidate.rootSenderId)) {
      return { candidate, sharedKeywords: [], reason: 'mention' };
    }

    const candidateKeywords = significantKeywords(candidate.rootText);
    const shared = [...messageKeywords].filter((k) => candidateKeywords.has(k));
    if (shared.length >= MIN_SHARED_KEYWORDS && (!best || shared.length > best.sharedKeywords.length)) {
      best = { candidate, sharedKeywords: shared, reason: 'keywords' };
    }
  }

  return best;
}
