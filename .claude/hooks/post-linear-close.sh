#!/usr/bin/env bash
# PostToolUse hook for mcp__linear-server__save_issue.
# Reads the tool input JSON from stdin. If the tool call transitioned an
# issue's state to "Done" (or "Completed"), prints a system reminder to stdout
# that directs the main agent to dispatch the wiki-update subagent.

set -euo pipefail

input=$(cat)

# Heuristic-free extraction: use jq to inspect the JSON payload directly.
# If jq is unavailable the hook becomes a no-op rather than a failure.
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

state_name=$(printf '%s' "$input" | jq -r '.tool_input.state // .tool_input.statusName // empty')
issue_id=$(printf '%s' "$input" | jq -r '.tool_input.id // .tool_input.issueId // empty')

if [[ -z "${state_name:-}" || -z "${issue_id:-}" ]]; then
  exit 0
fi

shopt -s nocasematch
if [[ "$state_name" != "Done" && "$state_name" != "Completed" ]]; then
  exit 0
fi
shopt -u nocasematch

cat <<EOF
<system-reminder>
Linear issue ${issue_id} was just transitioned to ${state_name}. Before ending
your turn, dispatch a wiki-update subagent to sync docs/wiki/ with the code
and infra changes this issue introduced.

Use the Agent tool with subagent_type="general-purpose", model="opus", and the
prompt template from docs/wiki/AUTHORING.md under "Wiki Update Subagent Prompt",
parameterized with linearIssueId=${issue_id}.

The subagent will:
  1. Read the Linear issue's description and comments.
  2. Walk git diffs for the commits attributed to this issue.
  3. Update or add docs/wiki/content/<section>/<page>.html and
     docs/wiki/diagrams/<section>/<name>.dot files as needed.
  4. Run pnpm wiki:accept-drift <page> to lock updated hashes.
  5. Run pnpm wiki:check to confirm no drift remains.
  6. Commit and push the wiki changes.

Do not skip this. The wiki is not optional — it must stay within one Linear
issue of main.
</system-reminder>
EOF
