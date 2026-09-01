---
name: add-dashboard
---

# Remove /add-dashboard

## Steps

### 1. Delete the wiring block from src/index.ts

Inside `main()`, just before `log.info('NanoClaw running')`, DELETE the whole
block (don't comment it out):

```ts
  // Dashboard (optional; no-ops without DASHBOARD_SECRET)
  const { startDashboard } = await import('./dashboard-pusher.js');
  await startDashboard();
```

### 2. Remove the copied files

```bash
rm -f src/dashboard-pusher.ts src/dashboard-pusher.test.ts src/dashboard-wiring.test.ts
```

### 3. Uninstall the dependency

```bash
pnpm uninstall @nanoco/nanoclaw-dashboard
```

### 4. Remove the env vars

Delete `DASHBOARD_SECRET` and `DASHBOARD_PORT` from `.env`.

### 5. Build, test, and restart

```bash
pnpm run build
pnpm run test
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or: launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

**After any restart following a commit that includes this removal**, re-stamp
the upgrade marker (`pnpm exec tsx scripts/upgrade-state.ts set`) or the boot
tripwire will trip on the changed commit/tree — see
[upgrade-recovery.md](../../../docs/upgrade-recovery.md).
