#!/usr/bin/env bash
#
# scripts/worktree-setup.sh
#
# Run from inside a newly-created git worktree to propagate untracked
# dev-only files (env vars, local overrides) from the main repo. Reads
# the path list from `.worktreeinclude` at the main repo root.
#
# Usage:
#   ./scripts/worktree-setup.sh           # symlink everything listed
#   ./scripts/worktree-setup.sh --dry-run # print what would be linked
#
# Typical worktree bring-up flow:
#   1. From main repo:  bd worktree create my-feature
#   2. cd into the new worktree
#   3. ./scripts/worktree-setup.sh
#   4. pnpm install
#
# Mechanism: creates symlinks pointing back at the main repo's files.
# Edits to a dev env var in the main repo propagate to every active
# worktree without re-running setup.

set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${1:-}" ]]; then
  echo "usage: $(basename "$0") [--dry-run]" >&2
  exit 64
fi

# Resolve the main repo root (NOT the worktree root). `git rev-parse
# --git-common-dir` points at the shared .git directory; its parent is
# the main repo. `pwd -P` resolves symlinks. Errors here mean we're not
# in a git repo at all.
COMMON_DIR="$(cd "$(git rev-parse --git-common-dir)" && pwd -P)"
MAIN_REPO="$(dirname "$COMMON_DIR")"
WORKTREE_ROOT="$(cd "$(git rev-parse --show-toplevel)" && pwd -P)"

if [[ "$MAIN_REPO" == "$WORKTREE_ROOT" ]]; then
  echo "warning: this directory IS the main repo, not a worktree. Setup is a no-op." >&2
  exit 0
fi

INCLUDE_FILE="$MAIN_REPO/.worktreeinclude"
if [[ ! -f "$INCLUDE_FILE" ]]; then
  echo "error: $INCLUDE_FILE not found" >&2
  exit 1
fi

echo "main repo:  $MAIN_REPO"
echo "worktree:   $WORKTREE_ROOT"
echo

linked=0
skipped=0
warnings=0

while IFS= read -r rel_path || [[ -n "$rel_path" ]]; do
  # Strip whitespace, skip blanks and comments
  rel_path="${rel_path#"${rel_path%%[![:space:]]*}"}"
  rel_path="${rel_path%"${rel_path##*[![:space:]]}"}"
  [[ -z "$rel_path" ]] && continue
  [[ "$rel_path" =~ ^# ]] && continue

  src="$MAIN_REPO/$rel_path"
  dst="$WORKTREE_ROOT/$rel_path"

  if [[ ! -e "$src" ]]; then
    echo "  skip:  $rel_path  (source missing in main repo)"
    warnings=$((warnings + 1))
    continue
  fi

  if [[ -L "$dst" ]]; then
    existing_target="$(readlink "$dst")"
    if [[ "$existing_target" == "$src" ]]; then
      echo "  ok:    $rel_path  (already linked)"
      skipped=$((skipped + 1))
      continue
    fi
    echo "  warn:  $rel_path  (symlink exists, points to $existing_target, not updating)"
    warnings=$((warnings + 1))
    continue
  fi

  if [[ -e "$dst" ]]; then
    echo "  warn:  $rel_path  (file exists in worktree, not overwriting)"
    warnings=$((warnings + 1))
    continue
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    echo "  would: $rel_path  ->  $src"
  else
    mkdir -p "$(dirname "$dst")"
    ln -s "$src" "$dst"
    echo "  link:  $rel_path  ->  $src"
  fi
  linked=$((linked + 1))
done < "$INCLUDE_FILE"

echo
if [[ $DRY_RUN -eq 1 ]]; then
  echo "dry-run: $linked would be linked, $skipped already correct, $warnings warnings"
else
  echo "done: $linked linked, $skipped already correct, $warnings warnings"
fi

# --------------------------------------------------------------------
# Per-worktree Postgres test database
# --------------------------------------------------------------------
# myth-oehx: each worktree gets its own mythrun_test_<worktree> database
# so concurrent worktrees running `pnpm test` cannot collide on shared
# global tables (settings, srd_*) or sequences. The dev database
# (mythrun_dev) stays SHARED across all worktrees — dev-tool state
# persists across branch switches.
#
# Tests pick up the per-worktree DB via DATABASE_URL_TEST in the
# worktree's .env.worktree (loaded by setup-env.ts). The main repo's
# tests use DATABASE_URL_TEST from .env.development → mythrun_test.

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "dry-run: would also provision worktree test DB + .env.worktree (skipping)"
  exit 0
fi

# Sanitize the worktree directory basename into a Postgres-legal suffix.
# Replace non-alphanum with '_', lowercase, and trim leading/trailing
# underscores so a dir like 'myt-50' becomes 'myt_50' (not 'myt_50_').
# Postgres identifier limit is 63 bytes; mythrun_test_ prefix is 13 bytes,
# leaving 50 for the suffix.
worktree_basename="$(basename "$WORKTREE_ROOT")"
db_suffix="$(echo "$worktree_basename" | tr -c '[:alnum:]_' '_' | tr '[:upper:]' '[:lower:]' | sed -E 's/^_+|_+$//g' | cut -c1-50)"
db_name="mythrun_test_${db_suffix}"

echo
echo "provisioning worktree DB: $db_name"

# Parse the dev DATABASE_URL from the symlinked backend/.env.development.
# We only use it to derive the server's host/port/user/password — the
# target database name comes from the per-worktree suffix above.
env_file="$WORKTREE_ROOT/backend/.env.development"
if [[ ! -f "$env_file" ]]; then
  echo "  warn: $env_file not found — skipping DB provisioning."
  echo "        Re-run this script after the symlink step succeeds."
  exit 0
fi

dev_db_url="$(grep -E '^DATABASE_URL=' "$env_file" | head -1 | cut -d= -f2-)"
if [[ -z "$dev_db_url" ]]; then
  echo "  warn: DATABASE_URL not found in $env_file — skipping DB provisioning."
  exit 0
fi

# DATABASE_URL format: postgresql://user:pass@host:port/dbname
# Strip the dbname (last path segment) to get a connection URL that can
# point at any DB on the same server.
server_url="${dev_db_url%/*}"

# Postgres runs in Docker (docker-compose.yml at repo root). The container
# image has psql baked in, so use `docker compose exec` rather than
# requiring host-side psql. This keeps the script working out of the box
# for anyone who's run `pnpm db:up`.
compose_file="$MAIN_REPO/docker-compose.yml"
if ! command -v docker >/dev/null 2>&1; then
  echo "  warn: docker not on PATH — skipping DB provisioning."
  echo "        Install Docker Desktop, run `pnpm db:up`, then re-run this script."
  exit 0
fi

# -T disables TTY allocation so the call works under non-interactive shells.
psql_in_container() {
  docker compose -f "$compose_file" exec -T postgres psql -v ON_ERROR_STOP=1 -U mythrun "$@"
}

# Container must be running. If not, advise `pnpm db:up`.
if ! docker compose -f "$compose_file" ps --status running --services 2>/dev/null | grep -q '^postgres$'; then
  echo "  warn: Postgres container is not running — skipping DB provisioning."
  echo "        Run \`pnpm db:up\` then re-run this script."
  exit 0
fi

# Check whether the target DB already exists.
exists="$(psql_in_container -d postgres -tA -c "SELECT 1 FROM pg_database WHERE datname = '$db_name'" 2>/dev/null | tr -d '[:space:]' || true)"

if [[ "$exists" == "1" ]]; then
  echo "  ok: database '$db_name' already exists"
else
  echo "  creating database '$db_name' ..."
  if ! psql_in_container -d postgres -c "CREATE DATABASE \"$db_name\"" >/dev/null 2>&1; then
    echo "  error: failed to create database. Check container logs: docker compose logs postgres"
    exit 1
  fi
  echo "  ok: created"
fi

# Write .env.worktree at the worktree root. Overrides DATABASE_URL_TEST
# only — dev DB stays shared (mythrun_dev from backend/.env.development).
# Overwrite each run so stale entries (e.g., from a renamed worktree)
# don't linger.
worktree_db_url="${server_url}/${db_name}"
env_worktree="$WORKTREE_ROOT/.env.worktree"
cat > "$env_worktree" <<EOF
# Generated by scripts/worktree-setup.sh — do not edit by hand.
# myth-oehx: per-worktree TEST DB (dev DB stays shared as mythrun_dev).
# Overrides DATABASE_URL_TEST only; setup-env.ts bridges it to
# DATABASE_URL within the test process.
#
# Regenerate by re-running ./scripts/worktree-setup.sh from this worktree.
DATABASE_URL_TEST=$worktree_db_url
EOF
echo "  ok: wrote $env_worktree"

echo
echo "worktree test DB ready: $db_name (empty — the test suite's globalSetup bootstraps the schema on first run)"
echo
echo "next:"
echo "  1. pnpm install            (per-worktree node_modules)"
echo "  2. run any backend test    (globalSetup bootstraps $db_name's schema; no migrate step)"

# myth: @mythrun/contract resolves ONLY through its built dist/ (the exports map
# has no src conditional), and dist/ is gitignored — a fresh worktree therefore
# fails every client-core/ui typecheck until the contract is built once. Build it
# here so bring-up ends in a typecheckable tree.
echo "→ building @mythrun/contract (dist-only exports; typecheck prerequisite)"
pnpm --filter @mythrun/contract build
