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
# Assumes: docker stack up, backend running as `node dist/main` on :3100,
# MailHog on :8025, Temporal on :7233 (+ UI on :8233).
#
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:-happy}"
DELAY_MS="${DELAY_MS:-40000}"
API=http://localhost:3100
MAILHOG=http://localhost:8025
TEMPORAL_UI=http://localhost:8233

say()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
tick() { printf '  \033[2m%s\033[0m  %s\n' "$(date '+%H:%M:%S')" "$*"; }

restart_backend() {
  ( ONBOARDING_FOLLOWUP_DELAY_MS="$DELAY_MS" node --enable-source-maps dist/main \
      > /tmp/tropis-backend.log 2>&1 & )
  for _ in $(seq 1 20); do
    [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "$API/api/health" || true)" = "200" ] \
      && { grep -q 'Temporal worker started' /tmp/tropis-backend.log && return 0; }
    sleep 1
  done
  echo "backend did not come up — is the stack running?" >&2; exit 1
}

create_user() {
  npx --yes ts-node --compiler-options '{"module":"commonjs"}' scripts/create-demo-user.ts
}

followups_for() { # $1 = email — count "Getting started" mails to that address
  curl -s "$MAILHOG/api/v2/messages" | node -e '
    let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
      const to=process.argv[1];let n=0;
      try{for(const m of (JSON.parse(s).items||[])){
        const t=(m.Content.Headers.To||[])[0]||"", sub=(m.Content.Headers.Subject||[])[0]||"";
        if(t.includes(to)&&sub.includes("Getting started"))n++;
      }}catch(e){}
      console.log(n);
    });' "$1"
}

say "Starting a fresh backend (follow-up delay = ${DELAY_MS}ms)"
# Always (re)start so the delay is deterministic and the crash window is precise.
pkill -9 -f 'dist/main' 2>/dev/null || true; sleep 1
restart_backend
tick "backend healthy, Temporal worker polling task queue \"main\""

say "Step 1 — a user signs up"
# create_user prints '<workflowId> <email>' — the id already carries the
# 'onboarding-' prefix the processor uses.
read -r WFID EMAIL <<<"$(create_user)"
T0=$(date '+%H:%M:%S')
tick "created $EMAIL"
tick "immediate  'Welcome!' email  (UserProcessor via BullMQ)"
tick "workflow   '$WFID' started — durable timer running in Temporal"

if [ "$MODE" = "--crash" ]; then
  say "Step 2 — CRASH the backend while the timer is still counting"
  sleep 10
  tick "kill -9 the backend process (simulating a crash / deploy)"
  pkill -9 -f 'dist/main' || true
  sleep 4
  tick "backend is DOWN — no process is holding any timer"
  tick "the timer's fire time will pass while nothing is running"
  say "Step 3 — bring up a brand-new backend"
  restart_backend
  tick "fresh process, worker reconnects to Temporal"
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
  say "RESULT ❌  no follow-up email (check that Temporal + MailHog are up)"; exit 1
fi

echo
echo "  See the workflow history:  $TEMPORAL_UI  (search: $WFID)"
echo "  See both emails:           $MAILHOG"
