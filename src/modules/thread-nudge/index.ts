/**
 * Thread nudge (CUP-4868).
 *
 * Self-registers on the router's session-created hook: when a brand-new
 * top-level message spawns its own session (the "reply landed as a new
 * message instead of in the thread" case — see CUP-4850), check whether it
 * looks like a continuation of another recently-active thread in the same
 * channel, and if so, publicly point that out as a reply in the message's
 * own thread. Scoped to an explicit messaging-group allowlist
 * (THREAD_NUDGE_MESSAGING_GROUPS, config.ts) — internal PP channels only for
 * the initial rollout; no-op everywhere else.
 *
 * Public by design (CUP-4850 decision, 2026-08-24): a private/DM nudge was
 * tried first and rejected — it removes the social-accountability effect and
 * risks becoming a DM people learn to ignore. Dismissal handling (CUP-4870)
 * is a separate module layered on top of the message this posts.
 */
import { registerSessionCreatedHook, type SessionCreatedEvent } from '../../router.js';
import { writeOutboundDirect } from '../../session-manager.js';
import { THREAD_NUDGE_MESSAGING_GROUPS } from './config.js';
import { collectCandidates, findRelatedThread } from './classify.js';

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

export async function handleSessionCreated(event: SessionCreatedEvent): Promise<void> {
  if (!THREAD_NUDGE_MESSAGING_GROUPS.has(event.mg.id)) return;
  if (event.mg.is_group !== 1) return;
  if (event.sessionMode !== 'per-thread') return;
  if (event.session.messaging_group_id === null) return;

  const text = parseMessageText(event.message.content);
  if (!text) return;

  const candidates = await collectCandidates(
    event.session.agent_group_id,
    event.session,
    event.session.messaging_group_id,
  );
  if (candidates.length === 0) return;

  const match = findRelatedThread(text, candidates);
  if (!match) return;

  await writeOutboundDirect(event.session.agent_group_id, event.session.id, {
    id: `thread-nudge:${event.session.id}`,
    kind: 'chat',
    platformId: event.platformId,
    channelType: event.mg.channel_type,
    threadId: event.threadId,
    content: JSON.stringify({ text: nudgeText(match.candidate.threadId) }),
  });
}

registerSessionCreatedHook(handleSessionCreated);
