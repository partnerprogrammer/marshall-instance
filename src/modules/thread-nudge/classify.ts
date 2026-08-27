/**
 * Heuristic thread-relatedness classification (CUP-4868).
 *
 * Given a brand-new session's opening message, decide whether it's plausibly
 * a continuation of one of the channel's other recently-active threads —
 * the "this looks like a reply that landed at the top level" case. No
 * semantic index or embeddings, same posture as the rest of
 * cross-session-context: recency-bounded candidates + keyword/mention
 * overlap. Tune thresholds in config.ts during internal testing.
 */
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { CANDIDATE_LIMIT, CANDIDATE_MAX_AGE_MINUTES, MIN_KEYWORD_LENGTH, MIN_SHARED_KEYWORDS } from './config.js';

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

function parseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw) as { text?: string; sender?: string; senderId?: string };
  } catch {
    return {};
  }
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
  const siblings = (await getSessionsByAgentGroup(agentGroupId)).filter(
    (s) =>
      s.id !== session.id &&
      s.status === 'active' &&
      s.messaging_group_id === messagingGroupId &&
      !(s.thread_id !== null && isTaskThread(s.thread_id)),
  );
  if (siblings.length === 0) return [];

  const cutoff = Date.now() - CANDIDATE_MAX_AGE_MINUTES * 60_000;
  const candidates: CandidateThread[] = [];

  for (const sibling of siblings) {
    const root = await withExistingMailboxSession(agentGroupId, sibling.id, (mailbox) => mailbox.getConversationRoot());
    if (!root) continue;
    const rootTime = Date.parse(root.timestamp);
    if (Number.isNaN(rootTime) || rootTime < cutoff) continue;

    const c = parseContent(root.content);
    if (!c.text || !c.senderId) continue;

    candidates.push({
      sessionId: sibling.id,
      threadId: sibling.thread_id,
      rootText: c.text,
      rootSenderId: c.senderId,
      rootTimestamp: root.timestamp,
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
