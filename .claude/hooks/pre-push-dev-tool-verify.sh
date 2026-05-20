#!/usr/bin/env bash
# PreToolUse hook for the Bash tool.
#
# Denies `git push` when the unpushed commits include changes under
# `backend/dev-tool/**` unless a fresh `tmp/.dev-tool-verifier-ok` marker
# is present whose contents match the SHA-256 of the current
# `git ls-tree HEAD -r backend/dev-tool` output.
#
# The marker is written by the dev-tool-verifier subagent itself —
# never by the controller. The subagent writes it as the final step
# of a clean dispatch (no edits applied) per the playbook in
# `backend/dev-tool/AUTHORING.md`. If a dispatch DID apply edits, the
# subagent leaves the marker unwritten; the controller commits the
# edits and re-dispatches, and the second (now-clean) dispatch writes
# the marker. So a fresh marker is the signal "the verifier saw this
# exact committed tree state and approved it." Any subsequent commit
# that mutates the dev-tool subtree invalidates the marker because
# the tree hash drifts.
#
# This is the deterministic patch behind the AUTHORING.md rule: the
# previous reminder was a passive PostToolUse system-reminder that I
# could ignore. Blocking the push at the Bash layer is the enforcement.
#
# Why push and not commit: pushes are the "I'm done with this chunk"
# verification step (per the feedback_pushes_are_expensive rule).
# Running the verifier subagent per-commit would re-dispatch 3-5x per
# dev-tool session for no added safety — the only useful trigger is
# right before the work goes public.
#
# Allow / deny semantics: PreToolUse hooks return JSON on stdout. To
# deny, emit a hookSpecificOutput object with permissionDecision="deny".
# Allow = exit 0 with no output (or with `permissionDecision="allow"`).
# We default to allow on any unexpected condition (no jq, not in a git
# repo, can't resolve push target) — better to over-allow than block on
# a hook glitch.

set -euo pipefail

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // empty')

# Bail unless this is a real `git push` — same regex as
# post-bash-git-push.sh so the two hooks fire on the same set of
# invocations. Excludes --dry-run (cheap pre-flight, no enforcement).
if [[ -z "$cmd" ]]; then exit 0; fi
if ! [[ "$cmd" =~ (^|[^[:alnum:]])git[[:space:]]+push([[:space:]]|$) ]]; then exit 0; fi
if [[ "$cmd" == *"--dry-run"* ]]; then exit 0; fi

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then exit 0; fi

# Resolve the set of commits about to be pushed. Try the tracked
# upstream first; fall back to origin/main if no upstream is set.
# Both forms tolerate a missing remote — in that case `diff_files`
# stays empty and we allow the push (nothing to enforce against).
diff_files=""
if upstream=$(git -C "$repo_root" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null); then
  diff_files=$(git -C "$repo_root" log "${upstream}..HEAD" --name-only --pretty=format: 2>/dev/null || true)
elif git -C "$repo_root" rev-parse --verify origin/main >/dev/null 2>&1; then
  diff_files=$(git -C "$repo_root" log origin/main..HEAD --name-only --pretty=format: 2>/dev/null || true)
fi

# If no dev-tool files are in the unpushed diff, the verifier rule
# doesn't apply — allow.
if ! printf '%s\n' "$diff_files" | grep -qE '^backend/dev-tool/'; then
  exit 0
fi

# Compute the current committed-state hash of backend/dev-tool. git's
# tree objects are content-addressed, so `ls-tree -r` over a path
# yields a deterministic line set; piping through sha256sum collapses
# that to a single 64-char hex digest.
current_hash=$(git -C "$repo_root" ls-tree HEAD -r backend/dev-tool 2>/dev/null | sha256sum | awk '{print $1}')

marker_file="$repo_root/tmp/.dev-tool-verifier-ok"
marker_hash=""
if [[ -f "$marker_file" ]]; then
  marker_hash=$(head -1 "$marker_file" | tr -d '[:space:]')
fi

if [[ -n "$marker_hash" && "$marker_hash" == "$current_hash" ]]; then
  # Fresh marker matches current dev-tool tree — verifier saw this
  # exact state and approved. Allow the push.
  exit 0
fi

# Stale or missing marker. Deny the push and instruct the agent to
# dispatch the verifier subagent.
short_hash="${current_hash:0:12}"
reason="git push blocked: unpushed commits modify backend/dev-tool/** but the dev-tool-verifier subagent has not approved the current tree state.

Required action: dispatch the dev-tool-verifier subagent using the prompt at the end of backend/dev-tool/AUTHORING.md. It writes the marker itself as the final step of a clean dispatch. If the dispatch applies any edits, the subagent leaves the marker unwritten — the controller commits the edits and re-dispatches; the second dispatch is clean and writes the marker. Then retry the push.

The controller MUST NOT write the marker file manually under any circumstances. That defeats the entire gate.

(current expected hash: ${short_hash}…)

Why this fires: pushing dev-tool changes without the verifier audit risks shipping bugs that the JSDOM harness alone cannot catch (panel behavior, coverage drift, real-LLM smoke). The marker is invalidated automatically by any further commit to backend/dev-tool/**.

If you genuinely need to bypass (e.g., wiki-only commit got bundled into a push by accident), inspect 'git log @{u}..HEAD --name-only' to confirm what's actually being pushed."

jq -nc --arg reason "$reason" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: $reason
  }
}'
