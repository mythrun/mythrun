#!/usr/bin/env bash
# PostToolUse hook for the Skill tool. Reads the tool input from stdin; if the
# skill being invoked is the brainstorming skill, prints a system-reminder
# directing the agent to use AskUserQuestion for multi-choice prompts instead
# of inline markdown A/B/C lists.
#
# Backstop for `feedback_ask_user_question.md` — the rule lived in memory but
# wasn't being applied at the moment it bit. This hook puts it directly in
# context the moment a brainstorm starts.

set -euo pipefail

input=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

skill=$(printf '%s' "$input" | jq -r '.tool_input.skill // empty')

# Match either the plugin-namespaced form or a bare "brainstorming" name.
case "$skill" in
  *brainstorming|*brainstorming/*)
    ;;
  *)
    exit 0
    ;;
esac

cat <<'EOF'
<system-reminder>
Brainstorming skill just loaded. Use the AskUserQuestion tool for any
multi-choice question (A/B/C between approaches, scope toggles, naming
choices, etc.). Do NOT post inline markdown bullet lists asking the user
to pick — the surveyed options are easier to read and answer when they
arrive as structured options.

Per Mythrun memory feedback_ask_user_question.md.

Open-ended questions ("what should X do?") are still fine as plain text;
this rule applies specifically to multi-choice asks.
</system-reminder>
EOF
