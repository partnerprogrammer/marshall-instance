/**
 * Time-bounded session scan for the thread-nudge pollers.
 *
 * getSessionsByAgentGroup (src/db/sessions.ts) is an unbounded SELECT *,
 * and sessions effectively never leave 'active' — the live install already
 * carries 70+ and only grows. Every poller here needs only a small recent
 * window (nudge poll: NUDGE_CHECK_WINDOW; feedback poll: dismissal watch
 * window; candidate scan: the 3-day ceiling), so this pushes that window
 * into the SQL instead of fetching everything and discarding in JS.
 *
 * Lives in the module (via the same getDb() driver seam core uses) rather
 * than as a new parameter on the core helper — an upstream update to
 * src/db/sessions.ts must never be able to break or conflict with this
 * skill. ISO-8601 UTC strings compare correctly lexicographically, so the
 * predicate is plain `created_at >= ?` — portable across drivers, no
 * SQLite-specific datetime().
 */
import { getDb } from '../../db/connection.js';
import type { Session } from '../../types.js';

/** Active sessions of one channel wiring created within the last windowMs. */
export async function recentChannelSessions(
  agentGroupId: string,
  messagingGroupId: string,
  windowMs: number,
): Promise<Session[]> {
  const sinceIso = new Date(Date.now() - windowMs).toISOString();
  return getDb().all<Session>(
    `SELECT * FROM sessions
      WHERE agent_group_id = ?
        AND messaging_group_id = ?
        AND status = 'active'
        AND created_at >= ?`,
    agentGroupId,
    messagingGroupId,
    sinceIso,
  );
}
