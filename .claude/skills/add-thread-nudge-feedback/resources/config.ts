/**
 * Thread-nudge feedback caps (CUP-4870).
 *
 * Same posture as the thread-nudge module this layers on: module-level
 * constants, no DB config. The channel allowlist is NOT duplicated here —
 * feedback watches exactly the channels nudges post to, so it imports
 * THREAD_NUDGE_MESSAGING_GROUPS from ../thread-nudge/config.js directly.
 */

/** How often to scan delivered nudges for a dismissal reaction. Each tick
 *  costs one Slack conversations.replies call per still-watched nudge —
 *  bounded by DISMISSAL_WATCH_WINDOW_MINUTES, so the watched set stays
 *  small (nudges are rare by design). */
export const FEEDBACK_POLL_INTERVAL_MS = 45_000;

/** How long after a session's creation we keep watching its nudge for a
 *  dismissal. People don't react to a stale nudge days later — and an
 *  unbounded watch would grow the per-tick Slack API cost forever. */
export const DISMISSAL_WATCH_WINDOW_MINUTES = 24 * 60;

/** Slack reaction names that count as "this nudge was wrong". '-1' is
 *  Slack's canonical name for 👎 (skin-tone variants arrive as
 *  '-1::skin-tone-N' and are matched by prefix); 'thumbsdown' kept
 *  defensively for clients that send the alias name. */
export const DISMISS_REACTIONS = ['-1', 'thumbsdown'];
