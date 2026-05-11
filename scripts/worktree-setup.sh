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
