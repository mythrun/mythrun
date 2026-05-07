#!/usr/bin/env bash
# backend/scripts/smoke/staging.sh
#
# End-to-end smoke against the deployed staging API. Authenticates as the
# Cognito test user (provisioned by infra/modules/auth/smoke-test.tf) and
# exercises three classifyProfanity paths through GET /api/users/check-username:
#
#   1. Clean username   → 200 { available: true }
#   2. Offensive name   → 200 { available: false, reason: 'offensive' }
#   3. Impersonation    → 200 { available: false, reason: 'impersonation' }
#
# Each call fires a Haiku request server-side (visible in CloudWatch as
# event:'llm.call'). Token cost is ~$0.0003 per full smoke run.
#
# Run from repo root: `pnpm smoke:staging`
# Or directly: `./backend/scripts/smoke/staging.sh`
#
# Environment: AWS credentials must be configured for an IAM role with
# read access to:
#   - secretsmanager:GetSecretValue on mythrun/staging/smoke-test-credentials
#   - cognito-idp:InitiateAuth + RespondToAuthChallenge (no special perms; the
#     User Pool client is public — anyone with the credentials and client ID
#     can authenticate)

set -euo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
REGION="${AWS_REGION:-us-east-1}"
USER_POOL_ID="${COGNITO_USER_POOL_ID:-us-east-1_5gDAtYzjV}"
CLIENT_ID="${COGNITO_CLIENT_ID:-l7u6cnoev0cv9d5vei76ko5tj}"
SECRET_ID="${SMOKE_CREDS_SECRET_ID:-mythrun/staging/smoke-test-credentials}"
API_BASE="${API_BASE:-https://staging-api.mythrun.com}"

OFFENSIVE_USERNAME="${OFFENSIVE_USERNAME:-fucknugget}"
IMPERSONATION_USERNAME="${IMPERSONATION_USERNAME:-mythrun_admin}"
CLEAN_USERNAME="${CLEAN_USERNAME:-gandalf$$}" # $$ avoids `taken` collision across runs

# ─── ANSI ────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()    { printf "${GREEN}✓${NC} %s\n" "$1"; }
fail()  { printf "${RED}✗${NC} %s\n" "$1" >&2; exit 1; }
info()  { printf "${YELLOW}→${NC} %s\n" "$1"; }

# ─── Step 1: Read credentials from Secrets Manager ───────────────────────────
info "Reading smoke-test credentials from Secrets Manager"

CREDS=$(aws secretsmanager get-secret-value \
  --secret-id "$SECRET_ID" \
  --region "$REGION" \
  --query SecretString \
  --output text)

USERNAME=$(echo "$CREDS" | jq -r '.username')
PASSWORD=$(echo "$CREDS" | jq -r '.password')

if [[ -z "$USERNAME" || -z "$PASSWORD" ]]; then
  fail "Could not parse username/password from secret $SECRET_ID"
fi
ok "Credentials loaded for $USERNAME"

# ─── Step 2: Authenticate via USER_AUTH flow ─────────────────────────────────
# USER_AUTH flow with PREFERRED_CHALLENGE=PASSWORD plus the password inline
# returns AuthenticationResult directly, no challenge round-trip required.
info "Initiating Cognito auth (USER_AUTH flow, PASSWORD challenge inline)"

INIT_RESP=$(aws cognito-idp initiate-auth \
  --client-id "$CLIENT_ID" \
  --auth-flow USER_AUTH \
  --auth-parameters "USERNAME=$USERNAME,PASSWORD=$PASSWORD,PREFERRED_CHALLENGE=PASSWORD" \
  --region "$REGION")

ACCESS_TOKEN=$(echo "$INIT_RESP" | jq -r '.AuthenticationResult.AccessToken')

if [[ -z "$ACCESS_TOKEN" || "$ACCESS_TOKEN" == "null" ]]; then
  fail "Auth response did not return AccessToken"
fi
ok "Authenticated; got AccessToken (${#ACCESS_TOKEN} chars)"

# Backend's JWT plugin verifies tokenUse=access (per backend/src/auth/jwt-plugin.ts).
AUTH_HEADER="Authorization: Bearer $ACCESS_TOKEN"

# ─── Step 3: Health check ────────────────────────────────────────────────────
info "GET $API_BASE/health/ready"
HEALTH_STATUS=$(curl -sS -o /dev/null -w "%{http_code}" "$API_BASE/health/ready")
[[ "$HEALTH_STATUS" == "200" ]] || fail "/health/ready returned $HEALTH_STATUS"
ok "/health/ready returned 200"

# ─── Step 4: Idempotent registration ─────────────────────────────────────────
# First run: creates the users row. Subsequent runs: returns 200 idempotent.
# Either way: classifyProfanity fires on the username.
REGISTER_USERNAME="smoketester$$"
REGISTER_DISPLAY="Smoke Tester"

info "POST $API_BASE/api/users/register (username: $REGISTER_USERNAME)"
REG_TMP=$(mktemp)
REG_STATUS=$(curl -sS -o "$REG_TMP" -w "%{http_code}" -X POST "$API_BASE/api/users/register" \
  -H "$AUTH_HEADER" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$REGISTER_USERNAME\",\"displayName\":\"$REGISTER_DISPLAY\"}")
REG_BODY=$(cat "$REG_TMP")
rm -f "$REG_TMP"

if [[ "$REG_STATUS" =~ ^(200|201)$ ]]; then
  ok "Registration succeeded ($REG_STATUS) — idempotent path"
elif [[ "$REG_STATUS" == "409" ]]; then
  ok "Registration returned 409 (already-onboarded) — idempotent path"
else
  fail "Registration returned $REG_STATUS: $REG_BODY"
fi

# ─── Step 5: classifyProfanity smoke — clean username ────────────────────────
info "GET /api/users/check-username?username=$CLEAN_USERNAME (clean)"
CLEAN_RESP=$(curl -sS "$API_BASE/api/users/check-username?username=$CLEAN_USERNAME" \
  -H "$AUTH_HEADER")
CLEAN_AVAILABLE=$(echo "$CLEAN_RESP" | jq -r '.available')
[[ "$CLEAN_AVAILABLE" == "true" ]] || fail "Clean username returned available=$CLEAN_AVAILABLE; body: $CLEAN_RESP"
ok "Clean username → available: true (Haiku classified non-profane)"

# ─── Step 6: classifyProfanity smoke — offensive ─────────────────────────────
info "GET /api/users/check-username?username=$OFFENSIVE_USERNAME (offensive)"
OFFENSIVE_RESP=$(curl -sS "$API_BASE/api/users/check-username?username=$OFFENSIVE_USERNAME" \
  -H "$AUTH_HEADER")
OFFENSIVE_AVAILABLE=$(echo "$OFFENSIVE_RESP" | jq -r '.available')
OFFENSIVE_REASON=$(echo "$OFFENSIVE_RESP" | jq -r '.reason')

if [[ "$OFFENSIVE_AVAILABLE" != "false" ]]; then
  fail "Offensive username '$OFFENSIVE_USERNAME' returned available=$OFFENSIVE_AVAILABLE; body: $OFFENSIVE_RESP"
fi
if [[ "$OFFENSIVE_REASON" != "offensive" ]]; then
  fail "Offensive username '$OFFENSIVE_USERNAME' returned reason=$OFFENSIVE_REASON, expected 'offensive'; body: $OFFENSIVE_RESP"
fi
ok "Offensive username → available: false, reason: offensive"

# ─── Step 7: classifyProfanity smoke — impersonation ─────────────────────────
info "GET /api/users/check-username?username=$IMPERSONATION_USERNAME (impersonation)"
IMPERSONATION_RESP=$(curl -sS "$API_BASE/api/users/check-username?username=$IMPERSONATION_USERNAME" \
  -H "$AUTH_HEADER")
IMPERSONATION_AVAILABLE=$(echo "$IMPERSONATION_RESP" | jq -r '.available')
IMPERSONATION_REASON=$(echo "$IMPERSONATION_RESP" | jq -r '.reason')

if [[ "$IMPERSONATION_AVAILABLE" != "false" ]]; then
  fail "Impersonation username '$IMPERSONATION_USERNAME' returned available=$IMPERSONATION_AVAILABLE; body: $IMPERSONATION_RESP"
fi
if [[ "$IMPERSONATION_REASON" != "impersonation" ]]; then
  fail "Impersonation username '$IMPERSONATION_USERNAME' returned reason=$IMPERSONATION_REASON, expected 'impersonation'; body: $IMPERSONATION_RESP"
fi
ok "Impersonation username → available: false, reason: impersonation"

# ─── Done ────────────────────────────────────────────────────────────────────
printf "\n${GREEN}Smoke passed.${NC} 4 Haiku calls fired (cost ≈ \$0.0004).\n"
printf "Watch CloudWatch /mythrun/staging/api for event:'llm.call' lines.\n"
