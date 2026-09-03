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
 *  could without multiplying work — the interval is a UX choice (how soon
 *  a stray reply gets caught), not a cost tradeoff. 45s→20s on live
 *  feedback (2026-09-01): the nudge loses its corrective effect when it
 *  lands after the conversation already moved on. */
export const POLL_INTERVAL_MS = 20_000;

/** A session older than this is no longer worth nudging — "you should have
 *  replied in the thread" stops being useful advice once the moment has
 *  passed. Independent of CANDIDATE_MAX_AGE_MINUTES (how far back we look
 *  for candidates a message might belong to) and independent of
 *  POLL_INTERVAL_MS (see above) — this is purely how generous the window
 *  is, not how much repeat work a shorter poll causes. */
export const NUDGE_CHECK_WINDOW_MINUTES = 30;

/** The candidate pool is the channel's last N threads — POSITION, not
 *  wall-clock, is the primary cutoff (operator decision, 2026-09-01): a
 *  thread leaves nudge-reach once N newer conversations exist, whether that
 *  takes an hour or a week, so the rule self-adjusts to the channel's own
 *  rhythm. Low-traffic channels never see threads "expire" for no reason. */
export const CANDIDATE_LIMIT = 8;

/** Sanity/cost ceiling only — position (CANDIDATE_LIMIT + POSITION_DECAY)
 *  is the real cutoff. This just keeps a hibernating channel from pointing
 *  at archaeological threads, and bounds the DB scan. */
export const CANDIDATE_MAX_AGE_MINUTES = 3 * 24 * 60;

/** Per-position score multiplier: the newest candidate thread is ×1, the
 *  one before it ×0.8, five threads back ×0.33. Multiplied (never added) so
 *  recency alone can never trigger a nudge — shared words are the only
 *  source of points; position only discounts them. 0.7→0.8 after three live
 *  test batteries (2026-09-03) showed legit continuations landing at exactly
 *  0.98: two rare shared words two positions back (2 × 0.7² = 0.98) — the
 *  hot-topic case where a nudge matters most, one position "wasted" by a
 *  dead-end nudge thread in between. */
export const POSITION_DECAY = 0.8;

/** Minimum relevance score to post a nudge. Word weights are 1/df within
 *  the candidate pool, so ~1 means "at least one word essentially unique
 *  to that thread, or several moderately rare ones" — common-English verbs
 *  ("like", "know") shared across many openers sum to far less than this.
 *  1.0→0.9 together with the decay change (same live evidence): the
 *  worst-case new false positive (one df=1 word at position 1 = 0.8) still
 *  stays below the bar, while the repeated-0.98 legit misses clear it. */
export const NUDGE_SCORE_THRESHOLD = 0.9;

/** How many recent inbound rows (newest-first) to scan when looking for a
 *  session's real opening message (classify.ts's getThreadOpener). A brand
 *  new session can be seeded with cross-session-context echo rows at LOWER
 *  seq than the real opener (backfill.ts writes them before the triggering
 *  message), and live fan-out keeps adding more while the session sits
 *  unengaged — this needs enough headroom to still find the opener
 *  underneath that traffic within NUDGE_CHECK_WINDOW_MINUTES. Cheap: one
 *  indexed local SQLite read. */
export const ROOT_LOOKUP_HISTORY_LIMIT = 60;

/** Tokens shorter than this are never "significant" (too common/low-signal). */
export const MIN_KEYWORD_LENGTH = 4;
