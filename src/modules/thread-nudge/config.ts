/**
 * Thread-nudge caps and rollout scope (CUP-4868).
 *
 * Module-level constants + one env-driven allowlist — no DB config, matching
 * the cross-session-context module's approach. Classification is a heuristic
 * (recency + keyword/mention overlap), not a semantic index — same posture
 * as the rest of cross-session context. Tune these during internal testing
 * before ever widening MESSAGING_GROUPS to client-facing channels.
 *
 * Poll-based, not event-based: registerSessionCreatedHook only fires for
 * sessions the router actually engages (wake=true), which in Slack group
 * channels means "someone mentioned the bot." A stray top-level reply
 * between humans that never mentions the bot creates a session (wake=false)
 * but never reaches that hook — confirmed live on CUP-4868's own test
 * traffic. This module instead polls on its own timer, matching
 * host-sweep.ts's plain setInterval pattern — no container wake, so the
 * interval is cheap to run often.
 *
 * The poll interval and the nudge-eligibility window are independent knobs:
 * index.ts memoizes each session's decision after its first real check, so
 * a shorter POLL_INTERVAL_MS only shrinks how soon a *new* session gets
 * looked at — it does not re-scan sessions already decided. Widening
 * NUDGE_CHECK_WINDOW_MINUTES is a UX call (how late a reply can still
 * usefully be nudged), not a cost one.
 */
import { readEnvFile } from '../../env.js';

const envConfig = readEnvFile(['THREAD_NUDGE_MESSAGING_GROUPS']);

/**
 * Explicit allowlist of messaging_group ids this module is active in —
 * comma-separated. Unset = module is a no-op everywhere (safe default: a
 * new public-posting behavior must be opted into, never on by default).
 *
 * CUP-4868's rollout is internal-PP-channels-only; client-facing channels
 * (e.g. Breez) are added here only after internal testing validates the
 * approach. Find a messaging_group's id via `ncl channels list` or the
 * messaging_groups table.
 */
export const THREAD_NUDGE_MESSAGING_GROUPS = new Set(
  (process.env.THREAD_NUDGE_MESSAGING_GROUPS || envConfig.THREAD_NUDGE_MESSAGING_GROUPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
);

/** How often to scan allowlisted channels for un-decided top-level sessions.
 *  No container wake involved (pure host-side SQLite reads) and each
 *  session is only ever really checked once (see the module doc comment in
 *  index.ts), so this can run faster than a cron-scheduled agent task ever
 *  could without multiplying work — 45s is a UX choice (how soon a stray
 *  reply gets caught), not a cost tradeoff. */
export const POLL_INTERVAL_MS = 45_000;

/** A session older than this is no longer worth nudging — "you should have
 *  replied in the thread" stops being useful advice once the moment has
 *  passed. Independent of CANDIDATE_MAX_AGE_MINUTES (how far back we look
 *  for candidates a message might belong to) and independent of
 *  POLL_INTERVAL_MS (see above) — this is purely how generous the window
 *  is, not how much repeat work a shorter poll causes. */
export const NUDGE_CHECK_WINDOW_MINUTES = 30;

/** How many recent sibling sessions (same messaging group) to consider as candidates. */
export const CANDIDATE_LIMIT = 12;

/** Sibling sessions whose root message is older than this are never candidates —
 *  a thread from last week isn't "the thing you just replied to at the top level". */
export const CANDIDATE_MAX_AGE_MINUTES = 180;

/** How many recent inbound rows (newest-first) to scan when looking for a
 *  session's real opening message (classify.ts's getThreadOpener). A brand
 *  new session can be seeded with cross-session-context echo rows at LOWER
 *  seq than the real opener (backfill.ts writes them before the triggering
 *  message), and live fan-out keeps adding more while the session sits
 *  unengaged — this needs enough headroom to still find the opener
 *  underneath that traffic within NUDGE_CHECK_WINDOW_MINUTES. Cheap: one
 *  indexed local SQLite read. */
export const ROOT_LOOKUP_HISTORY_LIMIT = 60;

/** Minimum distinct shared significant keywords between the new message and a
 *  candidate's root message for a keyword-overlap match. */
export const MIN_SHARED_KEYWORDS = 2;

/** Tokens shorter than this are never "significant" (too common/low-signal). */
export const MIN_KEYWORD_LENGTH = 4;

/** How much of the matched thread's opening message to quote in the nudge
 *  text, so a reader can tell at a glance whether the pointer is worth
 *  following without leaving the channel. */
export const NUDGE_SNIPPET_MAX_CHARS = 120;
