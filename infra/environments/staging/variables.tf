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
  description = "Email subscribed to the staging alerts SNS topic. Consolidated to dev@mythrun.com (2026-05-31) to match the AWS Budgets notification target — one inbox for both spend and operational alarms. NOTE: changing this recreates the subscription in PendingConfirmation; the new address must click the AWS confirmation link before alarms deliver. Transitions to a distribution list / PagerDuty at Launch (myth-z4f)."
  type        = string
  default     = "dev@mythrun.com"
}

variable "bootstrap_image_tag" {
  description = "Tag of the mythrun-bootstrap-db image to pin into the task definition. Format: bootstrap-db-<sha>-<run-attempt>. Bump after each script edit + image rebuild. No default — terraform.tfvars must supply, so a stale tag never silently sticks."
  type        = string
}

variable "github_build_role_cutover" {
  description = <<-EOT
    myth-jnb. false (the default) keeps ECR WRITE on mythrun-github-actions-staging,
    which is what CI uses today. true strips push / pull-through-cache-create from
    it, leaving a role that can deploy but not build.

    Flip this LAST. The full sequence lives in
    infra/environments/shared/github-actions-build-role.tf; the short version is:
    apply shared (creates mythrun-github-actions-build) -> create the `build`
    GitHub Environment with an AWS_ACCOUNT_ID variable -> point the build jobs at
    the new role and confirm a green run -> then flip this and apply staging.
    Flipping it before the build jobs have moved breaks every image push.
  EOT
  type        = bool
  default     = false
}

variable "pin_job_workflow_ref" {
  description = <<-EOT
    myth-651. Adds a `job_workflow_ref` StringEquals condition to the staging
    role's OIDC trust policy, so only the workflow FILES listed in
    local.staging_job_workflow_refs can assume it — not merely anything running
    on main in the staging environment.

    DEFAULT IS false ON PURPOSE: a wrong ref string does not degrade, it locks
    every deploy job out of AWS until someone reverts, and the claim's exact
    value cannot be confirmed from outside a real workflow run. See the matching
    variable in the shared workspace for how to read the claim off a live run
    before flipping this.
  EOT
  type        = bool
  default     = false
}

variable "cognito_idps_enabled" {
  description = "MYT-36 two-pass apply gate. Apply 1: false (creates Cognito User Pool, App Client, Hosted UI domain, OAuth secret shells, no IdPs). Human-action: register Google + Discord OAuth apps and paste {client_id, client_secret} JSON via aws secretsmanager put-secret-value. Apply 2: flip to true to create the IdPs reading the secrets and update the App Client's supported_identity_providers list."
  type        = bool
  default     = false
}

variable "cost_smoke_schedule_enabled" {
  description = <<-EOT
    Cost-wave1 §1.3 (T8). false (the default) creates the weekly cost-smoke
    EventBridge rule DISABLED: the task definition, roles, log group, and
    schedule wiring all exist and are manually invocable, but nothing fires
    on its own. Arming it today would buy a red task every Sunday, because
    the runner cannot complete against staging as-built:

      1. deploy.yml's task-def rotation only rotates the prep-pipeline
         family, so this family's image stays `:placeholder` (not a real
         tag; RunTask dies at image pull).
      2. cost-smoke.ts has no staging mode: its liveness gate + NDJSON
         capture read local dev log FILES (staging logs to CloudWatch:
         /mythrun/staging/{api,worker}), its drivers authenticate via the
         dev-sub bypass (staging is AUTH_MODE=real), expect whole
         DATABASE_URL / REDIS_*_URL values (staging injects parts + secrets;
         compose at startup like prep-pipeline.ts), and probe a worker
         health URL that staging does not expose across tasks.

    (A third blocker — the image not carrying scripts/cost — was closed by
    ec767930, which also landed the runner's cost_smoke.failed emission.)

    Flip to true (tfvars) and apply once both land. Failures before the
    drive phase spend $0 — the runner's liveness gate precedes any LLM call.
  EOT
  type        = bool
  default     = false
}
