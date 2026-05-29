#!/usr/bin/env bash
# Create per-env databases + app users inside the shared RDS instance, and
# write the generated password to mythrun/{env}/rds-password.
#
# MUST run from within the VPC (ECS run-task or SSM Session Manager tunnel) —
# RDS is not publicly accessible.
#
# Usage:
#   bootstrap-databases.sh --env staging [--verify | --user-only | --secret-only | --reset-password | --migrate-user-only | --reset-migrate-password | --seed-smoke-credits]
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
#   --grant-only      DB + user + secret all exist but the user lacks CREATE on
#                     schema public (Postgres 15+ default ACL). Idempotent.
#   --migrate-user-only          Provision/refresh the migrate user only.
#   --reset-migrate-password     Rotate the migrate user's password + secret value.
#   --seed-smoke-credits         Grant 1,000,000 each of world_gen + session credits
#                                to the four MYT-55 smoke users. Idempotent (WHERE
#                                NOT EXISTS guard keyed off (user_id, credit_type,
#                                source_type='admin')). Requires the smoke users'
#                                rows to already exist in the application DB (the
#                                smoke's first POST /api/users/register materializes
#                                them) AND the bootstrap-db task to carry
#                                COGNITO_USER_POOL_ID + SMOKE_USER_EMAIL_* env vars
#                                + cognito-idp:AdminGetUser IAM. Staging-only.
#   --grant-app-privileges       Grant the app user (DB_USER) full privileges on
#                                every public-schema table/sequence/function plus
#                                ALTER DEFAULT PRIVILEGES so future migrate-created
#                                objects auto-flow. Idempotent. Run once per env;
#                                re-run after introducing a new role pattern.
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
RESET_MIGRATE_PW=0

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
    --grant-only)     set_mode "grant-only"; shift ;;
    --migrate-user-only)     set_mode "migrate-user-only"; shift ;;
    --reset-migrate-password) set_mode "reset-migrate-password"; RESET_MIGRATE_PW=1; shift ;;
    --seed-smoke-credits) set_mode "seed-smoke-credits"; shift ;;
    --grant-app-privileges) set_mode "grant-app-privileges"; shift ;;
    --debug-campaign-state) set_mode "debug-campaign-state"; DEBUG_CAMPAIGN_ID="$2"; shift 2 ;;
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

  grant_public_schema_create

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
  grant_public_schema_create
  aws secretsmanager put-secret-value \
    --secret-id "$APP_SECRET_ID" --secret-string "$pw" --region "$AWS_REGION" >/dev/null
  echo "Created user $DB_USER and populated $APP_SECRET_ID"
}

# Postgres 15+ requires explicit CREATE on schema public for non-owner users
# (the default ACL revoked PUBLIC's CREATE rights). Without this grant the
# migration runner can't even create its `_migrations` tracking table —
# observed as `permission denied for schema public` (SQLSTATE 42501).
#
# The grant must be issued while connected to the target database (per-DB
# schema), so we open a fresh psql connection against $DB_NAME rather than
# reusing PSQL_MASTER (which targets the maintenance `postgres` DB).
grant_public_schema_create() {
  psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
    --dbname="$DB_NAME" --no-password --tuples-only --no-align <<SQL
GRANT USAGE, CREATE ON SCHEMA public TO $DB_USER;
SQL
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

# Provision the migrate user with rds_superuser + app-user role membership.
# The migrate user runs forward-only schema migrations. rds_superuser
# enables CREATE EXTENSION; membership in the app-user role grants ALTER
# rights on existing app-owned tables (rds_superuser is NOT a true
# SUPERUSER and cannot bypass object ACLs).
#
# Idempotent: skips if user already exists, unless RESET_MIGRATE_PW=1.
# The secret value is JSON {"username","password"} matching the master
# RDS secret convention.
provision_migrate_user() {
  local migrate_user="mythrun_${ENV}_migrate"
  local migrate_secret_id="mythrun/${ENV}/migrate-db-credentials"
  local app_user="$DB_USER"

  local exists
  exists=$("${PSQL_MASTER[@]}" --tuples-only --no-align \
    --set=u="$migrate_user" \
    <<< "SELECT 1 FROM pg_roles WHERE rolname = :'u'" | tr -d '[:space:]')

  if [[ -n "$exists" && "${RESET_MIGRATE_PW:-0}" != "1" ]]; then
    echo "$migrate_user already exists; skip (pass --reset-migrate-password to rotate)"
    return 0
  fi

  local pw
  pw=$(generate_password)

  # Cluster-level grants against the maintenance DB.
  # Branch in bash rather than `DO $$ ... $$` — psql variable substitution
  # (:'u', :u) does NOT happen inside dollar-quoted blocks, so the DO form
  # would send literal `:'u'` to the server and fail with syntax error.
  # Mirror the existing create_db_and_user/create_user_only pattern:
  # bash interpolates identifiers ($migrate_user), psql substitutes the
  # password literal (:'pw').
  if [[ -n "$exists" ]]; then
    "${PSQL_MASTER[@]}" --set=pw="$pw" <<SQL
ALTER USER $migrate_user WITH PASSWORD :'pw';
GRANT rds_superuser TO $migrate_user;
GRANT $app_user TO $migrate_user;
SQL
  else
    "${PSQL_MASTER[@]}" --set=pw="$pw" <<SQL
CREATE USER $migrate_user WITH LOGIN PASSWORD :'pw';
GRANT rds_superuser TO $migrate_user;
GRANT $app_user TO $migrate_user;
SQL
  fi

  # Schema-level grants must run against the TARGET DB, not the maintenance DB.
  psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
    --dbname="$DB_NAME" --no-password --tuples-only --no-align <<SQL
GRANT USAGE, CREATE ON SCHEMA public TO $migrate_user;
SQL

  # JSON-shape secret value: {"username":"...","password":"..."}. ECS
  # task def references .password via `valueFrom = <arn>:password::`.
  local secret_json
  secret_json=$(jq -cn --arg u "$migrate_user" --arg p "$pw" '{username:$u, password:$p}')
  aws secretsmanager put-secret-value \
    --secret-id "$migrate_secret_id" --secret-string "$secret_json" --region "$AWS_REGION" >/dev/null
  echo "Provisioned $migrate_user → $migrate_secret_id (JSON shape)"
}

# Seed smoke-test user credits (MYT-55). Grants 1,000,000 each of `world_gen`
# and `session` credits, source_type='admin', to the four staging smoke users
# (mythrun-staging-smoke-{owner,player_1,player_2,player_3}@example.com).
#
# Lookup is by cognito_sub: the smoke users are created in Cognito via
# admin-create-user (infra/modules/auth/smoke-test.tf), which assigns each a
# stable sub at first creation. Their application-side `users` row is created
# on first POST /api/users/register, which writes that sub into
# users.cognito_sub. The username chosen at registration is NOT deterministic
# from this task's perspective (the smoke script picks it), and the email
# column was dropped in migration 005 — so cognito_sub is the only stable
# join key we can resolve at seed time.
#
# We resolve the four subs at runtime via `aws cognito-idp admin-get-user`
# against COGNITO_USER_POOL_ID. The bootstrap-db task carries the four
# SMOKE_USER_EMAIL_* env vars (deterministic strings) + AdminGetUser IAM on
# the staging user pool.
#
# Idempotency: WHERE NOT EXISTS on a deterministic source_id hash
# (md5(user_id || ':' || credit_type)). Re-runs are no-ops. We could not use
# ON CONFLICT — credit_ledger has no unique index on (user_id, credit_type,
# source_type='admin'), and adding one would couple this dev-tool to
# production schema for no win.
#
# Connects to the application DB (mythrun_${ENV}), not the maintenance
# postgres DB, because credit_ledger lives there. The master user has full
# access to any DB on the cluster, so no extra grants are needed.
seed_smoke_credits() {
  if [[ -z "${COGNITO_USER_POOL_ID:-}" ]]; then
    echo "ERROR: --seed-smoke-credits requires COGNITO_USER_POOL_ID env var" >&2
    return 1
  fi

  local emails=(
    "${SMOKE_USER_EMAIL_OWNER:-}"
    "${SMOKE_USER_EMAIL_PLAYER_1:-}"
    "${SMOKE_USER_EMAIL_PLAYER_2:-}"
    "${SMOKE_USER_EMAIL_PLAYER_3:-}"
  )
  for e in "${emails[@]}"; do
    if [[ -z "$e" ]]; then
      echo "ERROR: --seed-smoke-credits requires SMOKE_USER_EMAIL_{OWNER,PLAYER_1,PLAYER_2,PLAYER_3} env vars" >&2
      return 1
    fi
  done

  # Resolve email → cognito_sub via AdminGetUser. The `sub` attribute is the
  # primary stable identifier for a Cognito user and matches users.cognito_sub
  # in Postgres.
  local subs=()
  for e in "${emails[@]}"; do
    local sub
    sub=$(aws cognito-idp admin-get-user \
      --user-pool-id "$COGNITO_USER_POOL_ID" \
      --username "$e" \
      --region "$AWS_REGION" \
      --query 'UserAttributes[?Name==`sub`].Value | [0]' \
      --output text 2>/dev/null || true)
    if [[ -z "$sub" || "$sub" == "None" ]]; then
      echo "ERROR: could not resolve cognito_sub for $e (admin-get-user returned empty)" >&2
      return 1
    fi
    subs+=("$sub")
  done

  # Build a comma-separated quoted list for the SQL IN clause. The values
  # are Cognito-assigned UUIDs (safe characters); we still single-quote them
  # in the SQL literal.
  local sub_list=""
  local first=1
  for s in "${subs[@]}"; do
    if [[ $first -eq 1 ]]; then
      sub_list="'$s'"
      first=0
    else
      sub_list="$sub_list, '$s'"
    fi
  done

  echo "Resolved ${#subs[@]} cognito_subs for smoke users; seeding credits in $DB_NAME..."

  # Connect to the application DB (NOT the maintenance postgres DB). Master
  # user has full access; no separate app credentials needed.
  #
  # WHERE NOT EXISTS keys off the deterministic source_id hash so re-runs
  # are no-ops. source_type='admin' (added by migration 012); both FK columns
  # NULL (required by credit_ledger_source_link_chk for admin grants).
  psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
    --dbname="$DB_NAME" --no-password -v ON_ERROR_STOP=1 <<SQL
WITH smoke_users AS (
  SELECT id FROM users WHERE cognito_sub IN ($sub_list)
)
INSERT INTO credit_ledger
  (id, user_id, credit_type, amount, source_type,
   source_id, expires_at, source_purchase_id, source_billing_history_id)
SELECT
  gen_random_uuid(),
  su.id,
  ct.kind,
  1000000,
  'admin',
  md5(su.id::text || ':' || ct.kind)::uuid,
  NULL,
  NULL,
  NULL
FROM smoke_users su, (VALUES ('world_gen'), ('session')) AS ct(kind)
WHERE NOT EXISTS (
  SELECT 1 FROM credit_ledger cl
  WHERE cl.source_id = md5(su.id::text || ':' || ct.kind)::uuid
    AND cl.source_type = 'admin'
);

-- Report what's now on the ledger for the smoke users so the operator can
-- eyeball the result without a second query.
SELECT u.cognito_sub,
       cl.credit_type,
       SUM(cl.amount) AS total
  FROM users u
  JOIN credit_ledger cl ON cl.user_id = u.id
 WHERE u.cognito_sub IN ($sub_list)
   AND cl.source_type = 'admin'
 GROUP BY u.cognito_sub, cl.credit_type
 ORDER BY u.cognito_sub, cl.credit_type;
SQL

  echo "Smoke credits seeded (1M each of world_gen + session per smoke user; re-runs are no-ops)."
}

# Grants the app user (DB_USER) full privileges on every public-schema
# object owned by the migrate user, and sets ALTER DEFAULT PRIVILEGES so
# objects created by the migrate user in the future are auto-granted to
# the app user.
#
# Without this, tables introduced by recent migrations (CREATE TABLE runs
# as migrate; the table is owned by migrate; app has no ACL) are not
# readable by the API — observed as `permission denied for table X`
# (SQLSTATE 42501). Older tables were created before the migrate user
# existed (back when migrations ran as the master role), so they have
# the broader ACL by construction. This mode catches up the post-migrate
# tables AND makes future tables auto-flow.
#
# Idempotent: re-running emits no-op GRANTs.
grant_app_privileges() {
  local migrate_user="mythrun_${ENV}_migrate"
  echo "Granting $DB_USER full privileges on all public-schema objects in $DB_NAME (catchup + future-default)..."
  psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
    --dbname="$DB_NAME" --no-password -v ON_ERROR_STOP=1 <<SQL
-- Catchup: every table, sequence, and function currently in the public
-- schema becomes fully accessible to the app user. ON ALL is the
-- catalog-snapshot form; objects created after this command are NOT
-- covered (that's what ALTER DEFAULT PRIVILEGES below handles).
GRANT ALL ON ALL TABLES IN SCHEMA public TO $DB_USER;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $DB_USER;
GRANT ALL ON ALL FUNCTIONS IN SCHEMA public TO $DB_USER;

-- ALTER DEFAULT PRIVILEGES FOR ROLE <X> requires the executor to be a
-- member of role X (RDS master is not a true SUPERUSER and can't bypass
-- this). Grant membership in the migrate role just long enough to set
-- the defaults, then drop it. Idempotent — re-grant + re-revoke are
-- no-ops if the cycle already ran.
GRANT $migrate_user TO $MASTER_USER;

-- Future: objects the migrate user creates in the public schema from
-- this point onward auto-grant to the app user at creation time.
ALTER DEFAULT PRIVILEGES FOR ROLE $migrate_user IN SCHEMA public
  GRANT ALL ON TABLES TO $DB_USER;
ALTER DEFAULT PRIVILEGES FOR ROLE $migrate_user IN SCHEMA public
  GRANT ALL ON SEQUENCES TO $DB_USER;
ALTER DEFAULT PRIVILEGES FOR ROLE $migrate_user IN SCHEMA public
  GRANT ALL ON FUNCTIONS TO $DB_USER;

REVOKE $migrate_user FROM $MASTER_USER;
SQL
  echo "Granted $DB_USER full privileges + future-default privileges (idempotent)."
}

# Diagnostic-only mode for triaging stuck campaign-integration jobs (MYT-56).
# Prints campaigns / pipeline_runs / character_concepts rows for the given
# campaign_id. Read-only; useful for understanding where a stuck campaign is
# in the pipeline without granting CLI psql access to the operator.
#
# Required env: DEBUG_CAMPAIGN_ID (passed in by --debug-campaign-state <uuid>).
debug_campaign_state() {
  if [[ -z "${DEBUG_CAMPAIGN_ID:-}" ]]; then
    echo "ERROR: --debug-campaign-state requires a campaign UUID argument" >&2
    exit 2
  fi
  echo "Debugging campaign $DEBUG_CAMPAIGN_ID in $DB_NAME..."
  psql --host="$RDS_HOST" --port="$RDS_PORT" --username="$MASTER_USER" \
    --dbname="$DB_NAME" --no-password -v ON_ERROR_STOP=1 \
    --set=cid="$DEBUG_CAMPAIGN_ID" <<'SQL'
\echo '== campaigns =='
SELECT id, status, world_id, created_at, updated_at FROM campaigns WHERE id = :'cid';
\echo
\echo '== world =='
SELECT id, name, status, LEFT(concept,80) AS concept_head
  FROM worlds WHERE id = (SELECT world_id FROM campaigns WHERE id = :'cid');
\echo
\echo '== entities by type (world-scoped) =='
SELECT entity_type, COUNT(*) AS n
  FROM entities WHERE world_id = (SELECT world_id FROM campaigns WHERE id = :'cid')
 GROUP BY entity_type ORDER BY entity_type;
\echo
\echo '== entities — locations only =='
SELECT name FROM entities
 WHERE world_id = (SELECT world_id FROM campaigns WHERE id = :'cid')
   AND entity_type = 'location' ORDER BY created_at;
\echo
\echo '== entities — non-locations (npcs + factions) =='
SELECT entity_type, name FROM entities
 WHERE world_id = (SELECT world_id FROM campaigns WHERE id = :'cid')
   AND entity_type IN ('npc', 'faction') ORDER BY entity_type, created_at;
\echo
\echo '== pipeline_runs =='
SELECT campaign_id, world_id, stage, status,
       LEFT(COALESCE(error,''),120) AS error,
       started_at, completed_at
  FROM pipeline_runs
 WHERE campaign_id = :'cid' OR world_id = (SELECT world_id FROM campaigns WHERE id = :'cid')
 ORDER BY started_at;
\echo
\echo '== character_concepts =='
SELECT campaign_id, user_id, status, LEFT(COALESCE(error,''),80) AS error, updated_at
  FROM character_concepts
 WHERE campaign_id = :'cid';
\echo
\echo '== campaign_characters =='
SELECT campaign_id, user_id, character_id FROM campaign_characters WHERE campaign_id = :'cid';
\echo
\echo '== characters (joined via campaign_characters) =='
SELECT c.id, c.entity_id, c.name, c.class, c.level
  FROM characters c
  JOIN campaign_characters cc ON cc.character_id = c.id
 WHERE cc.campaign_id = :'cid';
SQL
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
    # Always (re-)assert the migrate user. Idempotent — skips if already
    # present unless --reset-migrate-password is set.
    provision_migrate_user
    ;;
  user-only)    create_user_only ;;
  secret-only)  rotate_password ;;
  reset-password) rotate_password ;;
  grant-only)   grant_public_schema_create
                echo "Granted USAGE, CREATE on schema public to $DB_USER in $DB_NAME." ;;
  migrate-user-only)
    provision_migrate_user
    ;;
  reset-migrate-password)
    provision_migrate_user
    ;;
  seed-smoke-credits)
    seed_smoke_credits
    ;;
  grant-app-privileges)
    grant_app_privileges
    ;;
  debug-campaign-state)
    debug_campaign_state
    ;;
esac
