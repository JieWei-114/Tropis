#!/usr/bin/env bash
#
# Temporal onboarding-workflow demo — narrated, for showing an audience why a
# durable workflow beats a plain delayed job.
#
# Two modes:
#   ./scripts/temporal-demo.sh          happy path: signup -> timer -> follow-up email
#   ./scripts/temporal-demo.sh --crash  durability: kill the backend mid-wait; the
#                                        follow-up still fires after a fresh restart
#
# Runs the shipped per-role bundles (dist/public/main.js serves the API on
# :3100, dist/worker/main.js runs the consumers, the outbox relay and the
# Temporal worker, ops on :9465), rebuilding them first when src/ is newer.
# Assumes: docker stack up (make up), Mailpit on :8025, Temporal on :7233
# (+ UI on :8233), and nothing else listening on :3100.
#
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-happy}"
DELAY_MS="${DELAY_MS:-40000}"
API=http://localhost:3100
WORKER_OPS_PORT="${WORKER_OPS_PORT:-9465}"
MAILPIT=http://localhost:8025
TEMPORAL_UI=http://localhost:8233
LOG_DIR="${TMPDIR:-/tmp}/tropis-wf-demo"
BOOT_SECONDS="${BOOT_SECONDS:-120}"
ROLES=(public worker)

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
tick() { printf '  \033[2m%s\033[0m  %s\n' "$(date '+%H:%M:%S')" "$*"; }

mkdir -p "$LOG_DIR"

bundles_current() {
  local role
  for role in "${ROLES[@]}"; do
    [ -f "dist/$role/main.js" ] || return 1
    [ -z "$(find src -newer "dist/$role/main.js" -type f -print -quit)" ] || return 1
  done
}

ensure_bundles() {
  if bundles_current; then return 0; fi
  say "Building the role bundles (src/ is newer than dist/)"
  pnpm build > "$LOG_DIR/build.log" 2>&1 \
    || { echo "build failed — see $LOG_DIR/build.log" >&2; exit 1; }
}

stop_roles() {
  local role pid
  for role in "${ROLES[@]}"; do
    if [ -f "$LOG_DIR/$role.pid" ]; then
      pid="$(cat "$LOG_DIR/$role.pid")"
      kill -9 "$pid" 2>/dev/null || true
      rm -f "$LOG_DIR/$role.pid"
    fi
  done
}

start_role() { # $1 = role, then extra VAR=value pairs
  local role="$1"; shift
  env ONBOARDING_FOLLOWUP_DELAY_MS="$DELAY_MS" "$@" \
    node --enable-source-maps "dist/$role/main.js" > "$LOG_DIR/$role.log" 2>&1 &
  echo $! > "$LOG_DIR/$role.pid"
  disown $!
}

http_ok() { [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$1" || true)" = "200" ]; }

start_backend() {
  if http_ok "$API/api/health"; then
    echo "something already answers on $API — stop it (make dev) first" >&2; exit 1
  fi
  start_role public
  start_role worker OPS_PORT="$WORKER_OPS_PORT"
  for _ in $(seq 1 "$BOOT_SECONDS"); do
    if http_ok "$API/api/health" \
      && http_ok "http://localhost:$WORKER_OPS_PORT/readyz" \
      && grep -q 'Temporal worker started' "$LOG_DIR/worker.log"; then
      return 0
    fi
    sleep 1
  done
  echo "backend did not come up — is the stack running? Logs: $LOG_DIR/{public,worker}.log" >&2
  stop_roles; exit 1
}

trap stop_roles EXIT

create_user() {
  npx --yes ts-node --compiler-options '{"module":"commonjs"}' scripts/create-demo-user.ts
}

followups_for() { # $1 = email — count "Getting started" mails to that address
  curl -s "$MAILPIT/api/v1/messages?limit=500" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const to=process.argv[1];let n=0;
      try{for(const m of (JSON.parse(s).messages||[])){
        const t=(m.To||[]).map(a=>a.Address).join(","), sub=m.Subject||"";
        if(t.includes(to)&&sub.includes("Getting started"))n++;
      }}catch(e){}
      console.log(n);
    });' "$1"
}

ensure_bundles
say "Starting a fresh backend: public + worker roles (follow-up delay = ${DELAY_MS}ms)"
# Always start fresh so the delay is deterministic and the crash window is precise.
stop_roles
start_backend
tick "public role healthy, worker polling task queue \"user-onboarding\""

say "Step 1 — a user signs up"
# create_user prints '<workflowId> <email>' — the engine-side id, with the
# tenant prefix and the 'onboarding-' prefix the processor uses.
read -r WFID EMAIL <<<"$(create_user)"
T0=$(date '+%H:%M:%S')
tick "created $EMAIL"
tick "immediate  'Welcome!' email  (UserProcessor via BullMQ)"
tick "workflow   '$WFID' started — durable timer running in Temporal"

if [ "$MODE" = "--crash" ]; then
  say "Step 2 — CRASH the backend while the timer is still counting"
  sleep 10
  tick "kill -9 both role processes (simulating a crash / deploy)"
  stop_roles
  sleep 4
  tick "backend is DOWN — no process is holding any timer"
  tick "the timer's fire time will pass while nothing is running"
  say "Step 3 — bring up a brand-new backend"
  start_backend
  tick "fresh processes, the worker reconnects to Temporal"
  tick "Temporal re-dispatches the pending timer -> activity runs now"
fi

say "Waiting for the follow-up email…"
DEADLINE=$(( $(date +%s) + DELAY_MS/1000 + 20 ))
while [ "$(followups_for "$EMAIL")" = "0" ] && [ "$(date +%s)" -lt "$DEADLINE" ]; do sleep 2; done

if [ "$(followups_for "$EMAIL")" -ge 1 ]; then
  say "RESULT ✅  follow-up 'Getting started' email delivered to $EMAIL"
  tick "signup at $T0, delivered at $(date '+%H:%M:%S')"
  [ "$MODE" = "--crash" ] && tick "…and it survived a full crash + restart in between"
else
  say "RESULT ❌  no follow-up email (check that Temporal + Mailpit are up)"; exit 1
fi

echo
echo "  See the workflow history:  $TEMPORAL_UI  (search: $WFID)"
echo "  See both emails:           $MAILPIT"
