#!/usr/bin/env bash
# Deferred CI checker invoked by post-bash-git-push.sh.
#
# Sleeps 10 minutes then queries GitHub Actions for any workflow runs
# tied to the pushed SHA. Writes a single marker at
# `tmp/ci-status/<sha>.txt` summarizing the outcome — ALL categories
# (success / in_progress / failed / no_runs / gh_missing) get a marker
# so the post-prompt notice is unambiguous. The previous behavior
# (silent on all-green) made "no marker" indistinguishable from "hook
# didn't fire" and led to misreading green pushes as triage signals.
#
# The marker is picked up by `user-prompt-submit-ci-status.sh`
# next time the user prompts, surfacing it as a <system-reminder>.
#
# Args: $1 = pushed SHA, $2 = output directory for marker files.

set -euo pipefail

sha="${1:?missing sha arg}"
status_dir="${2:?missing status_dir arg}"

# 10-minute timer. Most workflows in this repo (Deploy ~3min, Auth Lint
# ~30s, Wiki ~1min) finish well within this window.
sleep 600

short_sha="${sha:0:10}"

if ! command -v gh >/dev/null 2>&1; then
  cat > "$status_dir/$sha.txt" <<EOF
STATUS: gh_missing
SHA: $short_sha
CI status check skipped: 'gh' CLI not installed.
EOF
  exit 0
fi

# Query every run for this SHA. --json keeps the output structured.
runs_json=$(gh run list --commit "$sha" \
  --json status,conclusion,workflowName,databaseId,url \
  --limit 20 2>/dev/null || true)

if [[ -z "$runs_json" || "$runs_json" == "[]" ]]; then
  # No runs found — could mean SHA was never picked up by CI (paths
  # filter excluded it, no workflows match the branch), or gh auth
  # lapsed. NOT a failure signal — write a separate STATUS so the
  # surface hook can frame it as informational.
  cat > "$status_dir/$sha.txt" <<EOF
STATUS: no_runs
SHA: $short_sha
No GitHub Actions runs found for $short_sha after 10 min. Likely a
paths-filter mismatch (CI wasn't triggered for this commit's diff)
or gh auth lapsed. Not a failure.
EOF
  exit 0
fi

# Classify outcomes. `conclusion` is empty while a run is in_progress
# or queued, so we treat those as a distinct state. Skipped runs count
# as success for our purposes.
summary=$(printf '%s' "$runs_json" | jq -r '
  def fmt_runs(arr):
    arr | map("  - " + .workflowName + " (" + (.conclusion // .status) + "): " + .url) | join("\n");

  . as $all |
  ($all | map(select(.status != "completed"))) as $pending |
  ($all | map(select(.status == "completed" and (.conclusion == "success" or .conclusion == "skipped")))) as $green |
  ($all | map(select(.status == "completed" and .conclusion != null and .conclusion != "success" and .conclusion != "skipped"))) as $failed |

  if ($failed | length) > 0 then
    "STATUS: failed\n" +
    "✗ " + ($failed | length | tostring) + " failed run(s), " +
    ($green | length | tostring) + " succeeded, " +
    ($pending | length | tostring) + " still in progress:\n" +
    fmt_runs($failed) +
    (if ($green | length) > 0 then "\nSucceeded:\n" + fmt_runs($green) else "" end) +
    (if ($pending | length) > 0 then "\nStill in progress:\n" + fmt_runs($pending) else "" end)
  elif ($pending | length) > 0 then
    "STATUS: in_progress\n" +
    "⏳ " + ($pending | length | tostring) + " run(s) still in progress after 10 min, " +
    ($green | length | tostring) + " succeeded, 0 failed:\n" +
    fmt_runs($pending) +
    (if ($green | length) > 0 then "\nAlready succeeded:\n" + fmt_runs($green) else "" end)
  else
    "STATUS: success\n" +
    "✓ all " + ($green | length | tostring) + " CI run(s) succeeded:\n" +
    fmt_runs($green)
  end
')

cat > "$status_dir/$sha.txt" <<EOF
$summary
SHA: $short_sha
EOF
