#!/usr/bin/env bash
# PostToolUse hook for Write where the file is a superpowers design spec.
# Reads the tool input JSON from stdin. Emits a PostToolUse hookSpecificOutput
# directing the main agent to invoke the global blind-review skill.
#
# Match: docs/superpowers/specs/*-design.md (path relative to repo root or
# the user's session cwd). Edit-tool fires aren't matched — only Write —
# so per-edit refinement during round fixes doesn't re-prompt.

set -euo pipefail

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

file_path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "${file_path:-}" ]]; then
  exit 0
fi

# Match the spec naming convention (YYYY-MM-DD-<topic>-design.md under
# docs/superpowers/specs/). Don't match plans/, schemas/, etc.
if [[ ! "$file_path" =~ docs/superpowers/specs/.*-design\.md$ ]]; then
  exit 0
fi

cat <<'EOF'
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "You just wrote a superpowers design spec. The blind-review skill is the next workflow step BEFORE the user-review gate and writing-plans. Invoke it now via the Skill tool: `Skill(skill='blind-review', args='<spec_path>')`. The skill will ask the user whether to run a review team (and which lenses), dispatch reviewers, classify findings against the strict SUBSTANTIAL rubric, and apply the stopping rule. Do NOT skip this — severity drift across rounds is the failure mode this skill exists to prevent."
  }
}
EOF
