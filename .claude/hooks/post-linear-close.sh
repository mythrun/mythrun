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
Linear issue ${issue_id} was just transitioned to ${state_name}. Per the
Standard Implementation Workflow in CLAUDE.md, the wiki update should
already have landed BEFORE the code push (step 2 of the close-the-loop
sequence) so CI doesn't see a code-ahead-of-wiki transient red.

If you already dispatched the wiki subagent earlier in this turn and its
commits landed in the same push as the code, ignore this reminder — the
hook fires unconditionally and is a backstop, not the primary trigger.

If you did NOT dispatch the wiki subagent yet, do it now:
- Agent tool: subagent_type="general-purpose", model="opus".
- Prompt template: docs/wiki/AUTHORING.md → "Wiki Update Subagent Prompt".
- Parameterized with linearIssueId=${issue_id}.

The subagent will read the issue + walk git diffs + update wiki content
and diagrams + run pnpm wiki:accept-drift + pnpm wiki:check + commit
and push. If it runs against an already-up-to-date wiki it will exit
clean with no commits.

Do not skip this. The wiki is not optional — it must stay within one
Linear issue of main.
</system-reminder>
EOF
