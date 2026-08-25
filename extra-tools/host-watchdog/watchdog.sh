#!/usr/bin/env bash
# Marshall host watchdog (CUP-4776). Runs every 2 min via launchd and repairs
# the three failure modes that have taken Marshall down in practice:
#   1. Docker Desktop off        -> host crash-loops ("Container runtime is required")
#   2. OneCLI gateway containers -> spawn fails, Slack stuck on "Typing..."
#   3. Zombie Slack socket       -> host alive but deaf (pong timeouts, no reconnect)
# Each check is independent; a kickstart has a 10-min cooldown so a flapping
# signal can't restart-loop the host. Logs to $INSTANCE_DIR/logs/watchdog.log.
set -u

# launchd's PATH is minimal; ncl needs pnpm/node (volta) and docker lives in
# /usr/local/bin. Self-contained here so a plist mistake can't cause the
# false-positive kickstart loop this line was born from.
export PATH="$HOME/.volta/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"

INSTANCE_DIR="${MARSHALL_INSTANCE_DIR:-$HOME/www/partner-programmer/marshall-instance}"
LOG="$INSTANCE_DIR/logs/watchdog.log"
STATE="$INSTANCE_DIR/data/watchdog-last-kickstart"
# Same derivation as NanoClaw's install-slug: sha1(installPath)[:8]
SLUG=$(printf %s "$INSTANCE_DIR" | shasum | cut -c1-8)
LABEL="com.nanoclaw-v2-$SLUG"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }

kickstart() {
  local reason="$1" now last
  now=$(date +%s)
  last=$(cat "$STATE" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt 600 ]; then
    log "kickstart wanted ($reason) — suppressed by 10-min cooldown"
    return
  fi
  echo "$now" > "$STATE"
  log "KICKSTART: $reason"
  launchctl kickstart -k "gui/$(id -u)/$LABEL"
}

# --- 1. Docker daemon --------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  log "docker daemon down — launching Docker Desktop"
  open -a Docker
  for _ in $(seq 1 12); do
    sleep 5
    docker info >/dev/null 2>&1 && break
  done
  if ! docker info >/dev/null 2>&1; then
    log "docker daemon still down after 60s — will retry next tick"
    exit 0
  fi
  log "docker daemon is up"
  # The NanoClaw host is likely in its crash-loop circuit breaker (15 min);
  # don't wait it out.
  kickstart "docker was down; forcing host retry"
fi

# --- 2. OneCLI gateway containers -------------------------------------------
# restart=unless-stopped normally brings these back; this is the belt to that
# suspender (covers a manual `docker stop` or a failed auto-restart).
for c in onecli-postgres-1 onecli; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$c"; then
    log "gateway container $c not running — starting"
    docker start "$c" >/dev/null 2>&1 || log "failed to start $c"
  fi
done

# --- 3. Host reachable via ncl socket ----------------------------------------
if ! "$INSTANCE_DIR/bin/ncl" groups list >/dev/null 2>&1; then
  kickstart "ncl socket unreachable (host down or wedged)"
  exit 0
fi

# --- 4. Zombie Slack Socket Mode ---------------------------------------------
# Symptom: error.log fills with untimestamped "pong wasn't received" warnings
# and the connection never recovers. The warnings carry no timestamp, so gate
# on the file having been written recently AND the recent tail being dominated
# by them (old warnings from a past incident stay in the tail forever).
ERRLOG="$INSTANCE_DIR/logs/nanoclaw.error.log"
if [ -f "$ERRLOG" ] && [ -n "$(find "$ERRLOG" -mmin -5 2>/dev/null)" ]; then
  pongs=$(tail -12 "$ERRLOG" | grep -c "wasn't received from the server" || true)
  if [ "$pongs" -ge 6 ]; then
    kickstart "slack socket zombie ($pongs/12 recent lines are ping/pong timeouts)"
  fi
fi
