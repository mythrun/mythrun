#!/usr/bin/env bash
# UserPromptSubmit hook. On every user prompt, check `tmp/ci-status/`
# for marker files written by the deferred CI checker. If any exist,
# surface them as a single <system-reminder> block and delete them
# (one-shot — same push shouldn't nag across prompts).
#
# Markers start with a `STATUS: success|failed|in_progress|no_runs|gh_missing`
# line. The framing of the system-reminder depends on the worst-case
# status across all markers: failed > in_progress > no_runs/gh_missing
# > success. This means a single failed push routes the reminder to the
# "triage" framing even if other pushes in the same prompt were green.

set -euo pipefail

repo_root=$(git rev-parse --show-toplevel 2>/dev/null || true)
if [[ -z "$repo_root" ]]; then exit 0; fi

status_dir="$repo_root/tmp/ci-status"
if [[ ! -d "$status_dir" ]]; then exit 0; fi

shopt -s nullglob
markers=("$status_dir"/*.txt)
if [[ ${#markers[@]} -eq 0 ]]; then exit 0; fi

# Worst-case status across all markers, used to choose the framing line.
# Priority order: failed > in_progress > no_runs/gh_missing > success.
worst="success"
for f in "${markers[@]}"; do
  status_line=$(head -1 "$f" | sed 's/^STATUS: //')
  case "$status_line" in
    failed)
      worst="failed"; break ;;  # short-circuit on the worst case
    in_progress)
      [[ "$worst" == "success" || "$worst" == "no_runs" || "$worst" == "gh_missing" ]] && worst="in_progress" ;;
    no_runs|gh_missing)
      [[ "$worst" == "success" ]] && worst="$status_line" ;;
  esac
done

# Concatenate all marker contents (minus their STATUS lines), then
# delete the markers.
combined=""
for f in "${markers[@]}"; do
  combined+="$(tail -n +2 "$f")"$'\n\n'
  rm -f "$f"
done
combined="${combined%$'\n\n'}"

case "$worst" in
  failed)
    framing="One or more workflows failed. Triage before continuing — or explicitly tell the user to acknowledge and defer."
    ;;
  in_progress)
    framing="Workflows still running after the 10-min check. Not a failure signal; revisit if you push again or if the user asks for status."
    ;;
  no_runs)
    framing="CI didn't trigger on this push (paths filter mismatch is the usual cause, or gh auth lapsed). Not a failure signal."
    ;;
  gh_missing)
    framing="The 'gh' CLI isn't available, so CI status wasn't checked. Not a failure signal."
    ;;
  success)
    framing="All CI workflows succeeded. Informational only — no action needed."
    ;;
esac

cat <<EOF
<system-reminder>
CI status follow-up (from the 10-min-after-push timer):

${combined}

${framing}
</system-reminder>
EOF
