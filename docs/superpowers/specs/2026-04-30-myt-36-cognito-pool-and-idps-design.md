# MYT-36 — Cognito User Pool + Google + Discord IdPs (Design)

> **Status**: Draft v2 (post round-1 blind review)
> **Date**: 2026-04-30
> **Linear**: [MYT-36](https://linear.app/mythrun/issue/MYT-36/auth-cognito-user-pool-google-discord-identity-providers)
> **Parent spec**: `docs/specs/2026-04-13-auth-users.md` §2 (parent §2.4 corrected as part of this design — see §5 below)
> **Scope**: Provision the staging Cognito User Pool + App Client + Hosted UI domain, wire Google and Discord as federated identity providers, expose the IDs and URLs as backend env vars, and remove the speculative `COGNITO_CLIENT_SECRET` wiring left over from MYT-25. Backend code that consumes the new env vars (JWT middleware, `/api/auth/refresh`) ships in MYT-37.

---

## Table of Contents

1. [Goal & Done-When](#1-goal--done-when)
2. [Architecture](#2-architecture)
3. [Module Surface](#3-module-surface)
4. [User Pool & App Client Resources](#4-user-pool--app-client-resources)
5. [Hosted UI Domain & IdP Resources](#5-hosted-ui-domain--idp-resources)
6. [Staging Composition Wiring](#6-staging-composition-wiring)
7. [Deploy Sequence](#7-deploy-sequence)
8. [Human-Action Runbook](#8-human-action-runbook)
9. [Testing & Verification](#9-testing--verification)
10. [Error Handling & Recovery](#10-error-handling--recovery)
11. [Out of Scope](#11-out-of-scope)
12. [Follow-up Beads](#12-follow-up-beads)

---

## 1. Goal & Done-When

**Goal:** Stand up the staging Cognito User Pool with Google and Discord federated sign-in, ready for the JWT middleware to consume in MYT-37. No backend code changes. No ECS roll. Infra-only.

**Done when:**

- `infra/modules/auth/` exists and is composed in `infra/environments/staging/main.tf`.
- `terraform apply` (apply 1, `idps_enabled=false`) creates: User Pool (with `deletion_protection = "ACTIVE"`), App Client (PKCE public client, refresh-token rotation enabled, `explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]`), Hosted UI domain (default Cognito-managed `mythrun-staging.auth.us-east-1.amazoncognito.com`), Google + Discord OAuth Secrets Manager shells (PLACEHOLDER JSON values).
- The speculative `mythrun/staging/cognito-client-secret` shell from MYT-25 is removed: deleted from `infra/environments/staging/main.tf`'s `manual_secret_names` list, and its env-var wiring (`{ name = "COGNITO_CLIENT_SECRET", valueFrom = ... }` at `infra/modules/serving/main.tf:150`) is removed. PKCE public clients have no client secret; this MYT-25 leftover would otherwise inject the literal `"PLACEHOLDER — set via AWS Console / CLI"` string as `COGNITO_CLIENT_SECRET` on MYT-37's first deploy.
- Human-action: register Google OAuth client + Discord OAuth client, paste each `{client_id, client_secret}` JSON via `aws secretsmanager put-secret-value`.
- `terraform apply` (apply 2, `idps_enabled=true`) creates the two `aws_cognito_identity_provider` resources reading the secrets, and updates the App Client's `supported_identity_providers` from `["COGNITO"]` to `["Google", "Discord"]`. Apply ordering is enforced by an explicit `depends_on` on the App Client.
- Click-through verification: opening the Hosted UI's `/login` URL with `identity_provider=Google` (and again with `=Discord`) redirects through the provider and lands back at `localhost:5173/auth/callback?code=...` (the page won't render — there's no frontend yet — but the URL bar's `code=...` proves the OAuth round-trip succeeded).
- `aws cognito-idp list-users --user-pool-id <id>` shows two user records with populated `email`, `name`, and `picture` attributes.
- The four env vars `COGNITO_USER_POOL_ID`, `COGNITO_APP_CLIENT_ID`, `COGNITO_HOSTED_UI_DOMAIN`, `COGNITO_ISSUER_URL` are wired into the staging serving module's `extra_env` list. **The ECS service is NOT rolled in this ticket** — backend code that reads these env vars ships in MYT-37, which triggers the first deploy that consumes them.

**Out of MYT-36's done-when:** JWT middleware, `/api/auth/refresh`, onboarding endpoints, ticket exchange, suspended-user enforcement, custom Hosted UI styling, production composition.

---

## 2. Architecture

### Federated-only sign-in, no email+password

The audience for Mythrun overlaps near-totally with Discord and Google account holders. The Auth & Users spec (§2.1) and this design intentionally skip email+password to avoid a class of operational and security work — password storage and rotation, reset flows, brute-force defense, MFA implementation, the breach-narrative blast radius — that a TTRPG-audience product doesn't need to take on. Recovery-email and multi-provider-linking are roadmapped as post-launch follow-ups if real users surface account-loss complaints.

### Public client + PKCE for the SPA

The App Client uses Authorization Code grant with PKCE and **`generate_secret = false`** ("public client"). The browser SPA proves identity via PKCE's `code_verifier`, with no client secret to leak in JavaScript. The backend's `/api/auth/refresh` endpoint (MYT-37) uses the public-client refresh-token grant — also no client secret needed.

### Default Cognito Hosted UI domain in staging

Staging uses AWS's default `mythrun-staging.auth.us-east-1.amazoncognito.com`. No DNS work, no certificate hand-off from the `dns` module, no CloudFront distribution to maintain. Production gets a custom `auth.mythrun.com` domain in a later ticket; this module reserves a `var.custom_domain` knob for that addition without resource recreate.

### Two-pass apply gated by `var.idps_enabled`

Cognito IdP resources demand the OAuth client_secret at create time. We can't create the IdP from a placeholder and update later cleanly (the secret value lives in `provider_details`, which Cognito normalizes; trying to lifecycle-ignore it produces drift). Instead:

- **Apply 1** (`idps_enabled=false`): creates everything except the two IdPs. Secret shells exist with PLACEHOLDER JSON.
- **Human action**: register OAuth apps with both providers, paste real `{client_id, client_secret}` JSON into Secrets Manager.
- **Apply 2** (`idps_enabled=true`): TF reads the secrets via `data.aws_secretsmanager_secret_version` + `jsondecode()`, creates the two IdPs, updates the App Client's `supported_identity_providers`.

The `idps_enabled` flag makes the two-pass intent legible in the config — a future maintainer reading `count = var.idps_enabled ? 1 : 0` immediately understands why some resources are gated. Same pattern shape (manual paste between TF passes) as MYT-29 / MYT-35; no new operational primitive.

### Wiring as env vars, not secrets

Pool ID, App Client ID, Hosted UI domain, and issuer URL are all public values — they appear in OAuth-flow URLs and JWT headers. They're config, not secrets, and ride on the existing `extra_env` knob (added to `module "serving"` in MYT-35).

---

## 3. Module Surface

### File layout

Mirrors `infra/modules/serving/`:

```
infra/modules/auth/
  main.tf       # User Pool, App Client, Hosted UI domain, IdPs, secret shells
  variables.tf  # environment, idps_enabled, callback_urls, logout_urls
  outputs.tf    # user_pool_id, app_client_id, hosted_ui_domain, issuer_url
```

### Inputs

| Variable | Type | Default | Purpose |
|----------|------|---------|---------|
| `environment` | string | (required) | E.g. `"staging"`. Used in resource names (`mythrun-staging-users`, `mythrun-staging-web`) and the Hosted UI domain prefix. |
| `idps_enabled` | bool | `false` | Gates the two `aws_cognito_identity_provider` resources via `count`. Apply 1 keeps it false; flip to `true` for apply 2 after secrets are populated. |
| `callback_urls` | list(string) | (required) | OAuth callback allowlist. For staging, `["http://localhost:5173/auth/callback"]`. When the staging frontend ships, the composition appends its URL. |
| `logout_urls` | list(string) | (required) | OAuth logout-redirect allowlist. For staging, `["http://localhost:5173"]`. |

### Outputs

| Output | Value | Consumed by |
|--------|-------|-------------|
| `user_pool_id` | `aws_cognito_user_pool.main.id` | Backend env var `COGNITO_USER_POOL_ID`; `aws cognito-idp` CLI commands. |
| `app_client_id` | `aws_cognito_user_pool_client.main.id` | Backend env var `COGNITO_APP_CLIENT_ID`; OAuth flow URLs. |
| `hosted_ui_domain` | `"${aws_cognito_user_pool_domain.main.domain}.auth.${data.aws_region.current.name}.amazoncognito.com"` | Backend env var `COGNITO_HOSTED_UI_DOMAIN`; constructs `/oauth2/*` paths. The fully-qualified host is built in `outputs.tf` using the `aws_region` data source so the module is provider-region-portable. |
| `issuer_url` | `"https://cognito-idp.${data.aws_region.current.name}.amazonaws.com/${aws_cognito_user_pool.main.id}"` | Backend env var `COGNITO_ISSUER_URL`. JWT middleware (MYT-37) verifies the `iss` claim against this exact string, and derives the JWKS URL as `${issuer_url}/.well-known/jwks.json`. Constructed here from `data.aws_region.current.name` so a future prod composition in a different region (or a migration) doesn't silently produce a wrong URL. |

### No external dependencies

This module does not depend on `dns`, `network`, `data`, or `serving`. Composition reads its outputs into `module "serving"` via `extra_env`.

---

## 4. User Pool & App Client Resources

### `aws_cognito_user_pool.main`

```hcl
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
  # the pool destroys every user record and invalidates every JWT. Disable
  # this only for an intentional teardown, then re-enable.
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

### `aws_cognito_user_pool_client.main`

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
  # refresh token, only the REFRESH_TOKEN_AUTH flow is needed for renewal.
  # Set explicitly so a Cognito provider upgrade can't silently re-introduce
  # ALLOW_USER_PASSWORD_AUTH and defeat the federated-only intent.
  explicit_auth_flows = ["ALLOW_REFRESH_TOKEN_AUTH"]

  callback_urls = var.callback_urls
  logout_urls   = var.logout_urls

  # Apply 1: ["COGNITO"] (Cognito rejects an empty list).
  # Apply 2: ["Google", "Discord"] after IdPs are created. The `depends_on`
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
  # token and invalidates the previous one. `enable_token_revocation` is a
  # *different* feature (logout-side revocation, spec §6.4); both are needed.
  refresh_token_rotation {
    feature = "ENABLED"
  }

  enable_token_revocation       = true
  prevent_user_existence_errors = "ENABLED"
}
```

### Three non-obvious choices worth flagging

1. **`supported_identity_providers` flips between applies, gated by `depends_on`.** Cognito won't accept an empty list and won't accept a list referencing IdPs that don't exist on the pool. Apply 1 sets `["COGNITO"]` (a built-in placeholder); apply 2 sets `["Google", "Discord"]`. The App Client is updated in-place across the flip — no recreate, no token invalidation. The explicit `depends_on` on both IdP resources is what guarantees TF runs the IdP create before the App Client update; without it, parallel planning produces a "provider does not exist" failure mid-apply.

2. **`refresh_token_rotation { feature = "ENABLED" }` is the parent §6.3 requirement.** Easy to confuse with `enable_token_revocation` (which handles logout, parent §6.4). Both are set; both are needed. Rotation invalidates a refresh token on first use and issues a new one — limits the damage window if a refresh token is somehow exfiltrated.

3. **`prevent_user_existence_errors = "ENABLED"`.** Without this, certain Cognito error responses leak whether an email is registered (via response-shape differences). Standard hardening; free; not flagged in the parent spec but worth keeping.

---

## 5. Hosted UI Domain & IdP Resources

### `aws_cognito_user_pool_domain.main`

```hcl
resource "aws_cognito_user_pool_domain" "main" {
  domain       = "mythrun-${var.environment}"
  user_pool_id = aws_cognito_user_pool.main.id
}
```

That single resource produces `mythrun-staging.auth.us-east-1.amazoncognito.com`. AWS owns the cert and the CloudFront distribution behind it; nothing else is required.

### Secret shells (apply 1)

```hcl
resource "aws_secretsmanager_secret" "google_oauth" {
  name                    = "mythrun/${var.environment}/google-oauth"
  description             = "Google OAuth client_id + client_secret JSON for Cognito IdP"
  recovery_window_in_days = 7
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
  recovery_window_in_days = 7
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

The PLACEHOLDER contents are valid JSON so `jsondecode()` doesn't error during apply 2 if a human pastes the wrong shape — a malformed secret surfaces as Cognito's "invalid OAuth credentials" at sign-in time, not at TF plan time.

### IdP resources (apply 2, gated)

```hcl
data "aws_secretsmanager_secret_version" "google_oauth" {
  count     = var.idps_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.google_oauth.id
}

data "aws_secretsmanager_secret_version" "discord_oauth" {
  count     = var.idps_enabled ? 1 : 0
  secret_id = aws_secretsmanager_secret.discord_oauth.id
}

locals {
  google_oauth = var.idps_enabled ? jsondecode(data.aws_secretsmanager_secret_version.google_oauth[0].secret_string) : null
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
    username = "sub"  # Cognito requires "username" mapping; Google's sub is stable + unique.
  }

  # Reserved as a forward-compat anchor: if Cognito's URL normalization
  # produces drift on a specific provider_details key in the future, list
  # it here. Empty means "the AWS provider's default behavior" — present so
  # operators don't have to reinvent the block under load.
  lifecycle {
    ignore_changes = []
  }
}

# Discord is configured as a generic OIDC provider, NOT via the legacy
# /api/users/@me OAuth-only path that the parent Auth & Users spec §2.4
# originally cited. Discord publishes a working OIDC discovery document at
# https://discord.com/.well-known/openid-configuration and a spec-compliant
# userinfo endpoint at https://discord.com/api/oauth2/userinfo. Using OIDC
# means Cognito mints an id_token from Discord's claims and the attribute
# mapping references OIDC standard names (sub, preferred_username, email,
# picture), not Discord's native field names (id, username, avatar).
#
# Scope rules are non-obvious: `openid` gates the userinfo endpoint and
# returns `sub`; `identify` is required to get `preferred_username` and
# `picture`; `email` adds `email` and `email_verified`. All three are
# needed for the attribute mapping below to populate. Dropping `identify`
# leaves `name` and `picture` empty — and parent §4 onboarding reads
# `display_name` from `name`, so dropping it breaks user creation.
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
    # pinning them removes a runtime dependency on Discord's discovery
    # doc availability and makes the contract auditable from the TF.
    authorize_url  = "https://discord.com/api/oauth2/authorize"
    token_url      = "https://discord.com/api/oauth2/token"
    attributes_url = "https://discord.com/api/oauth2/userinfo"
    jwks_uri       = "https://discord.com/api/oauth2/keys"
  }

  attribute_mapping = {
    email    = "email"
    name     = "preferred_username"  # Discord's chosen display name (OIDC claim).
    picture  = "picture"             # Discord's OIDC userinfo returns a CDN URL directly.
    username = "sub"                 # Stable Discord user id (snowflake) exposed as OIDC sub.
  }

  lifecycle {
    ignore_changes = []
  }
}
```

### Four things worth flagging

1. **Parent spec §2.4 had it wrong.** The original Auth & Users spec cited Discord's legacy `/api/users/@me` endpoint and `identify, email` scopes — that path predates Discord's OIDC support and isn't compatible with `provider_type = "OIDC"` in Cognito. The parent spec is being updated alongside this design (see commit history for `docs/specs/2026-04-13-auth-users.md`). Future readers: the OIDC-native config above is correct; if you find the legacy endpoint in any other doc, that doc is stale.

2. **`username` mapping is internal to Cognito.** Cognito's User Pool requires that *some* IdP attribute map to its internal `username` (the unique key inside the pool). For both providers we use the OAuth `sub` (stable, never reused, OIDC standard). This is invisible to application code — we still key on Cognito's own `sub` claim, which is generated by Cognito and unrelated to either provider's IDs. **Do not confuse this with the Mythrun `users.username` we manage in our DB** (chosen by the user during onboarding in MYT-38).

3. **Discord's `picture` is now a real URL.** Earlier this design assumed we'd lose Discord avatars because the legacy API returned an avatar hash. The OIDC `userinfo` endpoint returns a fully-qualified CDN URL in the `picture` claim, so the attribute mapping populates `users.avatar_url` cleanly for Discord users — same as Google.

4. **Secret rotation is clean.** When Discord (or Google) forces a client-secret rotation later, the operator pastes new JSON into the Secrets Manager entry and runs `terraform apply`. The data source re-reads, the IdP gets updated in-place, no resource recreate, zero downtime. **Important caveat**: `data.aws_secretsmanager_secret_version` reads during the *refresh* phase, before resources reconcile. If you paste a new value between `terraform plan` and `terraform apply`, the apply uses the stale value from the plan's refresh. Always re-run `plan` after pasting.

---

## 6. Staging Composition Wiring

### New module instantiation

`infra/environments/staging/main.tf` adds:

```hcl
module "auth" {
  source = "../../modules/auth"

  environment = var.environment

  # Apply 1: idps_enabled = false (creates Pool, App Client, Hosted UI, secret shells).
  # Apply 2: flip cognito_idps_enabled = true in terraform.tfvars after secrets are pasted.
  idps_enabled = var.cognito_idps_enabled

  callback_urls = ["http://localhost:5173/auth/callback"]
  logout_urls   = ["http://localhost:5173"]
}
```

### New variable

`infra/environments/staging/variables.tf` adds:

```hcl
variable "cognito_idps_enabled" {
  description = "Set to true on apply 2 of MYT-36 (after Google + Discord OAuth secrets are pasted into Secrets Manager)."
  type        = bool
  default     = false
}
```

`terraform.tfvars` flips this from `false` (apply 1) to `true` (apply 2). The variable is per-env because each environment manages its own two-pass apply timeline.

### Wiring into `module "serving"`

Extending the existing `extra_env` block established in MYT-35:

```hcl
extra_env = [
  { name = "BOOT_GATE_ENABLED",        value = "1" },                                # MYT-35
  { name = "COGNITO_USER_POOL_ID",     value = module.auth.user_pool_id },
  { name = "COGNITO_APP_CLIENT_ID",    value = module.auth.app_client_id },
  { name = "COGNITO_HOSTED_UI_DOMAIN", value = module.auth.hosted_ui_domain },
  { name = "COGNITO_ISSUER_URL",       value = module.auth.issuer_url },
]
```

Three explicit notes:

1. **These are env vars, not secrets.** A user pool ID, app client ID, hosted UI domain, and issuer URL all appear in OAuth flow URLs and JWT headers anyway. `extra_env` is correct (matches the Linear ticket's "NOT secrets — these are config" line).

2. **TF/CI task-def split applies but is deferred.** Per the rule from MYT-35 (`reference_tf_ci_taskdef_split.md`): when TF registers a new task-def revision with these env vars, the live ECS service does NOT roll automatically — `:placeholder` image pinning means a force-rollover onto the TF rev would fail with `CannotPullContainerError`. CI's render-task-def step is what swaps in the real image. **For MYT-36 we do not roll the service** because the backend doesn't yet consume any of these env vars (JWT middleware lives in MYT-37). The first deploy that consumes them happens at the start of MYT-37.

3. **`cognito-client-secret` shell is removed in this ticket** (corrected from earlier draft). MYT-25 created `mythrun/staging/cognito-client-secret` speculatively *and* `infra/modules/serving/main.tf:150` already wires it as a `COGNITO_CLIENT_SECRET` env var on the API container. Leaving the shell untouched would mean MYT-37's first deploy injects the literal string `"PLACEHOLDER — set via AWS Console / CLI"` as `COGNITO_CLIENT_SECRET` — a real footgun. Two changes ride with MYT-36:
   - `infra/modules/serving/main.tf` — remove the `{ name = "COGNITO_CLIENT_SECRET", valueFrom = ... }` line from `common_secrets`.
   - `infra/environments/staging/main.tf` — remove `"cognito-client-secret"` from `manual_secret_names`. The secret resource itself gets destroyed on apply; the 7-day recovery window absorbs any "wait, do we need it?" reversal.

---

## 7. Deploy Sequence

Three phases. **No CI run in any of them.** No ECS roll.

### Phase A — TF apply 1 (creates infra without IdPs)

1. `cd infra/environments/staging`
2. Confirm `terraform.tfvars` has `cognito_idps_enabled = false` (or unset; default is false).
3. `terraform plan` — should show: 1 user pool, 1 app client, 1 user pool domain, 2 secrets, 2 secret versions (PLACEHOLDER), 0 IdPs. Plus the addition of 4 env vars on the API task definition.
4. `terraform apply`.
5. Capture outputs: `terraform output` — record `user_pool_id`, `app_client_id`, `hosted_ui_domain`. They'll be needed in human-action.

### Phase B — Human action (register OAuth apps + paste secrets)

See [Section 8](#8-human-action-runbook) for the full runbook.

### Phase C — TF apply 2 (creates IdPs)

1. Edit `infra/environments/staging/terraform.tfvars`: set `cognito_idps_enabled = true`.
2. `terraform plan` — should show: 2 IdPs to create, 1 app client `supported_identity_providers` update (`["COGNITO"]` → `["Google", "Discord"]`). No other changes.
3. `terraform apply`.
4. Click-through verification (Section 9). If it fails, see Section 10.

### Why no CI run

The `extra_env` additions DO produce a new task-def revision (because the env-var list changed). But the running ECS task continues serving on the previous CI-deployed revision. MYT-37's first deploy is what rolls the service onto a CI-rendered task-def with the real ECR image + the new env vars + the JWT middleware code that consumes them — all in one swap.

A premature CI run during MYT-36 would also work (CI would render the current backend code onto the new env vars, no behavior change because no code reads them yet) but it's pointless work.

---

## 8. Human-Action Runbook

### Sequence 1 — Google OAuth app registration (~10 min)

1. **Console:** Go to [console.cloud.google.com](https://console.cloud.google.com) → APIs & Services → OAuth consent screen.
2. **Configure consent screen** (one-time per Google Cloud project — skip if `mythrun.com` is already verified):
   - User Type = **External**
   - App name = "Mythrun (staging)"
   - User support email + Developer contact = `dev@mythrun.com`
   - Authorized domains = `mythrun.com`
   - Scopes: `openid`, `.../auth/userinfo.email`, `.../auth/userinfo.profile` (non-sensitive defaults; no Google verification queue required).
3. **Create OAuth 2.0 Client ID:** APIs & Services → Credentials → Create Credentials → OAuth client ID.
   - Application type = **Web application**
   - Name = "Mythrun staging"
   - Authorized JavaScript origins = `https://mythrun-staging.auth.us-east-1.amazoncognito.com`
   - **Authorized redirect URI** = `https://mythrun-staging.auth.us-east-1.amazoncognito.com/oauth2/idpresponse` (Cognito's IdP-response endpoint, **not** our app's callback URL)
4. Copy the resulting `client_id` and `client_secret`. Paste into Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id mythrun/staging/google-oauth \
     --secret-string '{"client_id":"<paste>","client_secret":"<paste>"}'
   ```

### Sequence 2 — Discord OAuth app registration (~10 min)

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application** → name "Mythrun (staging)".
2. **OAuth2** tab → Redirects → add `https://mythrun-staging.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`.
3. **OAuth2** → General → copy `Client ID` and click **Reset Secret** to generate a fresh `client_secret` (the auto-generated one shown on app creation is sometimes already partially-revealed in URL bars).
4. Paste into Secrets Manager:
   ```bash
   aws secretsmanager put-secret-value \
     --secret-id mythrun/staging/discord-oauth \
     --secret-string '{"client_id":"<paste>","client_secret":"<paste>"}'
   ```

### Four flags

1. **The Google OAuth consent screen is per-Google-Cloud-project, not per-OAuth-client.** If `mythrun.com` is already verified in this project, you skip step 2 of Sequence 1.
2. **No Google verification queue.** The `email` and `profile` scopes don't trigger Google's manual app-verification process (which can take weeks). If we ever add Google sensitive scopes (Calendar, Drive), that's a different process — not relevant now.
3. **Discord's redirect URI is the same string as Google's.** Both providers redirect to Cognito's idpresponse endpoint, then Cognito redirects to our app's `callback_urls`. Common source of confusion. Discord's portal accepts multiple redirect URIs — set the Cognito idpresponse URL as the **only** one for the staging app, so a future operator can't introduce a second redirect that bypasses Cognito.
4. **After pasting secrets, re-run `terraform plan` before `terraform apply`.** `data.aws_secretsmanager_secret_version` reads during refresh; if you skip from paste → apply 2 directly, you may get the stale PLACEHOLDER value. The plan output will show the secret values being read; if it's still PLACEHOLDER, the paste didn't land or the data source needs a fresh refresh (`terraform plan` triggers it).

---

## 9. Testing & Verification

No automated test suite. Cognito + IdP wiring isn't unit-testable — we're configuring a managed service, not writing logic. Verification happens at three layers:

### Layer 1 — `terraform plan` is the build

A second `terraform apply` immediately after a successful one **must show "No changes"**. This catches drift between TF resource definitions and what AWS actually persisted (a real concern with the IdP `provider_details` map, where Cognito occasionally normalizes URL trailing slashes and similar). Add this step to the runbook after each apply.

### Layer 2 — Click-through covers the OAuth handshake end-to-end

Open this URL in a browser, replacing `<APP_CLIENT_ID>` with `terraform output -raw app_client_id`:

```
https://mythrun-staging.auth.us-east-1.amazoncognito.com/login?response_type=code&client_id=<APP_CLIENT_ID>&redirect_uri=http://localhost:5173/auth/callback&scope=openid+email+profile&identity_provider=Google
```

Expected flow:

1. Browser hits Cognito's `/login` endpoint.
2. Cognito redirects to Google (because `identity_provider=Google`).
3. User signs in with a Google account.
4. Google redirects back to Cognito's `/oauth2/idpresponse`.
5. Cognito mints an authorization code, redirects to `http://localhost:5173/auth/callback?code=...`.
6. Browser lands at `localhost:5173/auth/callback?code=<auth-code>`. The page won't render — there's no frontend yet — but the URL bar's `code=...` is the signal of success.

Repeat with `identity_provider=Discord`.

### Layer 3 — `aws cognito-idp list-users` is the data-layer test

```bash
aws cognito-idp list-users --user-pool-id $(terraform output -raw user_pool_id)
```

Expected: 2 user records (one per IdP click-through), each with populated `email` and `name` attributes. Google's record additionally has `picture`. If a record exists but attributes are empty, the IdP attribute mapping is wrong — see Section 10.

### Why no Terraform test framework

We don't currently wire `tflint`, `terraform-compliance`, or `terratest` for `infra/`. Adding any of those is its own initiative; this module benefits along with the rest of `infra/` when it lands. Out-of-scope for MYT-36.

---

## 10. Error Handling & Recovery

| Failure | Symptom | Recovery |
|---------|---------|----------|
| OAuth `client_id` wrong in Secrets Manager | Hosted UI redirects to provider; provider returns "client not found" or "invalid client_id" | Re-paste correct value via `aws secretsmanager put-secret-value`, run `terraform apply` to refresh IdP. No resource recreate. |
| OAuth `client_secret` wrong | Hosted UI handshake completes at provider; Cognito's idpresponse fails with "invalid_client"; user lands at Cognito error page | Same — re-paste, re-apply. |
| Discord redirect URI mismatch | "Invalid OAuth2 redirect_uri" error from Discord before user even sees consent screen | Update Discord Developer Portal's Redirects field to match Cognito's idpresponse URL exactly. No TF change. |
| Google consent screen not configured | "Error 400: redirect_uri_mismatch" or consent screen blocked | Configure consent screen in Google Cloud Console (Sequence 1 step 2). |
| `idps_enabled=true` applied before secrets pasted | TF apply succeeds; IdPs get created with PLACEHOLDER values; click-through fails at provider with "invalid_client" | Paste real values into Secrets Manager, `terraform apply` again. The IdP resources update in-place; no recreate. |
| Drift on `provider_details` after Cognito-side normalization | `terraform plan` shows changes on every run, can't reach "no changes" | Add the specific normalized field to `lifecycle.ignore_changes` on the IdP resource. The auth module's IdP resource blocks reserve a `lifecycle.ignore_changes = []` we can extend if drift surfaces. |
| User exists in pool but `email` attribute is empty | IdP attribute mapping references a claim the provider doesn't return | Check the provider's userinfo response shape (Sequence 3 of runbook can dump it via `aws cognito-idp admin-get-user`). Update the `attribute_mapping` block in TF, re-apply. |
| Discord users have empty `name` or `picture` | Discord's OIDC userinfo only returns `preferred_username` and `picture` when the `identify` scope is granted | Verify `authorize_scopes = "openid identify email"` in the Discord IdP block — all three scopes are required. Re-apply if changed. |
| `aws_cognito_user_pool_domain` apply fails with "Domain already associated with another user pool" | The Hosted UI domain prefix `mythrun-{env}` is globally unique within the AWS region across all accounts; another tenant has claimed it | Pick a new prefix in `infra/modules/auth/main.tf` (e.g. add a short suffix). Update the prefix everywhere downstream: Google + Discord developer-portal redirect URIs (`https://<new-prefix>.auth.us-east-1.amazoncognito.com/oauth2/idpresponse`), the click-through verification URL, and any wiki references. The TF outputs auto-pick up the new value. |
| Apply 1 succeeds, apply 2 hasn't been run yet | Normal stable state — secret shells exist with PLACEHOLDER, no IdPs, App Client lists `["COGNITO"]` only | Not a failure. Continue to the human-action steps. The system is fine to leave in this state indefinitely. |

### What WON'T break the staging environment

- Apply 2 with PLACEHOLDER secrets still in place: succeeds at the TF layer, fails at sign-in time. Doesn't corrupt anything; just paste real values and re-apply.
- Re-applying after a successful apply: idempotent. No-op.
- Rotating the OAuth client secret on the provider side: re-paste into Secrets Manager, re-apply. No downtime, no token invalidation.
- Deleting and recreating the User Pool: would invalidate any existing JWTs, but we have no users in MYT-36. Safe destructive action in staging.

---

## 11. Out of Scope

| Item | Deferred to |
|------|-------------|
| JWT verification middleware | MYT-37 |
| `/api/auth/refresh` endpoint | MYT-37 |
| First ECS roll consuming these env vars | MYT-37 |
| `/api/users/register` endpoint | MYT-38 |
| `/api/users/me` (first-login detection) | MYT-38 |
| Username selection UX | MYT-38 |
| Invite system | MYT-38 |
| WebSocket ticket exchange | MYT-39 |
| Suspended-user enforcement (`suspended_at` check) | MYT-39 |
| Custom Hosted UI styling (CSS) | Frontend ticket — Cognito supports it, not needed for staging click-through |
| Production User Pool composition (`infra/environments/production/`) | New ticket once we're ready to compose prod |
| Custom domain `auth.mythrun.com` | Production-only; not needed for staging |
| Recovery email | Post-launch follow-up if account-loss complaints surface |
| Multiple linked OAuth providers per account | Post-launch follow-up |
| CloudWatch alarms on Cognito sign-in throttles, IdP availability, secret age | `myth-cognito-monitoring` follow-up bead — not load-bearing for staging click-through; required before prod composition |
| Nightly user-record export to S3 (DR for User Pool corruption/deletion) | `myth-cognito-user-export` follow-up bead — Cognito has no native PITR or cross-region replication; staging has no users to export today, but prod needs this before launch |

---

## 12. Follow-up Beads

To file after the design lands (don't block MYT-36 closure on these):

- **`myth-prod-auth-compose`** — Compose the auth module in `infra/environments/production/main.tf` once production composition is ready. Includes the custom `auth.mythrun.com` Hosted UI domain via `var.custom_domain`, a separate set of OAuth client_secrets for prod (Google and Discord both require distinct OAuth clients per env to keep redirect URIs separate), and prod callback URLs once the prod frontend domain is decided.

- **`myth-cognito-monitoring`** — Wire CloudWatch alarms on Cognito metrics (`SignInSuccesses` rate-of-change, `SignInThrottles > 0`, `FederationThrottles > 0`) and Secrets Manager secret-age alarms on the two OAuth secrets (alert at 150 days, hard at 180). Compose the alarm targets onto the existing `aws_sns_topic.alerts` topic that staging already provisions. Required before prod composition; staging click-through verification works without it.

- **`myth-cognito-user-export`** — Nightly Lambda or scheduled task that runs `aws cognito-idp list-users` and writes the result to an S3 prefix with 90-day retention. The recovery procedure is documented but presumes export data exists; this bead produces the data. Cognito has no native PITR or cross-region replication, so a corrupted/deleted User Pool is recoverable only to user-record granularity from these exports. Staging has no users today; prod needs this active before users are onboarded.

- **`myth-recovery-email`** — Add a post-signup recovery-email flow (magic-link reset) if real users surface OAuth-account-loss complaints.

- **Parent spec correction** (no bead — done inline with this design): `docs/specs/2026-04-13-auth-users.md` §2.4 is updated to reflect the OIDC-native Discord configuration (the legacy `/api/users/@me` + `identify, email` configuration cited there is incompatible with `provider_type = "OIDC"`).
