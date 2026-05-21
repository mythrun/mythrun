#!/usr/bin/env bash
# backend/scripts/dev-logged.sh
#
# myth-lmz6: wrap `tsx watch ... src/server.ts` so its stdout is
# preserved in a daily log file under backend/logs/. Mirrors what
# ECS' awslogs driver provides in prod, without modifying any
# application code.
#
# - set -euo pipefail: surface errors anywhere in the pipe; default
#   bash hides them behind only-the-last-segment's exit code.
# - find -mtime +7 -delete: keep the last ~7 days of dev logs.
#   Cleanup runs on each script start (idempotent).
# - tee -a then pnpm exec pino-pretty: tee writes raw JSON to the file
#   first (greppable, jq-friendly), then pino-pretty renders the
#   terminal copy for the human reading along.
# - --self-test: bare-mode probe used by CI to verify the script's
#   prerequisites without booting the server.

set -euo pipefail

# Paths are relative to the backend/ directory.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/.."

LOG_DIR="$(pwd)/logs"
LOG_FILE="$LOG_DIR/dev-$(date +%F).log"

# Self-test mode: verify directory creation, pino-pretty availability,
# and exit cleanly.
if [[ "${1:-}" == "--self-test" ]]; then
  mkdir -p "$LOG_DIR"
  touch "$LOG_FILE"
  pnpm exec pino-pretty --help > /dev/null
  echo "ok"
  exit 0
fi

mkdir -p "$LOG_DIR"
# Clean up old daily files. -mtime +7 means "more than 7 days old".
find "$LOG_DIR" -name 'dev-*.log' -mtime +7 -delete

# Run tsx watch with the same env-file flags package.json's dev:raw uses.
# Tee raw JSON to today's file; then render terminal via pino-pretty.
# Note: invoke tsx via node_modules/.bin/tsx directly, not `pnpm exec tsx`.
# `pnpm exec` consumes --env-file= as one of its own flags before
# forwarding the command, breaking the tsx --env-file passthrough. The
# direct .bin/tsx call keeps the Node-level --env-file handling intact.
exec ./node_modules/.bin/tsx watch \
  --env-file=.env.development \
  --env-file-if-exists=../.env.worktree \
  src/server.ts 2>&1 \
  | tee -a "$LOG_FILE" \
  | ./node_modules/.bin/pino-pretty
