#!/usr/bin/env bash
# PostToolUse hook for the Bash tool.
#
# Detects `git push` invocations and schedules a 10-minute follow-up
# check of GitHub Actions for the pushed SHA. The check runs in a
# detached background subshell so the hook itself returns immediately.
#
# Output of the deferred check (only when any workflow failed/cancelled)
# is written to `tmp/ci-status/<sha>.txt`. The `user-prompt-submit-ci-status.sh`
# hook surfaces those files as <system-reminder> blocks the next time
# the user prompts me.
#
# Why a background sleep instead of `at` / launchd / CronCreate:
#   - `at` and `launchd` need per-machine setup outside the repo.
#   - The CronCreate tool can only be invoked DURING an agent turn, not
#     from a hook context.
#   - The shell `(sleep 600 && ...) &` pattern is portable and runs
#     in the user's existing shell session — which is the same place
#     Claude Code lives, so it survives as long as Claude is open.
#
# Lifetime: if the user kills Claude Code or reboots before the 10-min
# timer fires, the background subshell dies with it and the check is
# lost. That's acceptable — the user will see CI status in their email
# / GitHub directly if Claude isn't running.

set -euo pipefail

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

# Only fire on actual git pushes. Exclude --dry-run.
if [[ -z "$cmd" ]]; then exit 0; fi
if ! [[ "$cmd" =~ (^|[^[:alnum:]])git[[:space:]]+push([[:space:]]|$) ]]; then exit 0; fi
if [[ "$cmd" == *"--dry-run"* ]]; then exit 0; fi

# Capture HEAD AFTER the push completed (PostToolUse fires after the
# Bash command returns). git rev-parse runs in the repo's working dir.
sha=$(git rev-parse HEAD 2>/dev/null || true)
if [[ -z "$sha" ]]; then exit 0; fi

# Repo root for absolute paths inside the detached subshell. The
# subshell loses cwd inheritance via `disown`, so we pin it explicitly.
repo_root=$(git rev-parse --show-toplevel)
status_dir="$repo_root/tmp/ci-status"
mkdir -p "$status_dir"

# Detach the timer + checker. nohup + & + disown so the subshell
# survives the hook process exiting. Output silenced — the script
# writes to the marker file directly.
nohup bash "$repo_root/.claude/hooks/check-push-ci.sh" "$sha" "$status_dir" \
  >/dev/null 2>&1 &
disown

# Emit a system-reminder so I know the timer is armed. Helps me
# remember to expect a follow-up.
cat <<EOF
<system-reminder>
git push detected (SHA ${sha:0:12}). A 10-minute timer is now armed; when
it fires, the CI status of this push will be checked and any failed /
cancelled workflows will be surfaced to me on your next prompt. If you
hear back about red CI on the next interaction, it's this push.
</system-reminder>
EOF
