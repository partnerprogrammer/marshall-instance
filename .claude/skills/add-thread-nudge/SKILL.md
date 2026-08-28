---
name: add-thread-nudge
description: Add a public reply that nudges a top-level channel message toward the related thread it should have replied in. Heuristic (recency + mention/keyword overlap), no semantic index.
---

# /add-thread-nudge — thread nudge

In a busy channel, people sometimes reply to something by posting a new
top-level message instead of using the thread — a Slack thread starts fresh
for every un-threaded message, so the reply lands disconnected from the
conversation it's actually part of. This skill adds a module that, when a
brand-new top-level message looks like a continuation of another
recently-active thread in the same channel, posts a public reply in the new
message's own thread pointing at the related one — a real, clickable Slack
permalink (via `chat.getPermalink`) plus a short quote of that thread's
opening message, not the raw internal thread_id (that's an opaque host-side
key, not a URL — a live-hit posting it as plain text shipped once already).

Public by design: a private/DM nudge was tried and rejected first — it
removes the social-accountability effect and risks becoming a DM people
learn to ignore. The dismissal flow (a person marking a nudge wrong) is a
separate concern, not covered by this skill.

## How it watches

Poll-based, on its own timer (`POLL_INTERVAL_MS`, `config.ts`) — not an event
hook. The router's `registerSessionCreatedHook()` only fires for sessions it
actually *engages* (`wake=true`), which for a Slack group channel in
`mention-sticky` mode means "someone mentioned the bot." A stray top-level
reply between humans that never mentions the bot still creates a session
(confirmed live: `wake=false`, hook never fires) — exactly the case this
skill exists to catch. So it polls instead: no container wake involved, just
host-side SQLite reads, matching `host-sweep.ts`'s own plain `setInterval`
pattern. That means the interval is cheap to run often; it isn't bounded by
cron's one-minute floor the way `ncl tasks` would be.

**Messages that @-mention the bot take a different path.** A mention is a
message TO the bot — the agent would normally answer it in place, and a
nudge stacked next to a full answer is contradictory noise (live-hit). The
poll skips mention openers entirely; instead, a session-created hook
(which fires exactly for engaged sessions) runs the same classification
immediately and, on a match, posts the SAME standard public nudge
(identical text, identical 👎 dismissal, same `thread-nudge:<id>` outbound
id — so the feedback skill watches it too) and injects a `trigger:false`
context note telling the agent the nudge already answered: send nothing.
The nudge IS the reply; the person either continues in the linked thread
or dismisses with 👎. If the injection race is ever lost (container reads
before the note lands), it degrades to the agent also answering — rare,
and self-explaining next to the nudge.

## How it decides

No semantic index or embeddings — a recency-bounded heuristic, matching the
posture of the built-in `cross-session-context` module:

1. Each poll tick, for every active session with a real thread_id in an
   allowlisted channel younger than `NUDGE_CHECK_WINDOW_MINUTES` and not
   already nudged (checked against persisted outbound history, so a host
   restart never double-posts), collect recent sibling sessions in the same
   channel (active, real thread_id, within `CANDIDATE_MAX_AGE_MINUTES`),
   each contributing its opening message. "Real thread_id" is checked
   per-session, not via the wiring's stored `session_mode` — that column is
   a label the router can override per-message (a wiring stored as `shared`
   can still produce per-thread sessions in practice), so it doesn't
   reliably say what actually happened.
2. A message matches a candidate when it @-mentions the candidate's opener,
   or shares at least `MIN_SHARED_KEYWORDS` significant keywords with it.
3. No match → no-op. This is intentionally conservative; tune the
   thresholds in `config.ts` against real traffic before loosening them.

## Rollout scope

Off everywhere by default. `THREAD_NUDGE_MESSAGING_GROUPS` (`config.ts`) is
an explicit allowlist of messaging-group ids — empty means the module never
posts. Add a messaging group only after you've watched it run internally;
this is a public-posting behavior and false positives are visible to
whoever's in the thread.

## Steps

### 1. Copy the module and its tests

Copy all five resource files into `src/modules/thread-nudge/`. The tests
ship with the skill and run against the composed project.

```
.claude/skills/add-thread-nudge/resources/config.ts         → src/modules/thread-nudge/config.ts
.claude/skills/add-thread-nudge/resources/classify.ts        → src/modules/thread-nudge/classify.ts
.claude/skills/add-thread-nudge/resources/classify.test.ts   → src/modules/thread-nudge/classify.test.ts
.claude/skills/add-thread-nudge/resources/index.ts           → src/modules/thread-nudge/index.ts
.claude/skills/add-thread-nudge/resources/index.test.ts      → src/modules/thread-nudge/index.test.ts
```

- `classify.test.ts` — behavior: candidate gathering (recency, same channel,
  excludes task threads) and relatedness matching (mention vs. keyword
  overlap, and the null case).
- `index.test.ts` — poll gating (missing/DM messaging group, active-session
  filtering, one bad session doesn't block the rest) and per-session checks
  (no real thread_id, freshness window, dedup against persisted outbound
  history, and that a match actually posts via `writeOutboundDirect`
  addressed at the session's own thread).

### 2. Register the module

```nc:append to:src/modules/index.ts
import './thread-nudge/index.js';
```

That one line is this skill's only reach into core. `index.ts` starts its own
`setInterval` poll at import time when the allowlist (step 3) is non-empty —
no core files touched, no router hook, no `ncl tasks` (which would wake a
container every tick).

### 3. Scope the rollout

Find the internal channel's messaging-group id (`ncl channels list` or the
`messaging_groups` table), then add it to `.env`:

```
THREAD_NUDGE_MESSAGING_GROUPS=<messaging-group-id>[,<messaging-group-id>...]
```

Leave unset (or empty) to keep the module a no-op — safe default for a first
install. Comma-separated for more than one channel.

### 4. Build, test, and restart

```bash
pnpm run build
pnpm exec vitest run src/modules/thread-nudge
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

### 5. Pin the channel reminder

For every channel you allowlist, post + pin the reminder explaining
Marshall's moderator role — the purpose, the reply-in-thread norm, and
what a public nudge means. A public reply from a bot reads as random or
intrusive unless the channel was told up front to expect it; the pinned
reminder is what makes the behavior a known, opted-into norm rather than
a surprise. The text is written for a client audience (no internal
jargon), safe for shared channels.

```bash
pnpm exec tsx .claude/skills/add-thread-nudge/scripts/post-reminder.ts <slack-channel-id>
```

Idempotent — re-running skips channels that already have the pinned
reminder, so it's safe to run on every rollout pass. Requires the
`pins:write`/`pins:read` bot scopes (present on installed Marshall apps;
not in the provisioning `BOT_SCOPES` list — if `pins.add` fails with
`missing_scope`, grant the scopes and re-run; the message still posts
either way).

## Tuning

All thresholds live in `config.ts`: `POLL_INTERVAL_MS` (how often to scan —
cheap, no container wake), `NUDGE_CHECK_WINDOW_MINUTES` (how long a session
stays eligible for a nudge before it's considered too stale to bother),
`CANDIDATE_LIMIT` (how many sibling sessions to consider), `CANDIDATE_MAX_AGE_MINUTES`
(how recent a sibling thread must be to count), `MIN_SHARED_KEYWORDS` /
`MIN_KEYWORD_LENGTH` (keyword-overlap match bar). Start conservative and
loosen only after watching real false-positive/negative behavior in an
internal channel.
