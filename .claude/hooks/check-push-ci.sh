#!/usr/bin/env bash
# Deferred CI checker invoked by post-bash-git-push.sh.
#
# Sleeps 10 minutes then queries GitHub Actions for any workflow runs
# tied to the pushed SHA. If ANY run is non-success (failure / cancelled
# / timed_out / action_required), writes a marker file at
# `tmp/ci-status/<sha>.txt` describing the failures. If all runs are
# success or still in_progress, exits silently (no marker, no noise).
#
# The marker file is picked up by `user-prompt-submit-ci-status.sh`
# next time the user prompts, surfacing it as a <system-reminder>.
#
# Args: $1 = pushed SHA, $2 = output directory for marker files.

set -euo pipefail

sha="${1:?missing sha arg}"
status_dir="${2:?missing status_dir arg}"

# 10-minute timer. Most workflows in this repo (Deploy ~3min, Auth Lint
# ~30s, Wiki ~1min) finish well within this window.
sleep 600

if ! command -v gh >/dev/null 2>&1; then
  # No gh CLI: write a one-line marker so the user knows the check was
  # skipped rather than silently passed.
  echo "CI status check skipped: 'gh' CLI not installed." > "$status_dir/$sha.txt"
  exit 0
fi

# Query every run for this SHA. --json keeps the output structured.
runs_json=$(gh run list --commit "$sha" \
  --json status,conclusion,workflowName,databaseId,url \
  --limit 20 2>/dev/null || true)

if [[ -z "$runs_json" || "$runs_json" == "[]" ]]; then
  # No runs found — could mean SHA was never picked up by CI, or gh
  # auth lapsed. Either way, surface for visibility.
  echo "No GitHub Actions runs found for $sha after 10 min. Check repo CI manually." \
    > "$status_dir/$sha.txt"
  exit 0
fi

# Filter to non-success outcomes. `conclusion` is empty while a run is
# in_progress, so we explicitly tolerate that — only completed-and-
# non-success workflows count as failures.
bad_runs=$(printf '%s' "$runs_json" | jq -r --arg sha "$sha" '
  [ .[] | select(
      .status == "completed" and
      .conclusion != null and
      .conclusion != "success" and
      .conclusion != "skipped"
    )
  ] |
  if length == 0 then empty
  else
    "Failed CI runs on " + $sha + ":\n" +
    ([ .[] | "  - " + .workflowName + " (" + .conclusion + "): " + .url ] | join("\n"))
  end
')

if [[ -n "$bad_runs" ]]; then
  echo "$bad_runs" > "$status_dir/$sha.txt"
fi
# Silent success otherwise — no marker = no nag on the next prompt.
