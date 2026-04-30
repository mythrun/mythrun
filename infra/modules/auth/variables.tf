# infra/modules/auth/variables.tf

variable "environment" {
  description = "Environment name, used in resource names and the Hosted UI domain prefix (e.g. \"staging\" → mythrun-staging-users / mythrun-staging.auth.us-east-1.amazoncognito.com)."
  type        = string
}

variable "idps_enabled" {
  description = "Two-pass apply flag. Apply 1: false (creates User Pool, App Client, Hosted UI domain, OAuth secret shells, no IdPs). Human-action: paste OAuth client_id+client_secret JSON into Secrets Manager. Apply 2: flip to true to create the Google + Discord IdPs reading the secrets and update the App Client's supported_identity_providers list."
  type        = bool
  default     = false
}

variable "callback_urls" {
  description = "OAuth callback URL allowlist for the App Client. Staging uses [\"http://localhost:5173/auth/callback\"] only — staging is intentionally local-frontend-only per MYT-36 spec §6."
  type        = list(string)
}

variable "logout_urls" {
  description = "OAuth logout-redirect URL allowlist. Staging uses [\"http://localhost:5173\"]."
  type        = list(string)
}
