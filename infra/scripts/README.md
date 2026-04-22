# infra/scripts

## bootstrap.sh

One-time bootstrap of the Terraform state S3 bucket.

Run once per AWS account, before any `terraform init`:

```bash
bash infra/scripts/bootstrap.sh
```

Idempotent — safe to re-run.

## bootstrap-databases.sh

Creates per-env databases and app users inside the shared RDS instance, and
populates `mythrun/{env}/rds-password`. **Must run from inside the VPC** (RDS
is not publicly accessible).

### Execution methods

Today (pre-MYT-30): no in-VPC compute exists. The script is an artifact only.

Post-MYT-30: run via one-shot ECS task:

```bash
aws ecs run-task \
  --cluster mythrun \
  --task-definition mythrun-bootstrap-db \
  --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[PRIVATE_A],securityGroups=[SG_ECS],assignPublicIp=DISABLED}" \
  --overrides '{"containerOverrides":[{"name":"bootstrap","command":["/app/bootstrap-databases.sh","--env","staging"]}]}'
```

The task role needs:
- `secretsmanager:GetSecretValue` on the RDS master user secret ARN (from shared outputs)
- `secretsmanager:PutSecretValue` on `mythrun/{env}/rds-password` only
- Network path to RDS (join `sg-ecs`, place in `private-a` or `private-b`)

Scope the task role tightly. Revoke after use.

### Modes

- `--verify` — check current state. Prints `OK`, `DB_ONLY`, `SECRET_MISSING`, or `MISSING`.
- default — create whatever is missing. Idempotent.
- `--user-only` — DB exists but user doesn't. Create user + password.
- `--secret-only` / `--reset-password` — rotate the app user password. Aliases; use `--secret-only` when the stored secret is absent, `--reset-password` when it's known-wrong.

### Recovery from partial failures

State reported by `--verify`:

- `OK` — nothing to do.
- `MISSING` — run the default (no flags). Creates DB + user + secret.
- `DB_ONLY` — run with `--user-only`.
- `SECRET_MISSING` — run with `--secret-only`. The DB user exists but we don't know its password. `--secret-only` rotates the password via `ALTER USER` and writes the new value to Secrets Manager.
