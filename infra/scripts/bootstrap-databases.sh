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
#                     OK / DB_ONLY / USER_ONLY / SECRET_MISMATCH / MISSING
#   --user-only       DB exists but user doesn't: create user + password + secret.
#   --secret-only     DB + user exist but secret version missing or placeholder:
#                     ALTER USER password + write secret.
#   --reset-password  Everything exists but password is wrong: rotate it.
#
# Required env vars (injected via ECS task role):
#   AWS_REGION                us-east-1
#   RDS_MASTER_SECRET_ARN     ARN of the AWS-managed RDS master user secret
#                             (from shared workspace output: rds_master_user_secret_arn)

set -euo pipefail

ENV=""
MODE="default"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)            ENV="$2"; shift 2 ;;
    --verify)         MODE="verify"; shift ;;
    --user-only)      MODE="user-only"; shift ;;
    --secret-only)    MODE="secret-only"; shift ;;
    --reset-password) MODE="reset-password"; shift ;;
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
: "${RDS_MASTER_SECRET_ARN:?RDS_MASTER_SECRET_ARN env var required}"

DB_NAME="mythrun_${ENV}"
DB_USER="mythrun_${ENV}"
APP_SECRET_ID="mythrun/${ENV}/rds-password"

# Fetch master credentials from Secrets Manager
MASTER_JSON=$(aws secretsmanager get-secret-value \
  --secret-id "$RDS_MASTER_SECRET_ARN" --region "$AWS_REGION" \
  --query SecretString --output text)
MASTER_USER=$(echo "$MASTER_JSON" | jq -r .username)
MASTER_PASS=$(echo "$MASTER_JSON" | jq -r .password)
RDS_HOST=$(echo "$MASTER_JSON" | jq -r .host)
RDS_PORT=$(echo "$MASTER_JSON" | jq -r .port)

# Base psql command; connects to the 'postgres' maintenance DB.
export PGPASSWORD="$MASTER_PASS"
PSQL_MASTER=(psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
             --dbname=postgres --no-password --tuples-only --no-align)

# --- verify mode ---
verify_state() {
  local db_exists user_exists secret_has_version

  db_exists=$("${PSQL_MASTER[@]}" -c "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME';" | tr -d '[:space:]' || true)
  user_exists=$("${PSQL_MASTER[@]}" -c "SELECT 1 FROM pg_user WHERE usename = '$DB_USER';" | tr -d '[:space:]' || true)
  secret_has_version=$(aws secretsmanager describe-secret --secret-id "$APP_SECRET_ID" \
    --region "$AWS_REGION" --query 'VersionIdsToStages' --output text 2>/dev/null || echo "")

  if [[ "$db_exists" == "1" && "$user_exists" == "1" && -n "$secret_has_version" ]]; then
    echo "OK"; return 0
  elif [[ "$db_exists" == "1" && "$user_exists" == "1" ]]; then
    echo "USER_ONLY"; return 0  # DB + user, but no secret version
  elif [[ "$db_exists" == "1" ]]; then
    echo "DB_ONLY"; return 0
  else
    echo "MISSING"; return 0
  fi
}

generate_password() {
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
      OK)            echo "Nothing to do (already bootstrapped)." ;;
      MISSING)       create_db_and_user ;;
      DB_ONLY)       create_user_only ;;
      USER_ONLY)     rotate_password ;;
      *)             echo "ERROR: unexpected state '$state'" >&2; exit 1 ;;
    esac
    ;;
  user-only)    create_user_only ;;
  secret-only)  rotate_password ;;
  reset-password) rotate_password ;;
esac
