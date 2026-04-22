variable "environment" {
  description = "Used for tagging and secret name prefixes."
  type        = string
  default     = "staging"
}

variable "github_repository_owner_id" {
  description = "Numeric GitHub organization ID for 'mythrun'. Looked up via: curl -s https://api.github.com/orgs/mythrun | jq .id . Used in the OIDC trust policy's repository_owner_id condition — immune to org rename/reclaim attacks."
  type        = string
  default     = "274691930" # mythrun org (confirmed 2026-04-22 via GitHub API)
}

variable "alerts_email" {
  description = "Email address to subscribe to the staging alerts SNS topic. Must be confirmed by clicking the AWS confirmation link after apply. Kept separate from personal inbox so it transitions cleanly to a team alias (alerts@mythrun.com) or PagerDuty at Launch."
  type        = string
  default     = "miklos@mythrun.com"
}
