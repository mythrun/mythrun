# infra/modules/auth/variables.tf

variable "environment" {
  description = "Environment name, used in resource names and the Hosted UI domain prefix (e.g. \"staging\" → mythrun-staging-users / mythrun-staging.auth.us-east-1.amazoncognito.com)."
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "idps_enabled" {
  description = "Two-pass apply flag. Apply 1: false (creates User Pool, App Client, Hosted UI domain, OAuth secret shells, no IdPs). Human-action: paste OAuth client_id+client_secret JSON into Secrets Manager. Apply 2: flip to true to create the Google + Discord IdPs reading the secrets and update the App Client's supported_identity_providers list."
  type        = bool
  default     = false
}

variable "callback_urls" {
  description = "OAuth callback URL allowlist for the App Client. Cognito redirects here with `?code=...` after a successful sign-in. Must be a non-empty list of fully-qualified URLs. Example: [\"http://localhost:5173/auth/callback\"] for staging's local-frontend-only setup."
  type        = list(string)

  validation {
    condition     = length(var.callback_urls) > 0
    error_message = "callback_urls must contain at least one URL — Cognito's App Client requires a non-empty allowlist."
  }
}

variable "logout_urls" {
  description = "OAuth logout-redirect URL allowlist. Cognito redirects here after a `/logout` call. Must be a non-empty list of fully-qualified URLs. Example: [\"http://localhost:5173\"] for staging."
  type        = list(string)

  validation {
    condition     = length(var.logout_urls) > 0
    error_message = "logout_urls must contain at least one URL — Cognito's App Client requires a non-empty allowlist."
  }
}

variable "alerts_topic_arn" {
  description = "ARN of the SNS topic the Cognito throttling alarms publish to (myth-s48q). Empty disables alarm creation entirely, so an environment can stand its user pool up before its alerts topic exists. See infra/modules/auth/alarms.tf."
  type        = string
  default     = ""
}

variable "smoke_test_user_enabled" {
  description = "Provisions four native Cognito test users (one owner + three players, at mythrun-staging-smoke-{owner,player_1,player_2,player_3}@example.com) plus per-user Secrets Manager entries holding their credentials. Staging-only — production composition leaves this at the default. See infra/modules/auth/smoke-test.tf."
  type        = bool
  default     = false
}
