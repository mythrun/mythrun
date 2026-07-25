variable "environment" {
  description = "Used for tagging. Fixed to 'shared' in this workspace."
  type        = string
  default     = "shared"
}

variable "alerts_email" {
  description = "Email subscribed to the SHARED alerts SNS topic (mythrun-shared-alerts), which carries alarms on the resources every environment sits on: the RDS instance, the Redis replication group, the ALB, the wildcard ACM cert, the NAT gateway. Matches the staging workspace's alerts_email default so both topics land in one inbox. NOTE: changing this recreates the subscription in PendingConfirmation; the new address must click the AWS confirmation link before alarms deliver. Transitions to a distribution list / PagerDuty at Launch (myth-z4f)."
  type        = string
  default     = "dev@mythrun.com"
}

variable "github_repository_id" {
  description = "Numeric GitHub repository ID for 'mythrun/mythrun' (gh api repos/mythrun/mythrun --jq .id). Used in the build role's OIDC trust policy, where it is the condition immune to both repo-rename and org-rename/reclaim. Mirrors the staging workspace's variable of the same name — the two must agree."
  type        = string
  default     = "1216403029" # mythrun/mythrun repo (confirmed 2026-04-24 via GitHub API)
}

variable "pin_job_workflow_ref" {
  description = <<-EOT
    myth-651. Adds a `job_workflow_ref` StringEquals condition to the GitHub
    Actions OIDC trust policies, pinning role assumption to specific workflow
    FILES rather than merely to the repo + environment + branch. Without it, any
    workflow file merged to main can assume the role within its environment;
    with it, only the enumerated workflows can.

    AWS added provider-specific claim validation in February 2026 and lists
    `job_workflow_ref` among the supported GitHub OIDC condition keys, so this
    needs no GitHub-side subject-claim customization — the claim is emitted by
    default.

    DEFAULT IS false ON PURPOSE. Getting a ref string wrong does not fail
    softly: every job that assumes the role stops being able to, and CI is down
    until someone reverts. The claim values cannot be confirmed from outside a
    real workflow run. Before flipping this, read the actual value off a run —
    add a step that decodes the OIDC token
    (`curl "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN"`,
    then base64-decode the payload) and compare it against the lists in
    github-actions-build-role.tf and the staging workspace's main.tf. Flip, apply,
    and watch the next run.
  EOT
  type        = bool
  default     = false
}

variable "monthly_budget_usd" {
  description = "Limit, in USD, of the account-wide monthly cost budget (myth-57l). MUST match the live budget's amount or `terraform plan` will show a diff after the import — the budget was created out-of-band at $100 before it was codified here. Raising it is a deliberate act: the notifications below are the only thing standing between a runaway LLM spend and the invoice."
  type        = string
  default     = "100"
}
