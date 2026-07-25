#!/usr/bin/env bash
# backend/scripts/dev-logged.sh
#
# The `pnpm dev` entrypoint. Runs the WHOLE dev stack — both long-lived
# backend processes — under one terminal, with per-process log capture.
#
# myth-lmz6 (original): wrap `tsx watch` so its stdout is preserved in a daily
#   log file under backend/logs/. Mirrors what ECS' awslogs driver provides in
#   prod, without modifying any application code.
# myth-q97j0: the stack is TWO legs, not one. `src/worker.ts` is a separate
#   binary that owns every live-session queue (session-turn, dm-trigger,
#   st-eval, scribe, reconcile, analysis). It used to be left out of `pnpm dev`,
#   so every live-session flow was silently dead in dev unless someone
#   remembered `pnpm dev:worker` in a second terminal. A 2026-07 playtest ran
#   for days against a 4-day-stale worker because nobody did.
#
# Why bash and not `concurrently`:
# - The per-leg log capture is the point. `concurrently` multiplexes both legs
#   into ONE stdout, which would destroy the greppable raw-JSON-per-process log
#   files this script exists to produce.
# - Ctrl-C has to kill the tsx watchers themselves, not just the pipeline tails.
#   That needs explicit process-group control (see `set -m` below), which a
#   generic runner does not give us.
# - No new dependency for something bash already does in ~40 lines.
#
# Mechanics:
# - set -euo pipefail: surface errors anywhere in the pipe; default bash hides
#   them behind only-the-last-segment's exit code.
# - set -m: job control, so each backgrounded leg becomes its own process-group
#   leader. Ctrl-C's terminal SIGINT then lands on THIS script only, and the
#   trap forwards it to each leg's whole group — killing tsx, tee and the
#   prefixer together. Without it, tee/pino-pretty die first and the tsx
#   watchers survive as orphans holding the ports.
# - find -mtime +7 -delete: keep the last ~7 days of dev logs. Cleanup runs on
#   each script start (idempotent).
# - tee -a then pino-pretty: tee writes raw JSON to the file first (greppable,
#   jq-friendly), then pino-pretty renders the terminal copy. `--colorize` is
#   explicit because pino-pretty's stdout is now a pipe (into the prefixer),
#   not a TTY, so its auto-detection would otherwise drop color.
# - --self-test: bare-mode probe used by CI/tests to verify prerequisites and
#   assert the stack table without booting anything.

set -euo pipefail

# Paths are relative to the backend/ directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

# DEV_LOGGED_LOG_DIR / DEV_LOGGED_RUNNER are test seams (scripts/__tests__/
# dev-logged.test.ts drives the supervisor with a fake leg so it can assert the
# Ctrl-C teardown for real). Both default to the real thing; no run-path
# behavior branches on whether they are set.
LOG_DIR="${DEV_LOGGED_LOG_DIR:-$(pwd)/logs}"
RUNNER="${DEV_LOGGED_RUNNER:-./node_modules/.bin/tsx}"
PRETTY="./node_modules/.bin/pino-pretty"
TODAY="$(date +%F)"

# The dev stack, one tab-separated row per leg: name, entrypoint, log basename.
# The API keeps the historical `dev-<date>.log` name (myth-lmz6); the worker
# gets its own file rather than interleaving into the same one.
STACK=(
  "api	src/server.ts	dev"
  "worker	src/worker.ts	dev-worker"
)

# Self-test mode: verify directory creation and pino-pretty availability, print
# the stack table (the same rows the run path iterates), and exit cleanly.
if [[ "${1:-}" == "--self-test" ]]; then
  mkdir -p "$LOG_DIR"
  for leg in "${STACK[@]}"; do
    IFS=$'\t' read -r name entry base <<< "$leg"
    touch "$LOG_DIR/$base-$TODAY.log"
    printf '%s\t%s\t%s\n' "$name" "$entry" "$LOG_DIR/$base-$TODAY.log"
  done
  pnpm exec pino-pretty --help > /dev/null
  echo "ok"
  exit 0
fi

mkdir -p "$LOG_DIR"
# Clean up old daily files. -mtime +7 means "more than 7 days old". The glob
# covers both legs (`dev-*.log` matches `dev-worker-*.log` too).
find "$LOG_DIR" -name 'dev-*.log' -mtime +7 -delete

# Job control ON: every `&` below starts its own process group (see header).
set -m

PIDS=()
LEG_NAMES=()

for leg in "${STACK[@]}"; do
  IFS=$'\t' read -r name entry base <<< "$leg"
  log_file="$LOG_DIR/$base-$TODAY.log"
  # Note: invoke tsx via node_modules/.bin/tsx directly, not `pnpm exec tsx`.
  # `pnpm exec` consumes --env-file= as one of its own flags before forwarding
  # the command, breaking the tsx --env-file passthrough. The direct .bin/tsx
  # call keeps the Node-level --env-file handling intact.
  #
  # awk (not `sed -u`) does the terminal prefixing: BSD sed on macOS has no
  # line-buffering flag, so a sed prefix would stall behind its block buffer.
  (
    "$RUNNER" watch \
      --env-file=.env.development \
      --env-file-if-exists=../.env.worktree \
      "$entry" 2>&1 \
      | tee -a "$log_file" \
      | "$PRETTY" --colorize \
      | awk -v tag="$name" '{ printf "%-6s | %s\n", tag, $0; fflush() }'
  ) &
  PIDS+=("$!")
  LEG_NAMES+=("$name")
  printf 'dev-stack: %-6s %s  pid=%s  log=%s\n' "$name" "$entry" "$!" "$log_file"
done

# Kill each leg's whole process group (leading `-` on the pid), falling back to
# the bare pid if the group is already gone. Idempotent: the EXIT trap re-runs
# it after the INT/TERM trap and finds nothing left.
stop_stack() {
  for pid in "${PIDS[@]}"; do
    kill -TERM "-$pid" 2> /dev/null || kill -TERM "$pid" 2> /dev/null || true
  done
  wait 2> /dev/null || true
}

trap 'stop_stack; exit 130' INT
trap 'stop_stack; exit 143' TERM
trap 'stop_stack' EXIT

# Supervise. If EITHER leg exits, take the other one down with it — a half-live
# dev stack is the exact failure this script exists to prevent, and a silent
# half is worse than a loud whole. `tsx watch` does not exit on an app-level
# crash (it keeps watching), so reaching here means a real termination.
while true; do
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2> /dev/null; then
      printf 'dev-stack: %s exited — stopping the rest of the stack\n' "${LEG_NAMES[$i]}" >&2
      exit 1
    fi
  done
  sleep 1
done
