#!/usr/bin/env bash
#
# scripts/worktree-remove.sh
#
# Drop the per-worktree Postgres test database. Run BEFORE
# `bd worktree remove <name>` (which removes the worktree itself).
#
# Usage (from inside the worktree):
#   ../../scripts/worktree-remove.sh
#
# Or from anywhere with the worktree directory as an argument:
#   scripts/worktree-remove.sh /path/to/.worktrees/my-feature
#
# myth-oehx: the per-worktree DB is provisioned by worktree-setup.sh as
# `mythrun_test_<suffix>`; this script tears it down by the same naming
# convention. Idempotent — if the DB doesn't exist, exits 0.

set -euo pipefail

# Resolve the worktree root: argument > current directory.
if [[ -n "${1:-}" ]]; then
  WORKTREE_ROOT="$(cd "$1" && pwd -P)"
else
  WORKTREE_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"
fi

# Compute the DB name the same way setup did (basename → sanitized suffix).
worktree_basename="$(basename "$WORKTREE_ROOT")"
db_suffix="$(echo "$worktree_basename" | tr -c '[:alnum:]_' '_' | tr '[:upper:]' '[:lower:]' | sed -E 's/^_+|_+$//g' | cut -c1-50)"
db_name="mythrun_test_${db_suffix}"

# Locate docker-compose.yml. From a worktree, the main repo is the
# parent of $(git rev-parse --git-common-dir).
COMMON_DIR="$(cd "$WORKTREE_ROOT" && git rev-parse --git-common-dir 2>/dev/null || true)"
if [[ -n "$COMMON_DIR" ]]; then
  MAIN_REPO="$(dirname "$(cd "$COMMON_DIR" && pwd -P)")"
else
  MAIN_REPO="$WORKTREE_ROOT"
fi
compose_file="$MAIN_REPO/docker-compose.yml"

if [[ ! -f "$compose_file" ]]; then
  echo "warn: $compose_file not found — cannot drop $db_name."
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "warn: docker not on PATH — cannot drop $db_name."
  exit 0
fi

if ! docker compose -f "$compose_file" ps --status running --services 2>/dev/null | grep -q '^postgres$'; then
  echo "warn: Postgres container is not running — cannot drop $db_name."
  exit 0
fi

echo "dropping worktree test DB: $db_name"
docker compose -f "$compose_file" exec -T postgres \
  psql -U mythrun -d postgres -c "DROP DATABASE IF EXISTS \"$db_name\";" >/dev/null
echo "  ok: dropped (or did not exist)"
