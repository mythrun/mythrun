#!/usr/bin/env bash
# Create per-env databases + app users inside the shared RDS instance, and
# write the generated password to mythrun/{env}/rds-password.
#
# MUST run from within the VPC (ECS run-task or SSM Session Manager tunnel) —
# RDS is not publicly accessible.
#
# Usage:
#   bootstrap-databases.sh --env staging [--verify | --user-only | --secret-only | --reset-password]
#
# Modes:
#   (default)         Create database + user + password secret. Idempotent.
#   --verify          Check current state without mutating. Prints one of:
#                     OK / DB_ONLY / SECRET_MISSING / MISSING
#   --user-only       DB exists but user doesn't: create user + password + secret.
#   --secret-only     DB + user exist but secret version missing or placeholder:
#                     ALTER USER password + write secret.
#   --reset-password  Alias of --secret-only: rotate password + write secret.
#                     Use when the stored secret is known-wrong (drift) rather
#                     than missing.
#
# Required env vars (injected via ECS task role):
#   AWS_REGION                us-east-1
#   RDS_MASTER_SECRET_ARN     ARN of the AWS-managed RDS master user secret
#                             (from shared workspace output: rds_master_user_secret_arn)

set -euo pipefail

# Scrub sensitive values from the environment on any exit path (including
# unexpected interpreter tracing via `set -x`). Capture $? first so the trap
# doesn't overwrite a non-zero abort code with unset's exit 0.
trap 'rc=$?; unset PGPASSWORD MASTER_PASS MASTER_JSON; exit $rc' EXIT

ENV=""
MODE="default"

set_mode() {
  if [[ "$MODE" != "default" ]]; then
    echo "ERROR: multiple mode flags specified (got --$1 after --$MODE)" >&2
    exit 2
  fi
  MODE="$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)            ENV="$2"; shift 2 ;;
    --verify)         set_mode "verify"; shift ;;
    --user-only)      set_mode "user-only"; shift ;;
    --secret-only)    set_mode "secret-only"; shift ;;
    --reset-password) set_mode "reset-password"; shift ;;
    *) echo "ERROR: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -z "$ENV" ]]; then
  echo "ERROR: --env required (staging or production)" >&2
  exit 2
fi

if [[ ! "$ENV" =~ ^(staging|production)$ ]]; then
  echo "ERROR: --env must be 'staging' or 'production', got '$ENV'" >&2
  exit 2
fi

: "${AWS_REGION:=us-east-1}"
if [[ -z "${RDS_MASTER_SECRET_ARN:-}" ]]; then
  echo "ERROR: RDS_MASTER_SECRET_ARN env var required" >&2
  exit 1
fi

DB_NAME="mythrun_${ENV}"
DB_USER="mythrun_${ENV}"
APP_SECRET_ID="mythrun/${ENV}/rds-password"

# Fetch master credentials from Secrets Manager
MASTER_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$RDS_MASTER_SECRET_ARN" --region "$AWS_REGION" \
  --query SecretString --output text)
MASTER_USER=$(echo "$MASTER_JSON" | jq -r .username)
MASTER_PASS=$(echo "$MASTER_JSON" | jq -r .password)
# Host + port: prefer env-supplied (RDS_HOST / RDS_PORT injected by the ECS
# task definition from terraform_remote_state shared outputs). Fall back to
# JSON fields for compatibility with hand-rolled secrets that include them.
# AWS-managed RDS master secrets only carry username + password, so the env
# path is the production path; the JSON fallback is for legacy fixtures.
RDS_HOST="${RDS_HOST:-$(echo "$MASTER_JSON" | jq -r .host)}"
RDS_PORT="${RDS_PORT:-$(echo "$MASTER_JSON" | jq -r .port)}"

# Guard against a malformed master secret (e.g. a manually edited version that
# dropped a field). jq emits the string "null" for missing keys.
for pair in "username:$MASTER_USER" "password:$MASTER_PASS" "host:$RDS_HOST" "port:$RDS_PORT"; do
  field="${pair%%:*}"
  value="${pair#*:}"
  if [[ -z "$value" || "$value" == "null" ]]; then
    echo "ERROR: RDS master secret missing '$field'" >&2
    exit 1
  fi
done

# Base psql command; connects to the 'postgres' maintenance DB.
export PGPASSWORD="$MASTER_PASS"
PSQL_MASTER=(psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
             --dbname=postgres --no-password --tuples-only --no-align)

# --- verify mode ---
# Propagates psql failures (no `|| true`) so a transient RDS blip aborts the
# script rather than misreporting state and triggering a destructive path.
# Idempotency of the CREATE branches depends on this: CREATE DATABASE and
# CREATE USER have no IF NOT EXISTS form in Postgres, so fail-fast is the
# only safe posture.
verify_state() {
  local db_exists user_exists secret_has_version

  db_exists=$("${PSQL_MASTER[@]}" -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME';" | tr -d '[:space:]')
  user_exists=$("${PSQL_MASTER[@]}" -c "SELECT 1 FROM pg_user WHERE usename = '$DB_USER';" | tr -d '[:space:]')
  # describe-secret: `|| echo ""` is intentional — "secret has no version yet"
  # is a legitimate state, not an error.
  secret_has_version=$(aws secretsmanager describe-secret --secret-id "$APP_SECRET_ID" \
    --region "$AWS_REGION" --query 'VersionIdsToStages' --output text 2>/dev/null || echo "")

  if [[ "$db_exists" == "1" && "$user_exists" == "1" && -n "$secret_has_version" ]]; then
    echo "OK"; return 0
  elif [[ "$db_exists" == "1" && "$user_exists" == "1" ]]; then
    echo "SECRET_MISSING"; return 0  # DB + user, but no secret version
  elif [[ "$db_exists" == "1" ]]; then
    echo "DB_ONLY"; return 0
  else
    echo "MISSING"; return 0
  fi
}

generate_password() {
  # Excludes /, @, ", ', \ — characters that bite Postgres libpq URI parsing
  # (the URI scheme uses /, @) or shell/SQL quoting (quotes, backslash).
  aws secretsmanager get-random-password \
    --password-length 32 \
    --exclude-characters '/@"'\''\' \
    --require-each-included-type \
    --query RandomPassword --output text
}

create_db_and_user() {
  local pw
  pw=$(generate_password)

  # Use psql --set to avoid interpolating the password into SQL directly.
  "${PSQL_MASTER[@]}" --set=app_pw="$pw" <<SQL
CREATE DATABASE $DB_NAME;
CREATE USER $DB_USER WITH PASSWORD :'app_pw';
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
REVOKE ALL PRIVILEGES ON DATABASE $DB_NAME FROM PUBLIC;
SQL

  aws secretsmanager put-secret-value \
    --secret-id "$APP_SECRET_ID" \
    --secret-string "$pw" \
    --region "$AWS_REGION" \
    >/dev/null

  echo "Created DB $DB_NAME, user $DB_USER, and populated $APP_SECRET_ID"
}

create_user_only() {
  local pw
  pw=$(generate_password)
  "${PSQL_MASTER[@]}" --set=app_pw="$pw" <<SQL
CREATE USER $DB_USER WITH PASSWORD :'app_pw';
GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;
SQL
  aws secretsmanager put-secret-value \
    --secret-id "$APP_SECRET_ID" --secret-string "$pw" --region "$AWS_REGION" >/dev/null
  echo "Created user $DB_USER and populated $APP_SECRET_ID"
}

rotate_password() {
  local pw
  pw=$(generate_password)
  "${PSQL_MASTER[@]}" --set=app_pw="$pw" <<SQL
ALTER USER $DB_USER WITH PASSWORD :'app_pw';
SQL
  aws secretsmanager put-secret-value \
    --secret-id "$APP_SECRET_ID" --secret-string "$pw" --region "$AWS_REGION" >/dev/null
  echo "Rotated password for $DB_USER and updated $APP_SECRET_ID"
}

# --- dispatch by mode ---
case "$MODE" in
  verify)
    verify_state
    ;;
  default)
    state=$(verify_state)
    case "$state" in
      OK)             echo "Nothing to do (already bootstrapped)." ;;
      MISSING)        create_db_and_user ;;
      DB_ONLY)        create_user_only ;;
      SECRET_MISSING) rotate_password ;;
      *)              echo "ERROR: unexpected state '$state'" >&2; exit 1 ;;
    esac
    ;;
  user-only)    create_user_only ;;
  secret-only)  rotate_password ;;
  reset-password) rotate_password ;;
esac
