# MYT-36 Cognito Pool + Google + Discord IdPs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Provision the staging Cognito User Pool with Google + Discord federated sign-in, expose the IDs and URLs as backend env vars, and remove the speculative `COGNITO_CLIENT_SECRET` wiring left over from MYT-25.

**Architecture:** New `infra/modules/auth/` Terraform module composed into `infra/environments/staging/`. Two-pass apply gated by `var.idps_enabled` — apply 1 creates Pool + App Client + Hosted UI domain + secret shells; human-action registers OAuth apps and pastes credentials; apply 2 creates the IdPs reading the secrets. No backend code, no ECS roll. The first deploy that consumes the new env vars happens at the start of MYT-37.

**Tech Stack:** Terraform AWS provider, AWS Cognito User Pools, AWS Secrets Manager.

**Spec:** `docs/superpowers/specs/2026-04-30-myt-36-cognito-pool-and-idps-design.md`

---

## File Structure

**Create:**
- `infra/modules/auth/variables.tf` — module inputs (`environment`, `idps_enabled`, `callback_urls`, `logout_urls`)
- `infra/modules/auth/main.tf` — `data.aws_region`, User Pool, App Client, Hosted UI domain, OAuth secret shells, IdP data sources + locals, IdP resources
- `infra/modules/auth/outputs.tf` — `user_pool_id`, `app_client_id`, `hosted_ui_domain`, `issuer_url`

**Modify:**
- `infra/environments/staging/variables.tf` — add `cognito_idps_enabled` bool
- `infra/environments/staging/terraform.tfvars` — initial `cognito_idps_enabled = false`
- `infra/environments/staging/main.tf` — instantiate `module "auth"`, extend `module.serving.extra_env` with the 4 `COGNITO_*` vars, remove `"cognito-client-secret"` from `manual_secret_names`
- `infra/modules/serving/main.tf:150` — remove the `COGNITO_CLIENT_SECRET` line from `common_secrets`

**No tests.** The Terraform module's verification is `terraform validate` (syntax + reference correctness), `terraform plan` from the staging composition (integration), and idempotent re-apply (drift-free state).

---

## Task 1: Module Variables

**Files:**
- Create: `infra/modules/auth/variables.tf`

- [ ] **Step 1: Create the variables file**

```hcl
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
```

- [ ] **Step 2: Verify file is well-formed**

```bash
cd infra/modules/auth && terraform fmt -check -diff
```

Expected: exit 0, no output (file is already formatted).

- [ ] **Step 3: Commit**

```bash
git add infra/modules/auth/variables.tf
git commit -m "infra(myt-36): auth module variables"
```

---

## Task 2: Core Resources (User Pool + App Client + Hosted UI domain)

**Files:**
- Create: `infra/modules/auth/main.tf`

- [ ] **Step 1: Create main.tf with the AWS region data source and User Pool**

```hcl
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
```

- [ ] **Step 2: Append the App Client resource**

Append to `infra/modules/auth/main.tf`:

```hcl

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
  access_token_validity  = 60                 # minutes (1 hour)
  id_token_validity      = 60                 # minutes (1 hour)
  refresh_token_validity = 30 * 24 * 60       # minutes (30 days)
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
```

- [ ] **Step 3: Run `terraform fmt`**

```bash
cd infra/modules/auth && terraform fmt
```

Expected: exit 0. Output may show `main.tf` if any formatting was applied.

- [ ] **Step 4: Validate the module**

```bash
cd infra/modules/auth && terraform init -backend=false && terraform validate
```

Expected: `terraform init` succeeds (downloads provider). `terraform validate` will FAIL with "Reference to undeclared resource: aws_cognito_identity_provider.google" because the IdP resources don't exist yet (we add them in Task 4). This is expected at this checkpoint; we'll re-validate after Task 4.

- [ ] **Step 5: Commit**

```bash
git add infra/modules/auth/main.tf
git commit -m "infra(myt-36): auth module User Pool, App Client, Hosted UI domain"
```

---

## Task 3: OAuth Secret Shells

**Files:**
- Modify: `infra/modules/auth/main.tf`

- [ ] **Step 1: Append both OAuth secret shells**

Append to `infra/modules/auth/main.tf`:

```hcl

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
```

- [ ] **Step 2: Format**

```bash
cd infra/modules/auth && terraform fmt
```

- [ ] **Step 3: Commit**

```bash
git add infra/modules/auth/main.tf
git commit -m "infra(myt-36): auth module OAuth secret shells"
```

`terraform validate` is still expected to fail with the missing-IdP-resource reference; we validate after Task 4.

---

## Task 4: IdP Layer (Data Sources + Locals + Count-Gated IdPs)

**Files:**
- Modify: `infra/modules/auth/main.tf`

- [ ] **Step 1: Append data sources, locals, and IdP resources**

Append to `infra/modules/auth/main.tf`:

```hcl

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
```

- [ ] **Step 2: Format and validate**

```bash
cd infra/modules/auth && terraform fmt && terraform validate
```

Expected: `terraform validate` now succeeds — `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/modules/auth/main.tf
git commit -m "infra(myt-36): auth module IdP layer (count-gated Google + Discord)"
```

---

## Task 5: Module Outputs

**Files:**
- Create: `infra/modules/auth/outputs.tf`

- [ ] **Step 1: Create the outputs file**

```hcl
# infra/modules/auth/outputs.tf

output "user_pool_id" {
  description = "Cognito User Pool ID. Consumed by backend env var COGNITO_USER_POOL_ID and aws cognito-idp CLI commands."
  value       = aws_cognito_user_pool.main.id
}

output "app_client_id" {
  description = "Cognito App Client ID. Consumed by backend env var COGNITO_APP_CLIENT_ID and OAuth flow URLs."
  value       = aws_cognito_user_pool_client.main.id
}

output "hosted_ui_domain" {
  description = "Fully-qualified Hosted UI domain (e.g. mythrun-staging.auth.us-east-1.amazoncognito.com). Backend constructs /oauth2/* paths from this. Built from the AWS region data source so the module is region-portable."
  value       = "${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"
}

output "issuer_url" {
  description = "OIDC issuer URL for JWT validation in MYT-37. Constructed from data.aws_region.current.name + the User Pool ID. JWT middleware verifies the iss claim against this exact string and derives the JWKS URL as ${issuer_url}/.well-known/jwks.json."
  value       = "https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.main.id}"
}
```

- [ ] **Step 2: Format and validate**

```bash
cd infra/modules/auth && terraform fmt && terraform validate
```

Expected: `Success! The configuration is valid.`

- [ ] **Step 3: Commit**

```bash
git add infra/modules/auth/outputs.tf
git commit -m "infra(myt-36): auth module outputs"
```

---

## Task 6: Compose Into Staging + Remove Speculative `cognito-client-secret` Wiring

**Files:**
- Modify: `infra/environments/staging/variables.tf`
- Modify: `infra/environments/staging/terraform.tfvars`
- Modify: `infra/environments/staging/main.tf`
- Modify: `infra/modules/serving/main.tf`

- [ ] **Step 1: Add `cognito_idps_enabled` to staging variables**

Append to `infra/environments/staging/variables.tf`:

```hcl

variable "cognito_idps_enabled" {
  description = "MYT-36 two-pass apply gate. Apply 1: false (creates Cognito User Pool, App Client, Hosted UI domain, OAuth secret shells, no IdPs). Human-action: register Google + Discord OAuth apps and paste {client_id, client_secret} JSON via aws secretsmanager put-secret-value. Apply 2: flip to true to create the IdPs reading the secrets and update the App Client's supported_identity_providers list."
  type        = bool
  default     = false
}
```

- [ ] **Step 2: Set initial value in `terraform.tfvars`**

Append to `infra/environments/staging/terraform.tfvars`:

```hcl
cognito_idps_enabled = false
```

- [ ] **Step 3: Remove `cognito-client-secret` from `manual_secret_names` in staging main.tf**

Modify `infra/environments/staging/main.tf` — the `manual_secret_names` local list. Current state (the line numbers may shift slightly; find by content):

```hcl
  manual_secret_names = [
    "anthropic-api-key",
    "stripe-secret-key",
    "stripe-webhook-secret",
    "cognito-client-secret",
  ]
```

Change to:

```hcl
  manual_secret_names = [
    "anthropic-api-key",
    "stripe-secret-key",
    "stripe-webhook-secret",
  ]
```

(Removed line: `    "cognito-client-secret",`. Reason: PKCE public client has no client secret; this MYT-25 leftover would otherwise inject the literal `"PLACEHOLDER — set via AWS Console / CLI"` string as `COGNITO_CLIENT_SECRET` on MYT-37's first deploy.)

- [ ] **Step 4: Add `module "auth"` instantiation to staging main.tf**

In `infra/environments/staging/main.tf`, immediately after the `module "serving"` block (currently ends around line 113) and before `module "bootstrap_db"`, insert:

```hcl

# ======== Auth Module (Cognito User Pool + Google + Discord IdPs) ========
# MYT-36. Two-pass apply: cognito_idps_enabled=false initially creates the
# Pool, App Client, Hosted UI domain, and OAuth secret shells with PLACEHOLDER
# values. Human-action registers OAuth apps and pastes {client_id, client_secret}
# JSON via aws secretsmanager put-secret-value. Flipping cognito_idps_enabled=true
# in terraform.tfvars and re-applying creates the IdPs reading the secrets.

module "auth" {
  source = "../../modules/auth"

  environment  = var.environment
  idps_enabled = var.cognito_idps_enabled

  # Staging is intentionally local-frontend-only per MYT-36 spec §6.
  # Production composition (myth-prod-auth-compose follow-up bead) adds the
  # production mythrun.com URLs onto a separate prod App Client.
  callback_urls = ["http://localhost:5173/auth/callback"]
  logout_urls   = ["http://localhost:5173"]
}
```

- [ ] **Step 5: Extend `module "serving"`'s `extra_env` with the four COGNITO_* vars**

In `infra/environments/staging/main.tf`, find the `extra_env` block in `module "serving"` (currently has only `BOOT_GATE_ENABLED`). Replace:

```hcl
  extra_env = [
    { name = "BOOT_GATE_ENABLED", value = "1" },
  ]
```

With:

```hcl
  extra_env = [
    { name = "BOOT_GATE_ENABLED",        value = "1" },                            # MYT-35
    { name = "COGNITO_USER_POOL_ID",     value = module.auth.user_pool_id },       # MYT-36
    { name = "COGNITO_APP_CLIENT_ID",    value = module.auth.app_client_id },      # MYT-36
    { name = "COGNITO_HOSTED_UI_DOMAIN", value = module.auth.hosted_ui_domain },   # MYT-36
    { name = "COGNITO_ISSUER_URL",       value = module.auth.issuer_url },         # MYT-36
  ]
```

- [ ] **Step 6: Remove `COGNITO_CLIENT_SECRET` line from `infra/modules/serving/main.tf`**

In `infra/modules/serving/main.tf`, find the `common_secrets` local list (around line 146-153). Current state:

```hcl
  common_secrets = [
    { name = "ANTHROPIC_API_KEY", valueFrom = var.manual_secret_arns["anthropic-api-key"] },
    { name = "STRIPE_SECRET_KEY", valueFrom = var.manual_secret_arns["stripe-secret-key"] },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = var.manual_secret_arns["stripe-webhook-secret"] },
    { name = "COGNITO_CLIENT_SECRET", valueFrom = var.manual_secret_arns["cognito-client-secret"] },
    { name = "DB_PASSWORD", valueFrom = var.rds_password_secret_arn },
    { name = "REDIS_AUTH_TOKEN", valueFrom = var.shared_redis_auth_secret_arn },
  ]
```

Change to (removing the COGNITO_CLIENT_SECRET line):

```hcl
  common_secrets = [
    { name = "ANTHROPIC_API_KEY", valueFrom = var.manual_secret_arns["anthropic-api-key"] },
    { name = "STRIPE_SECRET_KEY", valueFrom = var.manual_secret_arns["stripe-secret-key"] },
    { name = "STRIPE_WEBHOOK_SECRET", valueFrom = var.manual_secret_arns["stripe-webhook-secret"] },
    { name = "DB_PASSWORD", valueFrom = var.rds_password_secret_arn },
    { name = "REDIS_AUTH_TOKEN", valueFrom = var.shared_redis_auth_secret_arn },
  ]
```

- [ ] **Step 7: Format and validate the staging composition**

```bash
cd infra/environments/staging && terraform fmt && terraform init -reconfigure && terraform validate
```

Expected: `terraform init` re-syncs (now sees `module "auth"`). `terraform validate` returns `Success! The configuration is valid.`

- [ ] **Step 8: Commit**

```bash
git add infra/environments/staging/variables.tf \
        infra/environments/staging/terraform.tfvars \
        infra/environments/staging/main.tf \
        infra/modules/serving/main.tf
git commit -m "infra(myt-36): compose auth module into staging, remove cognito-client-secret"
```

---

## Task 7: Pre-Deploy Pre-check + TF Apply 1

This task does NOT commit code (already done). It executes the deploy and verifies state.

- [ ] **Step 1: Pre-check Hosted UI domain availability**

```bash
aws cognito-idp describe-user-pool-domain --domain mythrun-staging --region us-east-1
```

Expected: `An error occurred (ResourceNotFoundException)` — the prefix is free.

If the call succeeds and returns a `UserPoolId` belonging to a pool you don't own, STOP. Pick a new prefix (e.g. `mythrun-staging-myt`) and update `infra/modules/auth/main.tf`'s `aws_cognito_user_pool_domain.main.domain` line. Re-run the pre-check.

- [ ] **Step 2: Plan apply 1**

```bash
cd infra/environments/staging && terraform plan -out=apply1.tfplan
```

Expected plan diff:
- 1 to add: `aws_cognito_user_pool.main` (under `module.auth`)
- 1 to add: `aws_cognito_user_pool_client.main`
- 1 to add: `aws_cognito_user_pool_domain.main`
- 2 to add: `aws_secretsmanager_secret.{google_oauth,discord_oauth}`
- 2 to add: `aws_secretsmanager_secret_version.{google,discord}_oauth_placeholder`
- 0 IdPs (gated by `idps_enabled = false`)
- ECS task definition `mythrun-staging-api` updated: 4 new env vars added (`COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, `COGNITO_HOSTED_UI_DOMAIN`, `COGNITO_ISSUER_URL`); `COGNITO_CLIENT_SECRET` secret removed.
- 1 to destroy: `aws_secretsmanager_secret.manual_secrets["cognito-client-secret"]` and its `_version`.

If the plan shows anything else (e.g. unexpected destructive changes elsewhere), STOP and investigate.

- [ ] **Step 3: Apply 1**

```bash
terraform apply apply1.tfplan
```

Expected: applies all the planned changes. Final output includes the four `module.auth.*` outputs.

- [ ] **Step 4: Capture and record outputs**

```bash
terraform output | tee /tmp/myt-36-apply1-outputs.txt
```

Record (will be needed in Task 8):
- `module.auth.user_pool_id` — e.g. `us-east-1_AbCdEfGhI`
- `module.auth.app_client_id` — e.g. `7abc123def456ghi789jkl0`
- `module.auth.hosted_ui_domain` — `mythrun-staging.auth.us-east-1.amazoncognito.com`
- `module.auth.issuer_url` — `https://cognito-idp.us-east-1.amazonaws.com/us-east-1_AbCdEfGhI`

- [ ] **Step 5: Verify drift-free re-apply**

```bash
terraform plan
```

Expected: `No changes. Your infrastructure matches the configuration.` If a diff appears, investigate before continuing — the IdP layer relies on the resources being stable.

- [ ] **Step 6: Wait for Hosted UI domain DNS propagation**

```bash
sleep 90 && dig +short mythrun-staging.auth.us-east-1.amazoncognito.com
```

Expected: returns one or more IP addresses (CloudFront edge). If empty, wait another minute and retry.

---

## Task 8: Human Action — Register OAuth Apps + Paste Secrets

Operator-driven, ~20 min total. Output: real credentials in two Secrets Manager entries.

- [ ] **Step 1: Register Google OAuth app**

Open `console.cloud.google.com` → APIs & Services → OAuth consent screen.

If `mythrun.com` is not yet verified in this Google Cloud project (one-time per project):
- User Type: **External**
- App name: "Mythrun (staging)"
- User support email + Developer contact: `dev@mythrun.com`
- Authorized domains: `mythrun.com`
- Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile`

Then APIs & Services → Credentials → **Create OAuth 2.0 Client ID**:
- Application type: **Web application**
- Name: "Mythrun staging"
- Authorized JavaScript origins: `https://mythrun-staging.auth.us-east-1.amazoncognito.com`
- Authorized redirect URI: `https://mythrun-staging.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`

Copy the resulting `client_id` and `client_secret`.

- [ ] **Step 2: Paste Google credentials into Secrets Manager**

```bash
aws secretsmanager put-secret-value \
  --secret-id mythrun/staging/google-oauth \
  --secret-string '{"client_id":"<paste-client-id>","client_secret":"<paste-client-secret>"}' \
  --region us-east-1
```

Expected: returns the new `VersionId`.

- [ ] **Step 3: Register Discord OAuth app**

Open `discord.com/developers/applications` → **New Application** → name "Mythrun (staging)".

OAuth2 tab → Redirects → add `https://mythrun-staging.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` (set as the only redirect).

OAuth2 → General → copy `Client ID`. Click **Reset Secret** to generate a fresh `Client Secret` and copy it before navigating away.

- [ ] **Step 4: Paste Discord credentials into Secrets Manager**

```bash
aws secretsmanager put-secret-value \
  --secret-id mythrun/staging/discord-oauth \
  --secret-string '{"client_id":"<paste-client-id>","client_secret":"<paste-client-secret>"}' \
  --region us-east-1
```

Expected: returns the new `VersionId`.

- [ ] **Step 5: Verify both secrets contain real values**

```bash
aws secretsmanager get-secret-value --secret-id mythrun/staging/google-oauth --region us-east-1 --query SecretString --output text | jq .
aws secretsmanager get-secret-value --secret-id mythrun/staging/discord-oauth --region us-east-1 --query SecretString --output text | jq .
```

Expected: both print `{"client_id": "<real-id>", "client_secret": "<real-secret>"}` with non-PLACEHOLDER values.

---

## Task 9: TF Apply 2 — Flip Flag and Create IdPs

- [ ] **Step 1: Flip the flag in `terraform.tfvars`**

In `infra/environments/staging/terraform.tfvars`, change:

```hcl
cognito_idps_enabled = false
```

To:

```hcl
cognito_idps_enabled = true
```

- [ ] **Step 2: Plan apply 2**

```bash
cd infra/environments/staging && terraform plan -out=apply2.tfplan
```

Expected plan diff:
- 2 to add: `aws_cognito_identity_provider.{google,discord}` (under `module.auth`)
- 1 to update in-place: `aws_cognito_user_pool_client.main` (`supported_identity_providers` from `["COGNITO"]` to `["Google", "Discord"]`)
- The plan output should also show the data sources reading the secrets — confirm the Google/Discord client_id values appearing in the plan match what you pasted in Task 8 (NOT the literal "PLACEHOLDER" string). If you see PLACEHOLDER, STOP — the paste in Task 8 didn't land or the secret_id is wrong.

If the plan diff includes anything else (resource recreates, destroys), STOP and investigate.

- [ ] **Step 3: Apply 2**

```bash
terraform apply apply2.tfplan
```

Expected: 2 IdPs created, App Client updated. No errors.

If creation fails with `Unable to contact well-known endpoint`, retry — Discord's discovery doc occasionally has transient unavailability. If persistent (>30 min), check Discord's status page.

- [ ] **Step 4: Commit the flag flip**

```bash
git add infra/environments/staging/terraform.tfvars
git commit -m "infra(myt-36): apply 2 — enable Google + Discord IdPs in staging"
```

- [ ] **Step 5: Verify drift-free re-apply**

```bash
terraform plan
```

Expected: `No changes. Your infrastructure matches the configuration.` If a diff appears (e.g. on `provider_details`), Cognito normalized something — investigate and either accept the new shape in the spec or add the offending field to a `lifecycle.ignore_changes` list on the IdP resource.

---

## Task 10: Verification

- [ ] **Step 1: Click-through Google sign-in**

Get the App Client ID:

```bash
APP_CLIENT_ID=$(cd infra/environments/staging && terraform output -raw -module=auth app_client_id 2>/dev/null || aws cognito-idp list-user-pool-clients --user-pool-id $(terraform -chdir=infra/environments/staging output -raw -module=auth user_pool_id) --region us-east-1 --query 'UserPoolClients[0].ClientId' --output text)
echo $APP_CLIENT_ID
```

Open this URL in a browser (substitute `<APP_CLIENT_ID>` if the variable substitution doesn't carry to your browser):

```
https://mythrun-staging.auth.us-east-1.amazoncognito.com/login?response_type=code&client_id=<APP_CLIENT_ID>&redirect_uri=http://localhost:5173/auth/callback&scope=openid+email+profile&identity_provider=Google
```

Expected flow:
1. Cognito's `/login` endpoint redirects to Google's consent screen.
2. Sign in with a Google account.
3. Google redirects back to Cognito's `/oauth2/idpresponse`.
4. Cognito redirects to `http://localhost:5173/auth/callback?code=<auth-code>`.
5. Browser lands at `localhost:5173/auth/callback?code=...` (the page won't render — there's no frontend yet — but the URL bar's `code=...` is the success signal).

If the browser shows an error page from Cognito or from Google, capture the error and consult the design's §10 error table.

- [ ] **Step 2: Click-through Discord sign-in**

Same URL pattern with `identity_provider=Discord`:

```
https://mythrun-staging.auth.us-east-1.amazoncognito.com/login?response_type=code&client_id=<APP_CLIENT_ID>&redirect_uri=http://localhost:5173/auth/callback&scope=openid+email+profile&identity_provider=Discord
```

Expected: same flow ending at `localhost:5173/auth/callback?code=...`.

- [ ] **Step 3: Verify user records in Cognito**

```bash
USER_POOL_ID=$(terraform -chdir=infra/environments/staging output -raw -module=auth user_pool_id)
aws cognito-idp list-users --user-pool-id $USER_POOL_ID --region us-east-1
```

Expected: 2 user entries — one with `Username: Google_<numeric-id>`, one with `Username: Discord_<snowflake>`. Each should have populated `email`, `name`, and `picture` attributes in the `Attributes` array.

If a user record exists but `name`/`picture` is empty, the IdP attribute mapping isn't working — see the design's §10 error table (specifically the "Discord users have empty `name` or `picture`" row, which calls out missing scopes).

---

## Task 11: File Follow-up Beads + Close MYT-36

- [ ] **Step 1: File the four follow-up beads in parallel**

```bash
bd create --title="Compose auth module into production environment" --description="Instantiate infra/modules/auth in infra/environments/production/main.tf once production composition is ready. Includes the custom auth.mythrun.com Hosted UI domain via var.custom_domain (currently unspecified — module currently uses default Cognito domain only), separate Google + Discord OAuth clients per env (each provider requires distinct OAuth clients to keep redirect URIs separate), and prod callback URLs once the prod frontend domain is decided. Bumps recovery_window_in_days back up to 30 for prod. Source: docs/superpowers/specs/2026-04-30-myt-36-cognito-pool-and-idps-design.md §12." --type=task --priority=2

bd create --title="Cognito monitoring: CloudWatch alarms + secret-age" --description="Wire CloudWatch alarms on Cognito metrics (SignInSuccesses rate-of-change, SignInThrottles > 0 for 5min, FederationThrottles > 0) and Secrets Manager secret-age alarms on mythrun/{env}/google-oauth and mythrun/{env}/discord-oauth (alert at 150 days, hard at 180). Compose the alarm targets onto the existing aws_sns_topic.alerts. Required before prod composition; staging click-through verification works without it. Source: docs/superpowers/specs/2026-04-30-myt-36-cognito-pool-and-idps-design.md §12." --type=task --priority=3

bd create --title="Cognito user-record nightly export to S3 (DR)" --description="Nightly Lambda or scheduled task that runs aws cognito-idp list-users and writes the result to an S3 prefix with 90-day retention. Cognito has no native PITR or cross-region replication, so a corrupted/deleted User Pool is recoverable only to user-record granularity from these exports. Required before prod users are onboarded; staging has no users to export today. Source: docs/superpowers/specs/2026-04-30-myt-36-cognito-pool-and-idps-design.md §12." --type=task --priority=3

bd create --title="Recovery email flow (post-launch follow-up)" --description="Add a post-signup recovery-email flow (magic-link reset) if real users surface OAuth-account-loss complaints. Allows users to reclaim their account from a new OAuth provider if their original (Google/Discord) account becomes unavailable. Skip until a complaint surfaces. Source: docs/superpowers/specs/2026-04-30-myt-36-cognito-pool-and-idps-design.md §11 + §12." --type=task --priority=4
```

Expected: 4 new bead IDs printed.

- [ ] **Step 2: Push all commits**

```bash
git push origin main
```

- [ ] **Step 3: Dispatch the wiki-update subagent**

Per CLAUDE.md "Wiki is not optional" rule, dispatch the AUTHORING.md subagent to update wiki content for this ticket. Use the prompt at `docs/wiki/AUTHORING.md` parameterized with `MYT-36`. The subagent commits its own changes locally; verify a commit appears, then push.

- [ ] **Step 4: Push the wiki commit**

```bash
git push origin main
```

- [ ] **Step 5: Flip MYT-36 to Done**

Use `mcp__linear-server__save_issue` with `id=MYT-36`, `state="Done"`.
