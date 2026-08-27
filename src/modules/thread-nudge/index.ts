/**
 * Thread nudge (CUP-4868).
 *
 * Polls allowlisted channels on its own timer (see config.ts for why: no
 * router hook fires for a top-level message that never engages Marshall,
 * which is exactly the "human replies at the top level instead of in the
 * thread" case this exists to catch). For each recent, not-yet-decided
 * top-level session, checks whether it looks like a continuation of another
 * recently-active thread in the same channel, and if so, publicly points
 * that out as a reply in the message's own thread.
 *
 * Public by design (CUP-4850 decision, 2026-08-24): a private/DM nudge was
 * tried first and rejected — it removes the social-accountability effect and
 * risks becoming a DM people learn to ignore. Dismissal handling (CUP-4870)
 * is a separate module layered on top of the message this posts.
 *
 * Per-session decisions are memoized in-process: once a session is checked,
 * its outcome (nudged or no-match) never changes on a later tick, because
 * only a *newer* message ever gets nudged toward an *older* related thread —
 * never the reverse. So each session needs exactly one real check, however
 * often the timer fires; a shorter POLL_INTERVAL_MS only shrinks how soon a
 * newly-created session gets its one check, not how much repeat work happens
 * per tick. The memo resets on restart, which is fine: the persisted
 * outbound-history check in isNudged() is the correctness backstop that
 * keeps a restart from posting a duplicate.
 */
import { getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, writeOutboundDirect } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { collectCandidates, findRelatedThread } from './classify.js';
import { NUDGE_CHECK_WINDOW_MINUTES, POLL_INTERVAL_MS, THREAD_NUDGE_MESSAGING_GROUPS } from './config.js';

function parseMessageText(raw: string): string | null {
  try {
    const c = JSON.parse(raw) as { text?: string };
    return c.text ?? null;
  } catch {
    return null;
  }
}

function nudgeText(threadId: string | null): string {
  const pointer = threadId ? `the thread above (<${threadId}>)` : 'the related thread above';
  return (
    `This looks like it might belong in ${pointer} instead of starting fresh here — ` +
    `want to continue the conversation there? (Marshall is trying out thread nudges — ` +
    `react 👎 if this one's off.)`
  );
}

/** Has this session already gotten a thread-nudge? Checked against persisted
 *  outbound history, not just the in-memory decision cache, so a host
 *  restart never produces a duplicate nudge for a session already handled
 *  in a prior run. */
async function alreadyNudged(agentGroupId: string, sessionId: string): Promise<boolean> {
  const history = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    mailbox.getOutboundHistory(20),
  );
  if (!history) return false;
  return history.some((row) => {
    try {
      return (JSON.parse(row.content) as { threadNudge?: boolean }).threadNudge === true;
    } catch {
      return false;
    }
  });
}

/** sessionId -> createdAt (ms). Decided sessions (nudged or no-match) are
 *  never re-evaluated — see the module doc comment for why that's safe.
 *  createdAt is kept alongside so decided() can prune entries once a
 *  session ages out of NUDGE_CHECK_WINDOW_MINUTES, bounding the map's size
 *  across a long-running process instead of growing it forever. */
const decided = new Map<string, number>();

function pruneDecided(): void {
  const cutoff = Date.now() - NUDGE_CHECK_WINDOW_MINUTES * 60_000;
  for (const [sessionId, createdAt] of decided) {
    if (createdAt < cutoff) decided.delete(sessionId);
  }
}

export async function checkSession(agentGroupId: string, mg: MessagingGroup, session: Session): Promise<void> {
  if (session.thread_id !== null && isTaskThread(session.thread_id)) return;
  if (decided.has(session.id)) return;

  const createdAt = Date.parse(session.created_at);
  if (Number.isNaN(createdAt) || Date.now() - createdAt > NUDGE_CHECK_WINDOW_MINUTES * 60_000) return;

  const root = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) => mailbox.getConversationRoot());
  if (!root) return;

  const text = parseMessageText(root.content);
  if (!text) return;

  if (await alreadyNudged(agentGroupId, session.id)) {
    decided.set(session.id, createdAt);
    return;
  }

  const candidates = await collectCandidates(agentGroupId, session, mg.id);
  if (candidates.length === 0) {
    decided.set(session.id, createdAt);
    return;
  }

  const match = findRelatedThread(text, candidates);
  if (!match) {
    decided.set(session.id, createdAt);
    return;
  }

  await writeOutboundDirect(agentGroupId, session.id, {
    id: `thread-nudge:${session.id}`,
    kind: 'chat',
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: session.thread_id,
    content: JSON.stringify({ text: nudgeText(match.candidate.threadId), threadNudge: true }),
  });
  decided.set(session.id, createdAt);
  log.info('Thread nudge posted', { sessionId: session.id, messagingGroupId: mg.id, reason: match.reason });
}

export async function pollThreadNudge(): Promise<void> {
  pruneDecided();

  for (const messagingGroupId of THREAD_NUDGE_MESSAGING_GROUPS) {
    try {
      const mg = await getMessagingGroup(messagingGroupId);
      if (!mg || mg.is_group !== 1) continue;

      const wirings = await getMessagingGroupAgents(messagingGroupId);
      for (const wiring of wirings) {
        if (wiring.session_mode !== 'per-thread') continue;

        const sessions = (await getSessionsByAgentGroup(wiring.agent_group_id)).filter(
          (s) => s.status === 'active' && s.messaging_group_id === messagingGroupId,
        );
        for (const session of sessions) {
          try {
            await checkSession(wiring.agent_group_id, mg, session);
          } catch (err) {
            log.warn('Thread nudge check failed for session', { sessionId: session.id, err });
          }
        }
      }
    } catch (err) {
      log.warn('Thread nudge poll failed for messaging group', { messagingGroupId, err });
    }
  }
}

let pollInFlight = false;

async function pollTick(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollThreadNudge();
  } finally {
    pollInFlight = false;
  }
}

if (THREAD_NUDGE_MESSAGING_GROUPS.size > 0) {
  setInterval(() => void pollTick(), POLL_INTERVAL_MS);
}
