---
name: add-thread-nudge
---

# Remove /add-thread-nudge

**Check first: is `/add-thread-nudge-feedback` installed?** It requires this
module — `src/modules/thread-nudge-feedback/config.ts` imports
`THREAD_NUDGE_MESSAGING_GROUPS` directly from `../thread-nudge/config.js`.
Remove `/add-thread-nudge-feedback` first (its own `REMOVE.md`), or the
feedback module's barrel import will fail to resolve.

## Steps

### 1. Delete the barrel import

In `src/modules/index.ts`, DELETE the line (don't comment it out):

```ts
import './thread-nudge/index.js';
```

### 2. Remove the copied files

```bash
rm -rf src/modules/thread-nudge
rm -f src/modules/thread-nudge-wiring.test.ts
```

### 3. Remove the env var

Delete `THREAD_NUDGE_MESSAGING_GROUPS` from `.env`.

### 4. Remove the pinned channel reminders (manual, per channel)

The rollout reminder posted by `scripts/post-reminder.ts` was pinned to
every allowlisted Slack channel. Unpin and delete those messages manually —
there's no unwind script (posting is idempotent-safe to re-run; removal
isn't scripted because it's rare and channel-specific).

### 5. Build, test, and restart

```bash
pnpm run build
pnpm run test
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```
