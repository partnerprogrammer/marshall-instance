/**
 * Thread-nudge dismissal feedback (CUP-4870).
 *
 * The thread-nudge module (CUP-4868) publicly tells people "react 👎 if
 * this one's off" — this module is what makes that promise real. It polls
 * delivered nudges in the same allowlisted channels and, when the person
 * Marshall originally nudged reacts 👎 on the nudge message:
 *
 *  1. posts the dismissal publicly in the same thread (never silently
 *     swallowed — the team sees both the nudge and how it was resolved;
 *     social judgment of bad-faith dismissals stays with the team, not
 *     the bot), and
 *  2. DMs the operator (admins of the agent group → global admins →
 *     owners, same preference order as approvals) so accumulated
 *     false-positive feedback actually reaches whoever tunes detection.
 *
 * Only the nudged person's reaction counts — gated by the Slack user id
 * on the reaction, not by whoever clicks first. Detection stays a
 * heuristic; automatic self-tuning from this feedback is out of scope
 * (CUP-4871, backlog).
 *
 * Poll-based like the nudge module itself: no router hook fires for a
 * reaction (the chat-sdk bridge never subscribes reaction events), and
 * reading reactions via conversations.replies needs only channels:history,
 * which the provisioned Slack app already holds — reactions.get would need
 * reactions:read, which is NOT in the approved provisioning scope set.
 *
 * The public dismissal post doubles as the persistence marker
 * ({threadNudgeDismissal: true} in outbound history), the same pattern the
 * nudge module uses for alreadyNudged — so a host restart never
 * double-posts a dismissal or re-DMs the operator.
 */
import { botTokenKeyForInstance } from '../../channels/slack-lib.js';
import { getMessagingGroup, getMessagingGroupAgents } from '../../db/messaging-groups.js';
import { getSessionsByAgentGroup, isTaskThread } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { withExistingMailboxSession, writeOutboundDirect } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';
import { getThreadOpener } from '../thread-nudge/classify.js';
import { THREAD_NUDGE_MESSAGING_GROUPS } from '../thread-nudge/config.js';
import { slackPermalink } from '../thread-nudge/index.js';
import { DISMISS_REACTIONS, DISMISSAL_WATCH_WINDOW_MINUTES, FEEDBACK_POLL_INTERVAL_MS } from './config.js';
import { deliveredNudgeTs } from './delivered.js';

interface SlackReaction {
  name: string;
  users?: string[];
}

function isDismissReaction(name: string): boolean {
  return DISMISS_REACTIONS.some((base) => name === base || name.startsWith(`${base}::`));
}

/**
 * Reactions currently on the delivered nudge message, read via
 * conversations.replies (each reply message object carries its reactions
 * inline). Returns null on any failure — a failed read means "check again
 * next tick", never "give up on this nudge".
 */
async function nudgeReactions(mg: MessagingGroup, session: Session, nudgeTs: string): Promise<SlackReaction[] | null> {
  const [scheme, channelId, threadTs] = (session.thread_id ?? '').split(':');
  if (scheme !== 'slack' || !channelId || !threadTs) return null;

  try {
    const tokenKey = botTokenKeyForInstance(mg.instance ?? mg.channel_type);
    const token = process.env[tokenKey] || readEnvFile([tokenKey])[tokenKey];
    if (!token) return null;

    const params = new URLSearchParams({ channel: channelId, ts: threadTs, limit: '50' });
    const res = await fetch(`https://slack.com/api/conversations.replies?${params.toString()}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json()) as { ok?: boolean; messages?: Array<{ ts?: string; reactions?: SlackReaction[] }> };
    if (json.ok !== true) return null;
    const nudgeMsg = json.messages?.find((m) => m.ts === nudgeTs);
    return nudgeMsg?.reactions ?? [];
  } catch (err) {
    log.debug('Thread nudge feedback: reactions read failed (will retry next tick)', { sessionId: session.id, err });
    return null;
  }
}

/** Has this session's dismissal already been posted? Checked against
 *  persisted outbound history so a host restart never double-posts the
 *  dismissal or re-DMs the operator. */
async function alreadyDismissed(agentGroupId: string, sessionId: string): Promise<boolean> {
  const history = await withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
    mailbox.getOutboundHistory(20),
  );
  if (!history) return false;
  return history.some((row) => {
    try {
      return (JSON.parse(row.content) as { threadNudgeDismissal?: boolean }).threadNudgeDismissal === true;
    } catch {
      return false;
    }
  });
}

function dismissalText(dismisserId: string): string {
  return (
    `No problem — <@${dismisserId}> marked this nudge as off the mark, so it's dismissed. ` +
    `This feedback helps tune Marshall's thread detection.`
  );
}

/** DM the operator that a nudge was dismissed as a false positive. Approver
 *  resolution follows the approvals module's preference order (admins of
 *  this agent group → global admins → owners); delivery goes through the
 *  channel adapter directly to the resolved DM — no session, no approval
 *  card. Non-throwing: a failed DM is logged loudly but never rolls back
 *  the already-posted public dismissal. */
async function notifyOperator(
  agentGroupId: string,
  mg: MessagingGroup,
  session: Session,
  dismisserId: string,
): Promise<void> {
  try {
    const approvers = await pickApprover(agentGroupId);
    const delivery = await pickApprovalDelivery(approvers, mg.channel_type);
    if (!delivery) {
      log.warn('Thread nudge feedback: no reachable operator for dismissal DM', { agentGroupId });
      return;
    }
    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.warn('Thread nudge feedback: no delivery adapter registered for dismissal DM');
      return;
    }

    const permalink = await slackPermalink(mg, session.thread_id);
    const where = mg.name ? `#${mg.name}` : mg.platform_id;
    const link = permalink ? ` (${permalink})` : '';
    const text =
      `Thread-nudge feedback: <@${dismisserId}> dismissed a nudge as a false positive in ${where}${link}. ` +
      `Logged for detection-accuracy review.`;

    await adapter.deliver(
      delivery.messagingGroup.channel_type,
      delivery.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      delivery.messagingGroup.instance ?? undefined,
    );
    log.info('Thread nudge feedback: operator notified of dismissal', {
      sessionId: session.id,
      operator: delivery.userId,
    });
  } catch (err) {
    log.warn('Thread nudge feedback: operator DM failed', { sessionId: session.id, err });
  }
}

/** sessionId -> createdAt (ms) for sessions whose feedback outcome is final
 *  (dismissal posted). Entries are pruned once the session ages out of the
 *  watch window. Un-dismissed nudges are deliberately NOT memoized — they
 *  stay watched every tick until dismissed or aged out. */
const decided = new Map<string, number>();

function pruneDecided(): void {
  const cutoff = Date.now() - DISMISSAL_WATCH_WINDOW_MINUTES * 60_000;
  for (const [sessionId, createdAt] of decided) {
    if (createdAt < cutoff) decided.delete(sessionId);
  }
}

export async function checkFeedback(agentGroupId: string, mg: MessagingGroup, session: Session): Promise<void> {
  if (session.thread_id === null || isTaskThread(session.thread_id)) return;
  if (decided.has(session.id)) return;

  const createdAt = Date.parse(session.created_at);
  if (Number.isNaN(createdAt) || Date.now() - createdAt > DISMISSAL_WATCH_WINDOW_MINUTES * 60_000) return;

  const nudgeTs = deliveredNudgeTs(agentGroupId, session.id);
  if (!nudgeTs) return; // never nudged, or nudge not delivered yet — nothing to watch

  if (await alreadyDismissed(agentGroupId, session.id)) {
    decided.set(session.id, createdAt);
    return;
  }

  const opener = await getThreadOpener(agentGroupId, session.id);
  if (!opener) return;

  const reactions = await nudgeReactions(mg, session, nudgeTs);
  if (!reactions) return;

  const dismissed = reactions.some(
    (r) => isDismissReaction(r.name) && (r.users ?? []).includes(opener.senderId),
  );
  if (!dismissed) return; // keep watching until the window ages the session out

  await writeOutboundDirect(agentGroupId, session.id, {
    id: `thread-nudge-dismissal:${session.id}`,
    kind: 'chat',
    platformId: mg.platform_id,
    channelType: mg.channel_type,
    threadId: session.thread_id,
    content: JSON.stringify({ text: dismissalText(opener.senderId), threadNudgeDismissal: true }),
  });
  await notifyOperator(agentGroupId, mg, session, opener.senderId);
  decided.set(session.id, createdAt);
  log.info('Thread nudge dismissed as false positive', {
    sessionId: session.id,
    messagingGroupId: mg.id,
    dismisserId: opener.senderId,
  });
}

export async function pollThreadNudgeFeedback(): Promise<void> {
  pruneDecided();

  for (const messagingGroupId of THREAD_NUDGE_MESSAGING_GROUPS) {
    try {
      const mg = await getMessagingGroup(messagingGroupId);
      if (!mg || mg.is_group !== 1) continue;

      const wirings = await getMessagingGroupAgents(messagingGroupId);
      for (const wiring of wirings) {
        const sessions = (await getSessionsByAgentGroup(wiring.agent_group_id)).filter(
          (s) => s.status === 'active' && s.messaging_group_id === messagingGroupId,
        );
        for (const session of sessions) {
          try {
            await checkFeedback(wiring.agent_group_id, mg, session);
          } catch (err) {
            log.warn('Thread nudge feedback check failed for session', { sessionId: session.id, err });
          }
        }
      }
    } catch (err) {
      log.warn('Thread nudge feedback poll failed for messaging group', { messagingGroupId, err });
    }
  }
}

let pollInFlight = false;

async function pollTick(): Promise<void> {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    await pollThreadNudgeFeedback();
  } finally {
    pollInFlight = false;
  }
}

if (THREAD_NUDGE_MESSAGING_GROUPS.size > 0) {
  setInterval(() => void pollTick(), FEEDBACK_POLL_INTERVAL_MS);
}
