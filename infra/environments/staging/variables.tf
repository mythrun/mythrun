variable "environment" {
  description = "Used for tagging and secret name prefixes."
  type        = string
  default     = "staging"
}

variable "github_repository_id" {
  description = "Numeric GitHub repository ID for 'mythrun/mythrun'. Looked up via: gh api repos/mythrun/mythrun --jq .id . Used in the OIDC trust policy's `repository_id` condition — immune to BOTH repo-rename AND org-rename/reclaim attacks. We originally tried `repository_owner_id` in MYT-28 but it's not in AWS IAM's allowlist of supported condition keys for the GitHub OIDC provider (see AWS re:Post KB on OIDC IdP federation errors). `repository_id` IS supported and is strictly stronger."
  type        = string
  default     = "1216403029" # mythrun/mythrun repo (confirmed 2026-04-24 via GitHub API)
}

variable "alerts_email" {
  description = "Email address to subscribe to the staging alerts SNS topic. Must be confirmed by clicking the AWS confirmation link after apply. Kept separate from personal inbox so it transitions cleanly to a team alias (alerts@mythrun.com) or PagerDuty at Launch."
  type        = string
  default     = "miklos@mythrun.com"
}
