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
import { botTokenKeyForInstance, slackCall } from '../../channels/slack-lib.js';
import { getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, writeOutboundDirect } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import type { CandidateThread } from './classify.js';
import { collectCandidates, findRelatedThread, getThreadOpener } from './classify.js';
import {
  NUDGE_CHECK_WINDOW_MINUTES,
  NUDGE_SNIPPET_MAX_CHARS,
  POLL_INTERVAL_MS,
  THREAD_NUDGE_MESSAGING_GROUPS,
} from './config.js';

/**
 * A real, clickable Slack permalink for a `slack:<channelId>:<ts>` thread
 * id — never the raw internal thread_id string (that's an opaque host-side
 * key, not a URL; posting it to Slack as-is is unusable — a live-hit that
 * shipped once already). Returns null on any failure (non-Slack channel,
 * missing bot token, API error): a nudge must still post without a link
 * rather than not post at all.
 */
async function slackPermalink(mg: MessagingGroup, threadId: string | null): Promise<string | null> {
  if (!threadId || mg.channel_type !== 'slack') return null;
  const [scheme, channelId, ts] = threadId.split(':');
  if (scheme !== 'slack' || !channelId || !ts) return null;

  try {
    const tokenKey = botTokenKeyForInstance(mg.instance ?? mg.channel_type);
    const token = process.env[tokenKey] || readEnvFile([tokenKey])[tokenKey];
    if (!token) return null;
    const json = await slackCall(token, 'chat.getPermalink', { channel: channelId, message_ts: ts }, 'thread-nudge');
    return typeof json.permalink === 'string' ? json.permalink : null;
  } catch (err) {
    log.debug('Thread nudge permalink lookup failed (posting without a link)', { threadId, err });
    return null;
  }
}

function snippet(text: string): string {
  return text.length > NUDGE_SNIPPET_MAX_CHARS ? `${text.slice(0, NUDGE_SNIPPET_MAX_CHARS - 1)}…` : text;
}

async function nudgeText(mg: MessagingGroup, candidate: CandidateThread): Promise<string> {
  const permalink = await slackPermalink(mg, candidate.threadId);
  const pointer = permalink ? `the thread above (${permalink})` : 'the related thread above';
  return (
    `This looks like it might belong in ${pointer} — "${snippet(candidate.rootText)}" — instead of starting fresh here. ` +
    `Want to continue the conversation there? (Marshall is trying out thread nudges — ` +
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
  // A nudge is a reply posted INTO the session's own thread — a session
  // with no real thread_id (a non-threaded/shared-mode session, or a task
  // session) has nowhere to post it, so it can never be a nudge target.
  if (session.thread_id === null || isTaskThread(session.thread_id)) return;
  if (decided.has(session.id)) return;

  const createdAt = Date.parse(session.created_at);
  if (Number.isNaN(createdAt) || Date.now() - createdAt > NUDGE_CHECK_WINDOW_MINUTES * 60_000) return;

  const opener = await getThreadOpener(agentGroupId, session.id);
  if (!opener) return;
  const text = opener.text;

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
    content: JSON.stringify({ text: await nudgeText(mg, match.candidate), threadNudge: true }),
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

      // Not filtered by wiring.session_mode: that's a stored label, not the
      // router's actual per-event decision. router.ts's deliverToAgent
      // computes an EFFECTIVE mode per message (resolveThreadPolicy against
      // the channel's declared defaults + live adapter capability) that can
      // be 'per-thread' in practice even while the wiring row says 'shared'
      // — confirmed live on #marshall-test, whose wiring is stored as
      // 'shared' but whose sessions all carry real per-thread thread_ids.
      // checkSession's own thread_id check is the reliable filter.
      const wirings = await getMessagingGroupAgents(messagingGroupId);
      for (const wiring of wirings) {
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
