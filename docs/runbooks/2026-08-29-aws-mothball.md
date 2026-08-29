# AWS Mothball — 2026-08-29

Mythrun is on temporary hold. This runbook records exactly what was turned off,
what it costs while off, and how to bring it all back. Executed live on
2026-08-29 against account `862127484110` (us-east-1) by a Claude session at
Miklos's request ("wind down AWS spend to under $20/month").

**Nothing data-bearing was deleted.** Postgres data, Cognito users, all
secrets, Terraform state, ECR app images, and DNS are intact.

## Spend before → after

Before: ~$115–125/month, almost entirely idle-hours charges
(NAT $33, ALB+IPv4s $22, Fargate $18, RDS $13, Redis $11, NAT EIP $3.65,
Secrets Manager $5.60, tax ~$11).

Projected after (once the two pending steps below are done): **~$12/month**
— RDS gp3 storage $2.30, 14 Secrets Manager secrets $5.60, KMS CMK $1.00,
CloudWatch alarms $0.70, Route53 zone $0.51, ECR storage ~$0.61, RDS
weekly-restart leakage ~$0.30, plus ~10% tax.

## What was done (verbatim, in order)

1. **Disabled the Deploy GitHub workflow** — it force-resets ECS
   desired-count to 1 on every push to main (deploy.yml lines 260–267,
   374–381), which would silently resurrect spend:

   ```sh
   gh workflow disable deploy.yml
   ```

2. **Scaled both ECS services to 0** (services kept; $0 at zero):

   ```sh
   aws ecs update-service --cluster mythrun --service mythrun-staging-api --desired-count 0
   aws ecs update-service --cluster mythrun --service mythrun-staging-worker --desired-count 0
   ```

3. **Deleted the NAT gateway and released its EIP** (Terraform recreates both
   on resume; the private route table's NAT route is a blackhole until then):

   ```sh
   aws ec2 delete-nat-gateway --nat-gateway-id nat-0e19317b7151429c1
   aws ec2 release-address --allocation-id eipalloc-066d6497c199be693   # was 54.164.130.38
   ```

4. **Deleted the Redis replication group** (ElastiCache has no stop
   capability; it held 9 MB of ephemeral BullMQ/cache data). Final snapshot
   retained: `mythrun-redis-mothball-2026-08-29` (~$0/month at 9 MB):

   ```sh
   aws elasticache delete-replication-group --replication-group-id mythrun-redis \
     --final-snapshot-identifier mythrun-redis-mothball-2026-08-29
   ```

5. **Stopped the RDS instance** with a safety snapshot taken at stop time.
   The instance, its 20 GB gp3 volume, config, and endpoint all survive;
   only storage bills while stopped:

   ```sh
   aws rds stop-db-instance --db-instance-identifier mythrun \
     --db-snapshot-identifier mythrun-mothball-2026-08-29
   ```

6. **Created the IAM role for the daily re-stop schedule** (see pending step
   B — AWS auto-restarts stopped RDS instances after 7 days, so a scheduled
   re-stop is what makes the stop durable):

   ```sh
   aws iam create-role --role-name mythrun-mothball-rds-stop \
     --description "Mothball hold 2026-08-29: lets EventBridge Scheduler re-stop the mythrun RDS instance after AWS's 7-day auto-restart. Delete on resume." \
     --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole","Condition":{"StringEquals":{"aws:SourceAccount":"862127484110"}}}]}'
   aws iam put-role-policy --role-name mythrun-mothball-rds-stop \
     --policy-name stop-mythrun-rds \
     --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"rds:StopDBInstance","Resource":"arn:aws:rds:us-east-1:862127484110:db:mythrun"}]}'
   ```

## Pending — run these by hand (agent permission classifier blocked them)

**A. Delete the ALB** (~$24/month: $16.40 hours + $7.30 for its two
service-managed public IPv4s, which release automatically with it).
Deletion protection must be flipped first:

```sh
aws elbv2 modify-load-balancer-attributes \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:862127484110:loadbalancer/app/mythrun-alb/64387e01eab02bd1 \
  --attributes Key=deletion_protection.enabled,Value=false
aws elbv2 delete-load-balancer \
  --load-balancer-arn arn:aws:elasticloadbalancing:us-east-1:862127484110:loadbalancer/app/mythrun-alb/64387e01eab02bd1
```

The target group `mythrun-staging-api` stays (free). The Route53 alias
`staging-api.mythrun.com` dangles harmlessly until resume.

**B. Create the daily RDS re-stop schedule** (role from step 6 above already
exists). Without this, AWS restarts the stopped instance every 7 days and it
then bills ~$11.70/month until someone notices:

```sh
aws scheduler create-schedule --name mythrun-mothball-rds-stop-daily \
  --description "Mothball hold 2026-08-29: re-stops RDS 'mythrun' daily (AWS auto-restarts stopped instances after 7 days). Errors while already stopped are expected and harmless. Delete on resume." \
  --schedule-expression "cron(15 6 * * ? *)" --schedule-expression-timezone UTC \
  --flexible-time-window Mode=OFF \
  --target '{"Arn":"arn:aws:scheduler:::aws-sdk:rds:stopDBInstance","RoleArn":"arn:aws:iam::862127484110:role/mythrun-mothball-rds-stop","Input":"{\"DbInstanceIdentifier\": \"mythrun\"}","RetryPolicy":{"MaximumRetryAttempts":2}}'
```

**C. Optional, cosmetic** — silence alarm notifications for the hold (without
this you may get a few one-time state-transition emails to dev@mythrun.com as
things went dark; alarms do not re-email while parked in a state):

```sh
aws cloudwatch disable-alarm-actions --alarm-names mythrun-acm-wildcard-expiry mythrun-alb-5xx mythrun-nat-port-allocation-errors mythrun-rds-cpu-high mythrun-rds-storage-low mythrun-redis-001-memory-high mythrun-staging-api-down mythrun-staging-api-target-5xx mythrun-staging-billing-probe-auth-failure mythrun-staging-billing-probe-config-failure mythrun-staging-billing-probe-transient-failure mythrun-staging-cognito-federation-throttles-discord mythrun-staging-cognito-federation-throttles-google mythrun-staging-cognito-sign-in-throttles mythrun-staging-stripe-webhook-api-version-mismatch mythrun-staging-voyage-misconfigured mythrun-staging-voyage-unavailable
```

**D. Optional, ~$0.17/month** — delete the ECR pull-through-cache mirrors of
public node/alpine images (1.72 GB; auto-recreated on next pull):

```sh
aws ecr delete-repository --repository-name ecr-public/docker/library/node --force
aws ecr delete-repository --repository-name ecr-public/docker/library/alpine --force
```

## What was deliberately kept

- **Cognito user pool** `mythrun-staging-users` (us-east-1_5gDAtYzjV) — users
  are unrecoverable if deleted; free at this MAU.
- **All 14 Secrets Manager secrets** ($5.60/month) — deleting TF-managed
  secrets creates name-collision drift on resume (recreating a secret pending
  deletion fails), not worth it.
- **Route53 zone** mythrun.com, **ACM cert**, **CloudFront + frontend S3
  bucket** (staging.mythrun.com still serves the SPA behind basic auth; /api/*
  returns 5xx — expected), **Terraform state bucket**, **ECR app images**,
  **KMS CMK** alias/mythrun-alerts, **all alarms/SNS/budget**, the **VPC and
  everything free inside it**, and all ECS task definitions.
- RDS automated daily snapshots age out on their 7-day retention; the manual
  `mythrun-mothball-2026-08-29` snapshot is the durable copy and is free
  while the instance exists (within the 20 GB backup allowance).

## Known hold-state quirks

- Terraform now has drift in `environments/shared` (NAT gateway, NAT EIP,
  and — after pending step A — the ALB + listeners). **Do not run
  `terraform apply` casually during the hold**; it would recreate them and
  restart the spend. Applies are manual-only in this project (no CI apply),
  so nothing will do this automatically.
- deploy.yml is disabled; `gh workflow run` deploys and db-migrate
  dispatches will not work until re-enabled. Migrate/bootstrap run-tasks
  would fail anyway (no NAT egress, DB stopped).
- The private subnets' route table has a blackhole route to the deleted NAT
  until resume.
- `mythrun-staging-api-down` and friends sit in ALARM/INSUFFICIENT_DATA for
  the duration. That is the expected parked state.

## Resume procedure (reverse order)

1. Delete the re-stop schedule and its role:

   ```sh
   aws scheduler delete-schedule --name mythrun-mothball-rds-stop-daily
   aws iam delete-role-policy --role-name mythrun-mothball-rds-stop --policy-name stop-mythrun-rds
   aws iam delete-role --role-name mythrun-mothball-rds-stop
   ```

2. Start the DB and wait for `available`:

   ```sh
   aws rds start-db-instance --db-instance-identifier mythrun
   aws rds wait db-instance-available --db-instance-identifier mythrun
   ```

3. Recreate the deleted infra with Terraform, shared first, then staging:

   ```sh
   cd infra/environments/shared && terraform apply    # NAT + EIP, ALB + listeners, alb-5xx alarm, NEW (empty) Redis
   cd ../staging && terraform apply                   # listener rule, staging-api alias, task-def env refresh
   ```

   Notes: the recreated Redis is empty (BullMQ/cache data was ephemeral; the
   `mythrun-redis-mothball-2026-08-29` snapshot exists if anything is ever
   missed). If the shared apply trips on the blackhole NAT route, delete that
   route from the private route table and re-apply. The staging apply must
   run after shared so the new listener/ALB ARNs flow through remote state.

4. Re-enable CI and alarms, then deploy:

   ```sh
   gh workflow enable deploy.yml
   aws cloudwatch enable-alarm-actions --alarm-names <same 17 names as step C above>
   gh workflow run Deploy   # staging-only dispatch sets desired-count back to 1
   ```

5. Verify: `pnpm smoke:staging`, watch `mythrun-staging-api-down` return to OK.

6. Delete this runbook's "pending" section markers / update the wiki if the
   hold changed anything durable.
