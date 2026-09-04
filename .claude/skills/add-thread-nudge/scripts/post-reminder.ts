/**
 * Post + pin the thread-moderation reminder in a Slack channel (CUP-4869).
 *
 * One-time operator action per channel added to THREAD_NUDGE_MESSAGING_GROUPS:
 * a pinned message people see without scrolling back, explaining Marshall's
 * moderator role — its purpose, the reply-in-thread norm, and what happens
 * when a message looks off-thread. The text is written for a client
 * audience: no internal jargon, safe for shared channels.
 *
 * Usage (from the repo root):
 *   pnpm exec tsx .claude/skills/add-thread-nudge/scripts/post-reminder.ts <slack-channel-id> [instance]
 *
 * `instance` defaults to 'slack' (the default adapter instance); pass the
 * adapter-instance name for multi-workspace installs.
 *
 * Idempotent: if the bot already has a pinned message in the channel
 * carrying the marker phrase, the script reports it and exits without
 * posting a duplicate. Safe to re-run on every rollout pass.
 *
 * Requires the pins:write + pins:read bot scopes (present on installed
 * Marshall apps; NOT in the provisioning BOT_SCOPES list — if pins.add
 * fails with missing_scope, add the scopes to the Slack app and reinstall).
 */
import { botTokenKeyForInstance } from '../../../../src/channels/slack-lib.js';
import { readEnvFile } from '../../../../src/env.js';

/** Stable first line — doubles as the idempotency marker in pins.list. */
const MARKER = 'A note on how this channel stays organized';

const REMINDER_TEXT = [
  `:wave: *${MARKER}*`,
  '',
  'Marshall is the channel moderator here — its only job is keeping each conversation in its own thread.',
  '',
  '*The norm:* replies about the same topic stay in the same thread — that keeps context together and makes the channel easier to catch up on.',
  '',
  "*What to expect:* if you post a new message that looks like it continues an existing recent thread, Marshall may reply publicly in your message's own thread pointing to where the conversation should continue. If it gets one wrong, react :-1: on Marshall's reply and it will be dismissed.",
].join('\n');

async function slackGet(token: string, method: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const qs = new URLSearchParams(params);
  const res = await fetch(`https://slack.com/api/${method}?${qs.toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function slackPost(token: string, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return (await res.json()) as Record<string, unknown>;
}

async function main(): Promise<void> {
  const [, , channelId, instance = 'slack'] = process.argv;
  if (!channelId || !/^[CG][A-Z0-9]+$/.test(channelId)) {
    console.error('Usage: pnpm exec tsx .claude/skills/add-thread-nudge/scripts/post-reminder.ts <slack-channel-id> [instance]');
    process.exit(2);
  }

  const tokenKey = botTokenKeyForInstance(instance);
  const token = process.env[tokenKey] || readEnvFile([tokenKey])[tokenKey];
  if (!token) {
    console.error(`No bot token found (${tokenKey}) — check .env`);
    process.exit(1);
  }

  const pins = await slackGet(token, 'pins.list', { channel: channelId });
  if (pins.ok !== true) {
    console.error(`pins.list failed: ${String(pins.error)}`);
    process.exit(1);
  }
  const items = (pins.items as Array<{ message?: { text?: string; permalink?: string } }> | undefined) ?? [];
  const existing = items.find((i) => i.message?.text?.includes(MARKER));
  if (existing) {
    console.log(`Reminder already pinned in ${channelId} — nothing to do.`);
    if (existing.message?.permalink) console.log(existing.message.permalink);
    return;
  }

  const posted = await slackPost(token, 'chat.postMessage', { channel: channelId, text: REMINDER_TEXT });
  if (posted.ok !== true) {
    console.error(`chat.postMessage failed: ${String(posted.error)}`);
    process.exit(1);
  }
  const ts = posted.ts as string;
  console.log(`Posted reminder in ${channelId} (ts ${ts})`);

  const pinned = await slackPost(token, 'pins.add', { channel: channelId, timestamp: ts });
  if (pinned.ok !== true) {
    console.error(
      `pins.add failed: ${String(pinned.error)} — the reminder is posted but NOT pinned; ` +
        'pin it manually or grant the pins:write scope and re-run.',
    );
    process.exit(1);
  }
  console.log('Pinned.');
}

void main();
