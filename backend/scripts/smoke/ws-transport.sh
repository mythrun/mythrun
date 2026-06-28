#!/usr/bin/env bash
# backend/scripts/smoke/ws-transport.sh
#
# MYT-85 — reusable real-wire WS transport smoke against deployed staging. Auths as
# the Cognito smoke owner (same creds as staging.sh), then runs ws-transport.ts,
# which validates the CloudFront /ws/* upgrade + first-frame contract + idle-survival.
#
# Run:  SMOKE_CAMPAIGN_ID=<active-campaign-id> bash backend/scripts/smoke/ws-transport.sh
#
# Requires AWS creds with read on the smoke-owner secret + cognito-idp:InitiateAuth,
# and a persistent ACTIVE session for SMOKE_CAMPAIGN_ID (one-time setup; the smoke
# never ends the session, so a single active session is reusable indefinitely).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
CLIENT_ID="${COGNITO_CLIENT_ID:-l7u6cnoev0cv9d5vei76ko5tj}"
SECRET_ID="${SMOKE_CREDS_SECRET_ID:-mythrun/staging/smoke-test-owner-credentials}"
# Defaults to the persistent MYT-85 staging smoke campaign (one active session,
# reused indefinitely — the smoke never ends it). Override with SMOKE_CAMPAIGN_ID.
CAMPAIGN_ID="${SMOKE_CAMPAIGN_ID:-019f105e-a778-7309-9159-05a549144e37}"

CREDS=$(aws secretsmanager get-secret-value --secret-id "$SECRET_ID" --region "$REGION" --query SecretString --output text)
TOKEN=$(aws cognito-idp initiate-auth --client-id "$CLIENT_ID" --auth-flow USER_AUTH \
  --auth-parameters "USERNAME=$(echo "$CREDS" | jq -r '.username'),PASSWORD=$(echo "$CREDS" | jq -r '.password'),PREFERRED_CHALLENGE=PASSWORD" \
  --region "$REGION" --query 'AuthenticationResult.AccessToken' --output text)

echo "→ authed; WS smoke vs ${SMOKE_FRONTEND_BASE:-https://staging.mythrun.com} (campaign $CAMPAIGN_ID)"
cd "$(dirname "$0")/../.."
SMOKE_ACCESS_TOKEN="$TOKEN" SMOKE_CAMPAIGN_ID="$CAMPAIGN_ID" pnpm exec tsx scripts/smoke/ws-transport.ts
