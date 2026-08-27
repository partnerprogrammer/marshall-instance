/**
 * Thread-nudge caps and rollout scope (CUP-4868).
 *
 * Module-level constants + one env-driven allowlist — no DB config, matching
 * the cross-session-context module's approach. Classification is a heuristic
 * (recency + keyword/mention overlap), not a semantic index — same posture
 * as the rest of cross-session context. Tune these during internal testing
 * before ever widening MESSAGING_GROUPS to client-facing channels.
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

/** How many recent sibling sessions (same messaging group) to consider as candidates. */
export const CANDIDATE_LIMIT = 12;

/** Sibling sessions whose root message is older than this are never candidates —
 *  a thread from last week isn't "the thing you just replied to at the top level". */
export const CANDIDATE_MAX_AGE_MINUTES = 180;

/** Minimum distinct shared significant keywords between the new message and a
 *  candidate's root message for a keyword-overlap match. */
export const MIN_SHARED_KEYWORDS = 2;

/** Tokens shorter than this are never "significant" (too common/low-signal). */
export const MIN_KEYWORD_LENGTH = 4;
