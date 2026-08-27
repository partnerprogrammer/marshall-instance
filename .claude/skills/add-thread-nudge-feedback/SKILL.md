---
name: add-thread-nudge-feedback
description: Make the thread-nudge's "react 👎 if this one's off" promise real — a dismissal from the nudged person posts publicly in the thread and DMs the operator. Requires add-thread-nudge.
---

# /add-thread-nudge-feedback — nudge dismissal feedback

The thread-nudge module (`/add-thread-nudge`) publicly tells people "react
👎 if this one's off". This skill adds the module that makes that promise
real: when the person Marshall originally nudged reacts 👎 on the nudge
message, Marshall posts the dismissal publicly in the same thread and DMs
the operator so the feedback reaches whoever tunes detection.

Design decisions carried from the story (CUP-4870):

- **Only the nudged person's 👎 counts** — gated by the Slack user id on
  the reaction, not by whoever clicks first. Other people's reactions do
  nothing.
- **Dismissals are public, never silent** — the team sees both the nudge
  and how it was resolved. Marshall never contests a dismissal it can't
  verify; social judgment of bad-faith dismissals stays with the team.
- **The operator hears about every dismissal by DM** — resolved the same
  way approvals pick an approver (admins of the agent group → global
  admins → owners), delivered straight to their DM, no approval card.
- Automatic self-tuning from accumulated feedback is out of scope
  (tracked separately as backlog).

## Requires

`/add-thread-nudge` must already be installed — this module imports the
nudge module's channel allowlist, opener lookup, and permalink helper, and
watches the nudge messages that module posts. It shares the same
`THREAD_NUDGE_MESSAGING_GROUPS` env allowlist: no extra configuration.

## How it watches

Poll-based, like the nudge module itself (`FEEDBACK_POLL_INTERVAL_MS`,
`config.ts`): the chat-sdk bridge never subscribes Slack reaction events,
so there is no event to hook. Each tick, for every delivered nudge still
inside `DISMISSAL_WATCH_WINDOW_MINUTES`, it reads the nudge message's
reactions via `conversations.replies` — chosen over `reactions.get`
because it only needs `channels:history`, which the provisioned Slack app
already holds (`reactions:read` is NOT in the approved provisioning scope
set).

The delivered nudge's Slack timestamp is read from the session's
`inbound.db` `delivered` table directly (`delivered.ts`) — the mailbox
interface has no accessor for `platform_message_id`, and adding one would
mean editing core mailbox files. Explicit session-DB paths are
direct-SQLite territory by project convention (see `scripts/q.ts`), and
this is a read-only open of a host-owned file.

The public dismissal post doubles as the persistence marker
(`{threadNudgeDismissal: true}` in outbound history), so a host restart
never double-posts a dismissal or re-DMs the operator — same pattern the
nudge module uses for its own dedup.

## Steps

### 1. Copy the module and its tests

```
.claude/skills/add-thread-nudge-feedback/resources/config.ts        → src/modules/thread-nudge-feedback/config.ts
.claude/skills/add-thread-nudge-feedback/resources/delivered.ts     → src/modules/thread-nudge-feedback/delivered.ts
.claude/skills/add-thread-nudge-feedback/resources/index.ts         → src/modules/thread-nudge-feedback/index.ts
.claude/skills/add-thread-nudge-feedback/resources/index.test.ts    → src/modules/thread-nudge-feedback/index.test.ts
```

- `index.test.ts` — the only-the-nudged-person's-👎-counts rule (including
  skin-tone variants), the public dismissal post + marker, the operator
  DM (and that an unreachable operator never blocks the public
  dismissal), restart-safe dedup via outbound history, and poll gating.

### 2. Export the permalink helper from the nudge module

The nudge module's `slackPermalink` needs to be importable (the operator
DM links to the dismissed thread). In
`src/modules/thread-nudge/index.ts`, make sure the declaration reads:

```ts
export async function slackPermalink(
```

(Fresh installs of `/add-thread-nudge` already ship it exported; only
pre-CUP-4870 copies need the one-word change.)

### 3. Register the module

```nc:append to:src/modules/index.ts
import './thread-nudge-feedback/index.js';
```

That one line is this skill's only reach into core.

### 4. Build, test, and restart

```bash
pnpm run build
pnpm exec vitest run src/modules/thread-nudge-feedback
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

No `.env` change: the module activates wherever
`THREAD_NUDGE_MESSAGING_GROUPS` already points.

## Tuning

`config.ts`: `FEEDBACK_POLL_INTERVAL_MS` (how often to check reactions —
one `conversations.replies` call per still-watched nudge per tick),
`DISMISSAL_WATCH_WINDOW_MINUTES` (how long a nudge stays dismissable
before it ages out of watching), `DISMISS_REACTIONS` (which reaction
names count — `-1` is Slack's canonical 👎, skin-tone variants matched by
prefix).
