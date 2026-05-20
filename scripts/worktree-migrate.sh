#!/usr/bin/env bash
# scripts/worktree-migrate.sh
#
# One-shot migrator for existing worktrees after the test-DB isolation
# change (myth-oehx). Converts the old `.env.worktree` shape:
#   DATABASE_URL=postgresql://...mythrun_<wt>
# to the new shape:
#   DATABASE_URL_TEST=postgresql://...mythrun_test_<wt>
# and provisions the new mythrun_test_<wt> database + initial migration.
#
# Run from inside a worktree directory. No-op if the worktree's .env.worktree
# is already in the new shape.

set -euo pipefail

# Find repo root + .env.worktree
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ENV_FILE="$REPO_ROOT/.env.worktree"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "No .env.worktree at $ENV_FILE — nothing to migrate."
  exit 0
fi

# Extract the worktree name from the current DATABASE_URL line (if any).
# Format expected: postgresql://.../mythrun_<name>
old_url="$(grep -E '^DATABASE_URL=' "$ENV_FILE" || true)"
if [[ -z "$old_url" ]]; then
  echo "$ENV_FILE has no DATABASE_URL line — assuming already migrated."
  exit 0
fi

wt_name="$(echo "$old_url" | sed -E 's|.*/mythrun_([^/?]+).*|\1|')"
if [[ "$wt_name" == "$old_url" || -z "$wt_name" ]]; then
  echo "Could not parse worktree name from: $old_url"
  echo "Bailing — manual fix required."
  exit 1
fi

new_db="mythrun_test_$wt_name"

# Create the new test DB (idempotent — IF NOT EXISTS).
docker compose -f "$REPO_ROOT/docker-compose.yml" exec -T postgres \
  psql -U mythrun -d postgres -c "CREATE DATABASE $new_db OWNER mythrun;" 2>&1 \
  | grep -v "already exists" || true

# Rewrite .env.worktree:
#   - Remove the old DATABASE_URL line.
#   - Add a DATABASE_URL_TEST line.
grep -v '^DATABASE_URL=' "$ENV_FILE" > "$ENV_FILE.tmp"
echo "DATABASE_URL_TEST=postgresql://mythrun:mythrun_dev@localhost:5432/$new_db" >> "$ENV_FILE.tmp"
mv "$ENV_FILE.tmp" "$ENV_FILE"

echo "Migrated $ENV_FILE to use DATABASE_URL_TEST=...$new_db"
echo "Running initial migration against $new_db..."

# Apply migrations to the new test DB. From repo root so backend script resolves.
cd "$REPO_ROOT/backend"
pnpm db:migrate:test

echo "Done. Worktree $wt_name now isolated on $new_db."
