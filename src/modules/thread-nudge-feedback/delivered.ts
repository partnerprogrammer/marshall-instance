/**
 * Read back the Slack message timestamp of a delivered thread-nudge.
 *
 * The delivery loop persists it (delivery.ts → mailbox.markDelivered →
 * `delivered.platform_message_id` in the session's inbound.db), but the
 * mailbox interface only exposes getDeliveredIds() — there is no accessor
 * for the platform id, and adding one would mean editing core mailbox
 * files (types.ts + the sqlite impl), which this additive module avoids on
 * purpose. Explicit session-DB paths are direct-SQLite territory by
 * project convention (see scripts/q.ts's header), and this is a read-only
 * open of a host-owned file, so no writer contention is possible.
 */
import Database from 'better-sqlite3';

import { inboundDbPath } from '../../mailbox/sqlite/paths.js';

/** Slack ts of the delivered `thread-nudge:<sessionId>` message, or null if
 *  the session was never nudged, the nudge hasn't been delivered yet, or
 *  the session DB doesn't exist. */
export function deliveredNudgeTs(agentGroupId: string, sessionId: string): string | null {
  let db: Database.Database;
  try {
    db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
      .get(`thread-nudge:${sessionId}`) as { platform_message_id: string | null } | undefined;
    return row?.platform_message_id ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}
