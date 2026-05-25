#!/usr/bin/env bash
# .claude/hooks/post-dev-tool-edit.sh
#
# PostToolUse hook for Write tool calls (myth-e5mn). Reminds the agent
# to dispatch the dev-tool-verifier subagent when the edit touches the
# dev-tool subtree or the backend route contract source.
#
# Matcher in .claude/settings.json is "Write" (NOT "Edit|Write") so this
# fires once at the end of a writing pass, not per-iteration during a
# normal multi-edit refinement turn.

set -euo pipefail

# Read the tool input as JSON on stdin.
input=$(cat)

# If jq is unavailable the hook becomes a no-op rather than a failure.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

# Extract file_path. jq handles missing/null gracefully.
file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "${file_path:-}" ]]; then
  exit 0
fi

# Path-match against the dev-tool surface + backend contract sources.
# Edits to handler files under backend/src/routes/** are NOT in the
# matcher — the dev tool consumes the contract, not the handlers, and a
# handler-level edit is too noisy a signal for this reminder.
case "$file_path" in
  */backend/dev-tool/src/*.ts | \
  */backend/dev-tool/src/**/*.ts | \
  */backend/dev-tool/coverage.json | \
  */backend/dev-tool/verify-registry.ts | \
  */backend/dev-tool/AUTHORING.md | \
  */backend/src/contract/backend-routes.ts | \
  */backend/src/contract/pipeline-routes.ts)
    cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "You edited the dev tool or a backend route contract source this turn. Before handing back, dispatch the dev-tool-verifier subagent using Agent tool with subagent_type=\"dev-tool-verifier\" (registered in .claude/agents/dev-tool-verifier.md). The dispatch prompt MUST include an explicit `E2E: required` or `E2E: skip — <reason>` line per the tiered-smoke protocol in backend/dev-tool/AUTHORING.md step 5. Do NOT dispatch with subagent_type=\"general-purpose\" — the handoff classifier reads agent_type and will flag the marker write as a memory-rule violation."
  }
}
EOF
    ;;
  *)
    # No match; emit nothing.
    ;;
esac
