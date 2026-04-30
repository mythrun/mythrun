# infra/modules/auth/main.tf

# Used in the issuer_url + hosted_ui_domain outputs so the module is portable
# to a future region without a code change. Today this is us-east-1; the prod
# composition (myth-prod-auth-compose follow-up) instantiates the module from
# the same provider.
data "aws_region" "current" {}

resource "aws_cognito_user_pool" "main" {
  name = "mythrun-${var.environment}-users"

  # Federated only — no email/password sign-in. Sign-in attribute is "email"
  # because OAuth providers always return one and we use it as the natural key
  # at the IdP layer (Cognito's `sub` is still our internal foreign key).
  username_attributes      = ["email"]
  auto_verified_attributes = ["email"]

  # `email` is a Cognito built-in standard attribute — do NOT redeclare it
  # via a `schema {}` block, which can produce InvalidParameterException on
  # apply for some provider versions. Cognito treats it as required when it
  # appears in `username_attributes`.

  # Protect against `terraform destroy` and accidental state-detach. Removing
  # the pool destroys every user record and invalidates every JWT.
  deletion_protection = "ACTIVE"

  # MFA off for staging per MYT-36 + Auth spec §2.1. Revisit at Launch.
  mfa_configuration = "OFF"

  # Cognito requires *some* recovery mechanism even for federated-only pools.
  # `verified_email` is the only mechanism that doesn't require SMS posture;
  # for OAuth-only sign-in it never actually fires (users have no Cognito
  # password to recover) but the API contract demands it.
  account_recovery_setting {
    recovery_mechanism {
      name     = "verified_email"
      priority = 1
    }
  }

  tags = { Name = "mythrun-${var.environment}-users" }
}

resource "aws_cognito_user_pool_client" "main" {
  name         = "mythrun-${var.environment}-web"
  user_pool_id = aws_cognito_user_pool.main.id

  # Public client — PKCE proves browser identity, no secret to leak in JS.
  # PKCE is enforced automatically by Cognito for public clients using the
  # code grant; there's no separate "require PKCE" toggle.
  generate_secret = false

  # Authorization code grant + PKCE (SPA flow per Auth spec §3).
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_scopes                 = ["openid", "email", "profile"]

  # Federated sign-in produces tokens via the OAuth flow; once the SPA has a
  # refresh token, only the REFRESH_TOKEN_AUTH flow is needed for renewal
  # (which is what the parent §6.1 `/api/auth/refresh` endpoint exercises).
  # Set explicitly so a Cognito provider upgrade can't silently re-introduce
  # ALLOW_USER_PASSWORD_AUTH (or ALLOW_USER_SRP_AUTH or
  # ALLOW_ADMIN_USER_PASSWORD_AUTH) and defeat the federated-only intent.
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  # Apply 1: ["COGNITO"] (Cognito rejects an empty list).
  # Apply 2: ["Google", "Discord"] after IdPs are created. The depends_on
  # below enforces the apply-2 ordering — without it, TF can plan the IdP
  # create and the client update in parallel and Cognito rejects the update
  # with "InvalidParameterException: Identity provider Google does not exist".
  supported_identity_providers = var.idps_enabled ? ["Google", "Discord"] : ["COGNITO"]

  depends_on = [
    aws_cognito_identity_provider.google,
    aws_cognito_identity_provider.discord,
  ]

  # Token expirations per Auth spec §2.1.
  access_token_validity  = 60           # minutes (1 hour)
  id_token_validity      = 60           # minutes (1 hour)
  refresh_token_validity = 30 * 24 * 60 # minutes (30 days)
  token_validity_units {
    access_token  = "minutes"
    id_token      = "minutes"
    refresh_token = "minutes"
  }

  # Refresh-token rotation per Auth spec §6.3 — each use mints a new refresh
  # token and invalidates the previous one. Distinct from enable_token_revocation
  # below, which powers the parent §10 `/api/auth/logout` route's "revoke Cognito
  # tokens" line.
  refresh_token_rotation {
    feature = "ENABLED"
  }

  enable_token_revocation = true

  # Hardening default — without this, Cognito's error-response shapes leak
  # whether a given email is registered.
  prevent_user_existence_errors = "ENABLED"
}

resource "aws_cognito_user_pool_domain" "main" {
  domain       = "mythrun-${var.environment}"
  user_pool_id = aws_cognito_user_pool.main.id
}

# Google OAuth client_id + client_secret JSON. Populated out-of-band by
# `aws secretsmanager put-secret-value` after registering the Google OAuth
# app. recovery_window_in_days = 0 because staging values are reproducible
# from the provider portals; production composition should override this
# to 30 days.
resource "aws_secretsmanager_secret" "google_oauth" {
  name                    = "mythrun/${var.environment}/google-oauth"
  description             = "Google OAuth client_id + client_secret JSON for Cognito IdP"
  recovery_window_in_days = 0
  tags                    = { Name = "mythrun-${var.environment}-google-oauth" }
}

resource "aws_secretsmanager_secret_version" "google_oauth_placeholder" {
  secret_id     = aws_secretsmanager_secret.google_oauth.id
  secret_string = jsonencode({ client_id = "PLACEHOLDER", client_secret = "PLACEHOLDER" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

resource "aws_secretsmanager_secret" "discord_oauth" {
  name                    = "mythrun/${var.environment}/discord-oauth"
  description             = "Discord OAuth client_id + client_secret JSON for Cognito IdP"
  recovery_window_in_days = 0
  tags                    = { Name = "mythrun-${var.environment}-discord-oauth" }
}

resource "aws_secretsmanager_secret_version" "discord_oauth_placeholder" {
  secret_id     = aws_secretsmanager_secret.discord_oauth.id
  secret_string = jsonencode({ client_id = "PLACEHOLDER", client_secret = "PLACEHOLDER" })

  lifecycle {
    ignore_changes = [secret_string]
  }
}

data "aws_secretsmanager_secret_version" "google_oauth" {
  count     = var.idps_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.google_oauth.id
  # `version_stage` defaults to AWSCURRENT — what `aws secretsmanager
  # put-secret-value` advances on every paste. DO NOT pin `version_id`;
  # that would freeze the data source on a historical version and break
  # the rotation runbook (each rotation would require a TF code change
  # to update the pinned version).
}

data "aws_secretsmanager_secret_version" "discord_oauth" {
  count     = var.idps_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.discord_oauth.id
}

locals {
  google_oauth  = var.idps_enabled ? jsondecode(data.aws_secretsmanager_secret_version.google_oauth[0].secret_string) : null
  discord_oauth = var.idps_enabled ? jsondecode(data.aws_secretsmanager_secret_version.discord_oauth[0].secret_string) : null
}

resource "aws_cognito_identity_provider" "google" {
  count         = var.idps_enabled ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Google"
  provider_type = "Google"

  provider_details = {
    client_id        = local.google_oauth.client_id
    client_secret    = local.google_oauth.client_secret
    authorize_scopes = "openid email profile"
  }

  attribute_mapping = {
    email    = "email"
    name     = "name"
    picture  = "picture"
    username = "sub" # Cognito requires "username" mapping; Google's sub is stable + unique.
  }
}

# Discord is configured as a generic OIDC provider, NOT via the legacy
# /api/users/@me OAuth-only path that the parent Auth & Users spec §2.4
# originally cited. Discord publishes a working OIDC discovery document at
# https://discord.com/.well-known/openid-configuration and a spec-compliant
# userinfo endpoint at https://discord.com/api/oauth2/userinfo. Using OIDC
# means Cognito mints an id_token from Discord's claims and the attribute
# mapping references OIDC standard names (sub, preferred_username, email,
# picture).
#
# Scope rules: `openid` gates the userinfo endpoint and returns `sub`;
# `identify` is required to get `preferred_username` and `picture`; `email`
# adds `email` and `email_verified`. All three are needed for the attribute
# mapping below to populate.
resource "aws_cognito_identity_provider" "discord" {
  count         = var.idps_enabled ? 1 : 0
  user_pool_id  = aws_cognito_user_pool.main.id
  provider_name = "Discord"
  provider_type = "OIDC"

  provider_details = {
    client_id                 = local.discord_oauth.client_id
    client_secret             = local.discord_oauth.client_secret
    attributes_request_method = "GET"
    oidc_issuer               = "https://discord.com"
    authorize_scopes          = "openid identify email"
    # Cognito CAN autodiscover these from the issuer's well-known doc, but
    # pinning them removes a runtime dependency on Discord's discovery doc
    # availability and makes the contract auditable from the TF.
    authorize_url  = "https://discord.com/api/oauth2/authorize"
    token_url      = "https://discord.com/api/oauth2/token"
    attributes_url = "https://discord.com/api/oauth2/userinfo"
    jwks_uri       = "https://discord.com/api/oauth2/keys"
  }

  attribute_mapping = {
    email    = "email"
    name     = "preferred_username" # Discord's chosen display name (OIDC claim).
    picture  = "picture"            # Discord's OIDC userinfo returns a CDN URL directly.
    username = "sub"                # Stable Discord user id (snowflake) exposed as OIDC sub.
  }
}
