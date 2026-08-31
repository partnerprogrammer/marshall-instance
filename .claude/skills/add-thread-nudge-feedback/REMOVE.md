---
name: add-thread-nudge-feedback
---

# Remove /add-thread-nudge-feedback

Safe to remove independently of `/add-thread-nudge` — it's the dependent,
not the dependency. Remove this one first if removing both.

## Steps

### 1. Delete the barrel import

In `src/modules/index.ts`, DELETE the line (don't comment it out):

```ts
import './thread-nudge-feedback/index.js';
```

### 2. Remove the copied files

```bash
rm -rf src/modules/thread-nudge-feedback
rm -f src/modules/thread-nudge-feedback-wiring.test.ts
```

### 3. Env var

None to remove — this skill never adds its own; it reads
`THREAD_NUDGE_MESSAGING_GROUPS` from the nudge module. Leave it alone
unless you're also removing `/add-thread-nudge`.

### 4. Build, test, and restart

```bash
pnpm run build
pnpm run test
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```
