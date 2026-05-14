#!/usr/bin/env bash
# UserPromptSubmit hook. On every user prompt, check `tmp/ci-status/`
# for marker files written by the deferred CI checker. If any exist,
# surface them as a single <system-reminder> block and delete them
# (one-shot — I don't want the same red push nagging across multiple
# prompts).

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then exit 0; fi

status_dir="$repo_root/tmp/ci-status"
if [[ ! -d "$status_dir" ]]; then exit 0; fi

shopt -s nullglob
markers=("$status_dir"/*.txt)
if [[ ${#markers[@]} -eq 0 ]]; then exit 0; fi

# Concatenate all marker contents, then delete them.
combined=""
for f in "${markers[@]}"; do
  combined+="$(cat "$f")"$'\n\n'
  rm -f "$f"
done

# Trim trailing whitespace.
combined="${combined%$'\n\n'}"

cat <<EOF
<system-reminder>
CI status follow-up (from the 10-min-after-push timer):

${combined}

These are the workflows that went red on a recent push. Triage the
failures before continuing with new work — or explicitly tell the user
to acknowledge and defer.
</system-reminder>
EOF
