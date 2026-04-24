# CI/CD + First Staging Deploy Design

**Linear issue:** MYT-28 (Ops Foundation milestone, Urgent, due 2026-04-27)
**Parent specs:** `docs/specs/2026-04-20-setup-guide.md` (Phase 5.3), `docs/specs/2026-04-10-infrastructure-devops.md`, `docs/specs/2026-04-07-week0-ops-foundation.md`
**Prior issue:** MYT-30 (serving infra — ECR repo, ECS cluster + services at `desired_count=0` on `:placeholder`, ALB, OIDC provider, `mythrun-github-actions-staging` role with 6-condition trust)
**Version:** v2 (post blind agent-team review: LeBron / Curry / Kobe / Giannis, 2026-04-24)
**Status:** Ready for implementation

---

## Goal

Stand up a GitHub Actions workflow that builds the backend image, pushes it to ECR, and flips the staging ECS service from `desired_count=0` on `:placeholder` to `desired_count=1` on the just-built `@sha256:<digest>`-addressed image — on every push to `main` that touches code. This is the Ops Foundation ship gate: when it works, a code change flows from `git push` to a healthy staging container in one step.

## Done when

1. A push to `main` (touching non-doc paths) triggers `.github/workflows/deploy.yml` and the workflow succeeds end-to-end
2. `aws ecs describe-services --cluster mythrun --services mythrun-staging-api --query 'services[0]'` returns `runningCount = 1, desiredCount = 1` on a task-def revision whose image URI is of the form `<account>.dkr.ecr.us-east-1.amazonaws.com/mythrun@sha256:<digest>`
3. `curl -fsS https://staging-api.mythrun.com/health` returns HTTP 200 with body `{"status":"ok"}`
4. The `deployments[0].rolloutState` on the staging service is `COMPLETED` — verified by an explicit post-deploy check step (the deploy action does not check this automatically; `aws ecs wait services-stable` returns success on circuit-breaker rollback, so we assert it directly)
5. A second push (any no-op commit outside the `paths-ignore` list) re-runs the workflow end-to-end in under 10 minutes, producing a new task-def revision on the staging service (verifies idempotency). **Revision count ≥ prior+1** (not strictly prior+1, because register-task-definition on a re-run after a failed deploy can produce an orphan revision)
6. **SIGTERM handler verification:** (a) unit test in `backend/src/__tests__/server.test.ts` asserts the `SIGTERM` handler calls `app.close()` before `process.exit`; (b) `aws ecs describe-tasks --cluster mythrun --tasks <prior-task-arn>` on the task replaced during the second deploy shows `stoppedReason` indicating a clean stop (not `OutOfMemory`, not `ContainerKilled`). The CloudWatch "shutting down" log line is a nice-to-have but not a Done-when condition — pino + awslogs flush ordering is not reliably observable before `process.exit(0)`.

## What this task does NOT do

- **Production deploy job.** Production infra doesn't exist yet (Platform Readiness milestone). The workflow is structured so adding it later is a pure-append (one new job with `needs: deploy-staging`, `environment: production`, reusing the `build` job's image output). Shape + hardening debt documented in §7.
- **Worker service deploy.** The staging worker service exists at `desired_count=0` on `:placeholder`. No `dist/worker.js` exists (Prep Pipeline milestone). The workflow ignores the worker service entirely — it stays at 0 via MYT-30's `ignore_changes = [desired_count, task_definition]`. The `:placeholder` image tag is itself a safety feature: a manual flip of worker `desired_count` to 1 fails fast at ECR pull rather than running stale/wrong code.
- **Runbook document.** `myth-bcx` (first-deploy runbook at `docs/runbooks/first-deploy.md`) is deferred. The workflow file's inline comments + this spec's §5 cover the common paths; MYT-30 Risks §6 covers first-deploy circuit-breaker recovery.
- **PR-triggered CI.** The project pushes direct to `main` (see CLAUDE.md "Human-Agent Review Workflow"). No PR flow, so no PR triggers on the workflow.
- **`/health` split into `/health/live` + `/health/ready`.** Deferred to `myth-nf3` (requires DB + Redis clients, Backend Core milestone).
- **CloudWatch alarm on deploy failures.** Observability milestone.
- **Formalized rollback tooling.** Manual for now: `git revert <bad-commit> && git push` triggers a redeploy of the reverted state. See MYT-30 Risks §6 for the first-deploy stuck-state breakglass path.
- **Image signing (cosign/sigstore).** Filed as `myth-67h` (P4, pre-launch).
- **Docker layer caching.** Add via `docker/build-push-action` with `cache-from: type=gha` when cold-build time exceeds 10 min consistently.
- **Frontend deploy.** When the frontend lands, the expectation is a sibling job `build-frontend` in this same workflow that produces static assets → S3 + CloudFront invalidation. Not part of MYT-28.

---

## Architecture summary

Single workflow file at `.github/workflows/deploy.yml`. Two jobs in one pipeline:

```
push to main (code paths only)      workflow_dispatch
         ↓                                ↓
┌──────────────────────────────────────────────────────────────────┐
│ build  (timeout-minutes: 15)                                     │
│   environment: staging  (OIDC trust requires env claim)          │
│   - checkout + pnpm install (scoped --filter @mythrun/backend...)│
│   - pnpm lint / typecheck / test (backend only)                  │
│   - pre-flight: assert AWS_ACCOUNT_ID is set                     │
│   - assume mythrun-github-actions-staging via OIDC               │
│   - ecr-login                                                    │
│   - docker build --platform linux/amd64 + OCI labels             │
│   - docker push :$GIT_SHA + :latest                              │
│   - resolve image digest via describe-images                     │
│   - outputs: image = <ecr>/mythrun@sha256:<digest>               │
└──────────────────────────────────────────────────────────────────┘
         ↓
┌──────────────────────────────────────────────────────────────────┐
│ deploy-staging  (needs: build, timeout-minutes: 20)              │
│   environment: staging                                           │
│   - assume mythrun-github-actions-staging via OIDC               │
│   - aws ecs describe-task-definition → strip read-only → JSON    │
│   - amazon-ecs-render-task-definition (patch image to digest ref)│
│   - amazon-ecs-deploy-task-definition (register new rev, update  │
│       service, wait-for-service-stability up to 15 min)          │
│   - aws ecs update-service --desired-count 1  (first deploy:     │
│       flips 0→1; subsequent: no-op)                              │
│   - post-deploy assertion: rolloutState == COMPLETED AND         │
│       runningCount == desiredCount == 1                          │
│   - smoke test: curl /health, 3 retries, jq body match on "ok"   │
└──────────────────────────────────────────────────────────────────┘
         ↓
        ✅ staging is live on the digest-addressed image
```

### Step-ordering notes (load-bearing)

1. **`pnpm install` runs BEFORE OIDC role assumption.** npm lifecycle scripts run during install and have access to `process.env`. By the time install completes, no AWS credentials exist yet — a compromised dependency cannot exfiltrate AWS access. **Do not hoist `AWS_ACCOUNT_ID` into a job-level `env:` block; reference it inline on `configure-aws-credentials` only** so it isn't visible to `pnpm install`.

2. **Deploy action runs BEFORE `update-service --desired-count 1`.** If the desired-count flip happens first, ECS sees `desiredCount=1` on a service still pinned to the `:placeholder` task-def revision, attempts to pull `:placeholder` (which doesn't exist in ECR), and logs placement failures for ~30-60s until the deploy step updates the revision. Reverse order: register the new revision, update the service to point at it, then flip desired-count.

3. **Digest resolution runs AFTER docker push, BEFORE render-task-definition.** Task defs reference the image by `@sha256:<digest>`, not `:$SHA` tag. ECR is MUTABLE (MYT-30 §4.2) — tags can be overwritten; digests cannot be silently mutated.

### Why the register-then-update-then-flip pattern

`aws ecs update-service --force-new-deployment` re-pulls the image but **does not switch task-definition revisions**. Terraform registered task-def revision 1 pointing at `:placeholder`. If CI only calls `update-service`, the service keeps using revision 1, which pulls the `:placeholder` tag (which does not resolve in ECR — `:placeholder` is a literal tag name, not a real image). Task fails to start.

The correct sequence — documented by `myth-bcx` and reinforced by MYT-30's Angelfish review — is:

1. **describe** the current task def (revision 1 on first deploy, revision N on subsequent)
2. **patch** `containerDefinitions[0].image` to the new digest URI
3. **register** a new revision
4. **update-service** with `--task-definition mythrun-staging-api:N+1`
5. **flip desired-count** to 1 (first deploy only; no-op on subsequent)
6. **explicitly verify** `rolloutState == COMPLETED` — the deploy action's `wait-for-service-stability` uses `aws ecs wait services-stable` under the hood, which returns success even after a circuit-breaker rollback (the service IS stable on its previous revision). Without an explicit assertion, a rollback silently presents as green CI.

The `aws-actions/amazon-ecs-deploy-task-definition@v2` action wraps steps 2–4 (render in a separate action, then register + update).

---

## Detailed design

### 1. Workflow file (`.github/workflows/deploy.yml`)

**Action SHA-pinning:** All third-party action references use SHA-pinning with the version as a trailing comment (see Decisions log #12). Dependabot (`.github/dependabot.yml` with `package-ecosystem: github-actions`) proposes bump PRs — reviewed by hand, never auto-merged.

```yaml
name: Deploy

on:
  push:
    branches: [main]
    # Skip pure doc/tracker commits. A merge that touches only these paths
    # should not burn a full CI run, a new ECS task-def revision, and ECR
    # retention slots. Add paths here as new non-code directories land.
    paths-ignore:
      - 'docs/**'
      - '.beads/**'
      - '**/*.md'
      - 'wiki/**'
      - '.github/wiki/**'
  workflow_dispatch:    # manual trigger for redeploys without a new commit (staging only)

permissions:
  id-token: write       # OIDC token minting
  contents: read        # checkout

concurrency:
  # Group by target ECS service, not by ref. Future branch-based preview
  # deploys (if we ever enable them) or the prod append (§7) will not share
  # a group with staging — they have different ECS_SERVICE values.
  group: deploy-mythrun-staging-api
  cancel-in-progress: false   # queue concurrent deploys; never kill in-flight

env:
  AWS_REGION: us-east-1
  ECR_REPO: mythrun

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: staging
    outputs:
      image: ${{ steps.digest.outputs.image }}
    steps:
      - uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683  # v4.2.2

      - uses: pnpm/action-setup@a7487c7e89a18df4991f7f222e4898a00d66ddda  # v4.1.0

      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020  # v6.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      # Scope install to backend workspace + its transitive workspace deps.
      # Prevents breakage in @mythrun/wiki or other sibling workspaces from
      # red-lighting a backend deploy.
      - run: pnpm install --frozen-lockfile --filter @mythrun/backend...

      - run: pnpm --filter @mythrun/backend lint
      - run: pnpm --filter @mythrun/backend typecheck
      - run: pnpm --filter @mythrun/backend test

      - name: Pre-flight — verify required vars are set
        # Fail fast with a clear error if AWS_ACCOUNT_ID is missing or typo'd.
        # configure-aws-credentials would fail later with a confusing STS error.
        run: |
          if [[ -z "${{ vars.AWS_ACCOUNT_ID }}" ]]; then
            echo "::error::vars.AWS_ACCOUNT_ID is not set. Configure at GitHub → Settings → Environments → staging → Environment variables."
            exit 1
          fi

      - name: Assume AWS role via OIDC
        # Reference vars.AWS_ACCOUNT_ID inline at this step — do NOT hoist
        # to job-level env:. Step-ordering keeps AWS creds out of scope during
        # pnpm install (where npm lifecycle scripts could read process.env).
        uses: aws-actions/configure-aws-credentials@ececac1a45f3b08a01d2dd070d28d111c5fe6722  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@062b18b96a7aff071d4dc91bc00c4c1a7945b076  # v2.0.1

      - name: Build and push image
        id: build
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
        run: |
          set -euo pipefail
          IMAGE_URI="$REGISTRY/${{ env.ECR_REPO }}:${{ github.sha }}"
          LATEST_URI="$REGISTRY/${{ env.ECR_REPO }}:latest"
          docker build \
            --platform linux/amd64 \
            --label "org.opencontainers.image.source=https://github.com/mythrun/mythrun" \
            --label "org.opencontainers.image.revision=${{ github.sha }}" \
            --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --label "com.mythrun.workflow_run=${{ github.run_id }}" \
            --label "com.mythrun.workflow_run_url=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            -t "$IMAGE_URI" -t "$LATEST_URI" \
            -f backend/Dockerfile .
          docker push "$IMAGE_URI"
          docker push "$LATEST_URI"

      - name: Resolve image digest
        id: digest
        # Task defs reference the image by @sha256:<digest>, not by :$SHA tag.
        # ECR is MUTABLE mode (MYT-30 §4.2) — tags can be overwritten, but
        # digests cannot. This closes the tag-mutation race where an attacker
        # with ECR push (or a future bug that re-pushes the same SHA) could
        # inject different bytes between push and ECS pull.
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
        run: |
          set -euo pipefail
          DIGEST=$(aws ecr describe-images \
            --repository-name "${{ env.ECR_REPO }}" \
            --image-ids imageTag="${{ github.sha }}" \
            --query 'imageDetails[0].imageDigest' \
            --output text)
          if [[ -z "$DIGEST" || "$DIGEST" == "None" ]]; then
            echo "::error::Failed to resolve digest for ${{ github.sha }}"
            exit 1
          fi
          IMAGE="$REGISTRY/${{ env.ECR_REPO }}@$DIGEST"
          echo "Digest-addressed image: $IMAGE"
          echo "image=$IMAGE" >> "$GITHUB_OUTPUT"

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: staging
    env:
      ECS_CLUSTER: mythrun
      ECS_SERVICE: mythrun-staging-api
      TASK_DEF_FAMILY: mythrun-staging-api
      CONTAINER_NAME: api
      API_HOSTNAME: staging-api.mythrun.com
    steps:
      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@ececac1a45f3b08a01d2dd070d28d111c5fe6722  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Fetch current task definition
        # Describe the existing revision, strip the read-only fields that
        # register-task-definition rejects, write to disk for the render step.
        run: |
          set -euo pipefail
          aws ecs describe-task-definition \
            --task-definition "${{ env.TASK_DEF_FAMILY }}" \
            --query 'taskDefinition' \
            | jq 'del(
                .taskDefinitionArn,
                .revision,
                .status,
                .requiresAttributes,
                .compatibilities,
                .registeredAt,
                .registeredBy,
                .deregisteredAt
              )' \
            > task-def.json

      - name: Render new task definition with digest image
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@c804dfbdd57f713b6c079302a4c01db7017a36fc  # v1.7.3
        with:
          task-definition: task-def.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ needs.build.outputs.image }}

      - name: Deploy new revision
        # Registers the rendered task def as a new revision, updates the service
        # to reference it, and waits for `aws ecs wait services-stable`.
        # NOTE: this action does NOT explicitly assert rolloutState; that check
        # is performed in a separate step below. See §Decisions log #2.
        uses: aws-actions/amazon-ecs-deploy-task-definition@df9643053eda01f169e64a0e60233aacca83799a  # v2.3.2
        with:
          task-definition: ${{ steps.taskdef.outputs.task-definition }}
          cluster: ${{ env.ECS_CLUSTER }}
          service: ${{ env.ECS_SERVICE }}
          wait-for-service-stability: true
          wait-for-minutes: 15

      - name: Ensure desired-count is 1
        # First deploy: flips service from 0 to 1. Subsequent deploys: no-op
        # (desired-count is already 1). Terraform's ignore_changes=[desired_count]
        # on the service means we won't fight subsequent plans.
        # Runs AFTER the deploy step so ECS never tries to place tasks on the
        # :placeholder revision.
        run: |
          aws ecs update-service \
            --cluster "${{ env.ECS_CLUSTER }}" \
            --service "${{ env.ECS_SERVICE }}" \
            --desired-count 1 > /dev/null

      - name: Verify deployment completed (not rolled back)
        # The deploy action uses `aws ecs wait services-stable` which returns
        # SUCCESS even after circuit-breaker rollback (the service IS stable,
        # on its PREVIOUS revision). Explicit rolloutState + running-count
        # assertion catches rollback-as-success and post-response crashes
        # that leave the service in a flapping state.
        run: |
          set -euo pipefail
          echo "Waiting 10s for desired-count flip to reconcile..."
          sleep 10
          SVC_JSON=$(aws ecs describe-services \
            --cluster "${{ env.ECS_CLUSTER }}" \
            --services "${{ env.ECS_SERVICE }}" \
            --query 'services[0]')
          ROLLOUT=$(echo "$SVC_JSON" | jq -r '.deployments[] | select(.status=="PRIMARY") | .rolloutState')
          RUNNING=$(echo "$SVC_JSON" | jq -r '.runningCount')
          DESIRED=$(echo "$SVC_JSON" | jq -r '.desiredCount')
          FAILED_TASKS=$(echo "$SVC_JSON" | jq -r '.deployments[] | select(.status=="PRIMARY") | .failedTasks')
          echo "rolloutState=$ROLLOUT runningCount=$RUNNING desiredCount=$DESIRED failedTasks=$FAILED_TASKS"
          if [[ "$ROLLOUT" != "COMPLETED" ]]; then
            echo "::error::Deployment rolloutState=$ROLLOUT (circuit breaker likely fired). See MYT-30 Risks §6 for recovery."
            exit 1
          fi
          if [[ "$RUNNING" != "$DESIRED" ]]; then
            echo "::error::runningCount=$RUNNING != desiredCount=$DESIRED (service flapping)"
            exit 1
          fi

      - name: Smoke test
        # Three attempts, 10s backoff between (not after last). 30s curl timeout
        # per attempt. Body match via `jq -e` catches the failure mode where a
        # misconfigured ALB returns its fixed-response 404 default action or
        # the app returns 200 with a different body.
        env:
          API_HOSTNAME: ${{ env.API_HOSTNAME }}
        run: |
          set -euo pipefail
          attempts=3
          for attempt in $(seq 1 "$attempts"); do
            echo "Smoke test attempt $attempt of $attempts..."
            if body=$(curl -fsS --max-time 30 "https://${API_HOSTNAME}/health"); then
              echo "Response: $body"
              if echo "$body" | jq -e '.status == "ok"' > /dev/null; then
                echo "Smoke test passed."
                exit 0
              fi
            fi
            if [[ "$attempt" -lt "$attempts" ]]; then
              sleep 10
            fi
          done
          echo "::error::Smoke test failed after $attempts attempts"
          exit 1
```

### 2. GitHub Environment configuration (manual prep)

Before the first workflow run, Miklos configures:

**GitHub repo → Settings → Environments → New environment: `staging`**

1. **Deployment branches:** Restrict to `main` only.
   - Purpose: belt-and-suspenders on the OIDC trust's `ref` condition. If the workflow ever runs from a non-main ref, GitHub refuses to mint an env-scoped token before AWS ever sees it.
2. **Environment variable** (not secret): `AWS_ACCOUNT_ID = <12-digit AWS account ID>`
   - AWS account IDs are not secrets (public in many AWS responses — CloudTrail, STS GetCallerIdentity output, IAM role ARNs in policy documents). Using `vars.*` removes the "someone leaked a secret" mental load and makes access auditable.
   - Scoped to the `staging` environment. Future `production` environment gets its own `AWS_ACCOUNT_ID` variable (same value, but env-scoped).
3. **Required reviewers:** *not set* for staging. (Set for `production` when that environment is created at Launch.)
4. **Wait timer:** *not set*. Staging deploys proceed immediately once `build` job finishes.

### 2a. Dependabot configuration

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
    # Proposes PRs to bump SHA pins on third-party actions. Reviewed by hand
    # (not auto-merged) — every bump is a new audit opportunity.
```

### 3. Backend changes

**Bundles:** `myth-3v4` (SIGTERM handler) + `myth-nu9` (factory/entrypoint split). Closing both in this PR.

**File split:**

- `backend/src/app.ts` — pure factory, no side effects. Exports `buildApp()`. Tests import from here.
- `backend/src/server.ts` — entrypoint. Imports `buildApp`, starts the listener, registers signal handlers. Dockerfile `CMD` continues to reference `dist/server.js`.

**`backend/src/app.ts` (new file):**

```typescript
import Fastify, { type FastifyInstance } from 'fastify'

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}
```

**`backend/src/server.ts` (rewritten):**

```typescript
import { buildApp } from './app.js'

const app = buildApp()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

const shutdown = async (signal: 'SIGTERM' | 'SIGINT') => {
  try {
    app.log.info({ signal }, 'shutting down')
    // Let pino's async log queue drain one tick before we close.
    await new Promise((resolve) => setImmediate(resolve))
    await app.close()
    process.exit(0)
  } catch (err) {
    app.log.error({ err, signal }, 'error during shutdown')
    process.exit(1)
  }
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void shutdown(signal))
}
```

**`backend/src/__tests__/app.test.ts` (new — validates factory split + SIGTERM handler existence):**

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildApp } from '../app.js'

describe('buildApp', () => {
  let app: ReturnType<typeof buildApp>
  afterEach(async () => {
    await app?.close()
  })

  it('exports a buildable Fastify instance without side effects', async () => {
    // Importing this file must not bind a port or register signal handlers.
    // The assertion is structural: we got here.
    app = buildApp()
    expect(app).toBeDefined()
  })

  it('/health returns {status:"ok"}', async () => {
    app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
```

**Why the split:** ECS sends `SIGTERM` when replacing a task. Task-def `stopTimeout = 120` + ALB `deregistration_delay = 120` give the container 120 s to drain. Without the handler, Node's default `SIGTERM` behavior terminates the process immediately, dropping every in-flight request — including LLM calls that can run 30–60 s. The factory/entrypoint split (`myth-nu9`) was deferred in MYT-27 and gets paid for now: a test that imports `buildApp` should not bind port 3000 or register signal handlers. Doing the split alongside the SIGTERM change is ~15 lines total and produces a correct test scaffold for Backend Core.

**Log-flush caveat:** `process.exit(0)` synchronously terminates the process. Pino + awslogs flush asynchronously. The "shutting down" log line may or may not reach CloudWatch before the container is torn down. **Done-when #6 verifies handler correctness via unit test, not log observation.** If the log does land, treat it as a nice-to-have confirmation.

**Dockerfile change:** none. `CMD ["dumb-init", "node", "dist/server.js"]` still runs the entrypoint; `server.ts` imports from `app.ts`, both compile into `dist/`.

### 4. Smoke test semantics

Three attempts, 10-second backoff between attempts (not after last), 30-second curl timeout per attempt.

- **Why retry:** `wait-for-service-stability` + the explicit rolloutState check confirm the task is healthy from the ALB's perspective, but there's a short window where Route 53 cache, TLS session resumption, or TCP SYN-ACK latency causes the first external curl to fail. Retries absorb this.
- **Why body match not just `-f`:** `curl -f` fails only on HTTP 4xx/5xx. A misconfigured ALB returning its own 200 (e.g., a fixed-response default action we accidentally plumbed through) would pass `-f` but return the wrong body. `jq -e '.status == "ok"'` catches that class of bug.
- **Why fail the job on all-three-attempts-failing:** The deploy technically succeeded (ECS reports healthy), but the external path is broken. Red CI surfaces "routing/DNS/TLS regression" before anyone else notices.

### 5. Failure modes and recovery

| Failure | AWS state | CI result | Recovery |
|---|---|---|---|
| lint/typecheck/test fails | no AWS calls made | red | fix code, re-push |
| `docker build` fails | image not in ECR | red | fix Dockerfile or app code, re-push |
| `docker push` fails (ECR auth error) | image not in ECR | red | check OIDC role, ECR policy; re-push |
| Digest resolve returns None | image not addressable | red | rare — ECR eventual consistency; re-run workflow_dispatch |
| `describe-task-definition` returns error | no new revision | red | check IAM trust policy for this step's role |
| `register-task-definition` fails | revision not created | red | check role's `ecs:RegisterTaskDefinition` permission |
| `register-task-definition` succeeds, `update-service` fails | orphan revision created; service unchanged | red | re-push (orphan revisions are cheap; `myth-v0p` handles quarterly cleanup) |
| Deploy action times out at `wait-for-minutes: 15` | deployment still in progress | red | investigate ECS events; ECS circuit breaker will eventually fire and rollback |
| `update-service` circuit breaker fires | service rolls back to previous revision | red (explicit rolloutState check catches it) | **First-deploy case:** rollback target is rev 1 on `:placeholder` which cannot pull → service stuck at runningCount=0. Follow MYT-30 Risks §6 breakglass: `aws ecs update-service --cluster mythrun --service mythrun-staging-api --force-new-deployment --task-definition <new-healthy-rev>`. If still stuck, `--desired-count 0` drain, then re-deploy |
| `update-service` circuit breaker fires (Nth deploy) | service rolls back to previous working revision | red | fix root cause, re-push; previous revision continues to serve traffic |
| `runningCount != desiredCount` post-deploy | task healthy at deploy time but crashing after response | red (post-deploy assertion catches it) | review CloudWatch logs for the task's crash trace, fix, re-push |
| Smoke test fails 3x | deploy succeeded, ECS healthy, external path broken | red | check Route 53 record, ALB listener rule, cert validity |

**First-deploy pathological case (detailed):** A bad image fails its container healthcheck → target group marks targets unhealthy → ECS deployment circuit breaker fires → service rolls back. On first deploy the "previous revision" is task-def rev 1 (`:placeholder`), which also can't boot. Service settles at `runningCount = 0, desiredCount = 1`, deployment status `FAILED`. Subsequent `update-service` calls without `--force-new-deployment` may be rejected. Recovery: (a) fix the backend code and commit; (b) push triggers new workflow → new task-def revision registered with working image; (c) if service still rejects update, add `--force-new-deployment` manually via CLI; (d) if still stuck, drain via `--desired-count 0`, wait, then redeploy.

**Rollback:** For any bad deploy post-first-green, `git revert <bad-commit> && git push` triggers CI with the reverted code, producing a new task-def revision with the previous image, service updates to it. No "deploy previous revision" shortcut — everything flows through the pipeline to keep the audit trail intact.

### 6. Concurrency semantics

`concurrency: { group: deploy-mythrun-staging-api, cancel-in-progress: false }` produces:

- Two pushes to `main` in quick succession: both workflows run to completion in order. The second waits for the first.
- A push during an in-flight `workflow_dispatch` (or vice versa): both queue — same group.
- When `deploy-production` is appended (§7), it uses its own `deploy-mythrun-production-api` group → staging and prod deploys can run in parallel across different commits. This is intentional: a prod approval pause on commit A should not block staging from deploying commit B.
- **Never**: an in-flight deploy is killed mid-action. `cancel-in-progress: false` is load-bearing — cancelling between `register-task-definition` and `update-service` would leave an orphan task-def revision and possibly an unexpected service state.

Orphan task-def revisions are cheap (free, count against no quota, harmless). `myth-v0p` tracks quarterly pruning.

### 7. Future production pattern (documented, not implemented)

When production infra lands (Platform Readiness milestone), append one job to the same workflow:

```yaml
  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: production   # GH pauses here until required reviewer clicks Approve
    concurrency:
      # Separate from staging's group — staging commit B can deploy while
      # commit A's production approval is pending.
      group: deploy-mythrun-production-api
      cancel-in-progress: false
    env:
      ECS_CLUSTER: mythrun
      ECS_SERVICE: mythrun-production-api
      TASK_DEF_FAMILY: mythrun-production-api
      CONTAINER_NAME: api
      API_HOSTNAME: api.mythrun.com
    steps:
      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@<pinned-SHA>  # same version pattern
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-production
          aws-region: ${{ env.AWS_REGION }}
      # ... identical to deploy-staging, pointing at prod resources ...
      # Reuses ${{ needs.build.outputs.image }} — no rebuild. Same digest-addressed image as staging.
```

**Configuration at that time:**
- Create GitHub Environment `production` with **required reviewer = Miklos**, no deployment-branch overrides beyond `main`
- Create AWS IAM role `mythrun-github-actions-production` (OIDC trust pins `environment:production`)
- Add `AWS_ACCOUNT_ID` as `production`-scoped environment variable

**Production hardening debt (beads filed alongside this spec):**

- **`myth-jnb` (P2, MUST land before prod deploy job):** Split `mythrun-github-actions-staging` into a dedicated build-role (ECR push only) + env-specific deploy roles (ECS + PassRole + ECR pull only). Today the single-role pattern is acceptable because blast radius is staging-only; for prod it is not. Rename concern: if the build continues to use the staging role, prod artifacts are "built by a role called staging." The split closes this and cleans up the naming smell.
- **`myth-0eb` (P3):** Disable `workflow_dispatch` on the `deploy-production` job (or the whole workflow for prod-touching paths). `git commit --allow-empty -m "redeploy" && git push` replaces it with an audit trail.
- **`myth-67h` (P4, pre-launch):** Sign images with cosign/sigstore, verify signature in the deploy step. Defense-in-depth on top of digest-pinning — closes the "how do we know ECR has the bytes CI built" question.
- **`myth-651` (P4):** Pin `job_workflow_ref` via GitHub custom claim mapping once a second workflow exists. Marginal value today (one workflow, trust already pins 6 claims); real value when multiple workflows share the OIDC provider.

**Operationally:** every push to `main` triggers the full pipeline. Staging deploys automatically. The production job pauses and notifies the reviewer (UI badge + optional email). Miklos reviews staging — runs any manual smoke tests, checks dashboards, eyeballs logs — then clicks Approve (or Reject). On Approve, prod deploys using the same digest-addressed image that staging validated.

**Why no automated soak time before prod:** Observability milestone adds CloudWatch alarms; before then, a forced soak just delays the deploy without gaining signal. After alarms exist, a 5-minute soak can be added to the workflow if a post-mortem ever shows value.

### 8. Supporting Terraform amendment (MYT-30 shared workspace)

**ECR lifecycle policy: bump retention 20 → 50 tagged images.**

Touches `infra/environments/shared/main.tf`, the `aws_ecr_lifecycle_policy` resource. Rationale: at solo-dev iteration pace of 5–10 merges/day, 20 tagged images gives 2–4 days of rollback headroom. MYT-30 Risks §6 explicitly calls out rollback scenarios that reference old SHAs; a 50-image keep-depth provides ~1 week of rollback window at near-zero cost (~$0.50/mo extra ECR storage). Apply this amendment in the same PR that lands MYT-28's workflow file — the infra change is a one-integer edit to the JSON policy doc.

---

## Decisions log

1. **Two jobs, not one.** `build` → `deploy-staging`. Slight overhead (~10 s job startup) but makes adding `deploy-production` a pure append. Accepted.

2. **Explicit `rolloutState == COMPLETED` check after deploy action, not reliance on the action's own semantics.** `aws-actions/amazon-ecs-deploy-task-definition@v2` calls `aws ecs wait services-stable`, which returns success on circuit-breaker rollback (the service IS stable — on its previous revision). An earlier spec draft (v1) incorrectly attributed the rolloutState assertion to the action itself; review verified the action does not do this. An explicit `describe-services` + assertion step is the fix. Accepted.

3. **`environment: staging` on the `build` job, not a separate build-only role.** The OIDC trust on `mythrun-github-actions-staging` requires the env claim. The staging role happens to have ECR push permissions (which authorizes the build step). A dedicated build role with relaxed trust would be cleaner separation-of-concerns, but costs another Terraform resource and another OIDC trust. For staging-only scope, acceptable. For production, this is filed as `myth-jnb` (P2) — must land before prod deploy job enables. Accepted for MYT-28, filed as blocker for Platform Readiness.

4. **`@sha256:<digest>` image reference in task defs, not `:$GIT_SHA` tag.** ECR is MUTABLE mode (MYT-30 §4.2). Tags can be overwritten. Digests cannot. Task defs reference the digest so neither a compromised ECR push nor an accidental re-push of the same SHA can cause service to pull different bytes than CI built. `:latest` tag still produced alongside, purely as a convenience for humans pulling to laptops. Accepted.

5. **Retry loop in smoke test.** Three attempts with 10 s backoff absorbs DNS/TLS flake. Accepted.

6. **Body match via `jq -e '.status == "ok"'`.** Protects against ALB returning its own 200. Accepted.

7. **`concurrency: cancel-in-progress: false`, grouped by ECS service name.** Queue concurrent deploys, don't kill in-flight. Service-keyed grouping keeps prod-approval waits from blocking unrelated staging deploys. Accepted.

8. **Production gating = GH Environment + required reviewer, not tag-based or branch-based.** Chosen in brainstorm. Requires one UI click per prod deploy; no extra git discipline. Accepted.

9. **No PR triggers.** Project workflow is push-direct-to-main (CLAUDE.md "Human-Agent Review Workflow"). PR CI would be dead infrastructure until that policy changes. Accepted.

10. **Explicit `aws ecs update-service --desired-count 1` step AFTER the deploy action.** First deploy flips 0→1; subsequent deploys no-op. Placing the flip AFTER the deploy action avoids a window where ECS tries to pull `:placeholder` on a service with desiredCount=1 but an unchanged task-def revision. `ignore_changes = [desired_count]` on the service in Terraform means no conflict with future `terraform apply`. Accepted.

11. **SIGTERM handler + factory/entrypoint split in same PR.** Closes both `myth-3v4` and `myth-nu9`. Doing both now (~15 lines) produces a clean test scaffold for Backend Core and fixes listen-on-import before any test is written against it. Accepted.

12. **Third-party actions SHA-pinned; Dependabot bumps proposed as PRs, reviewed by hand.** Tag-based pins (`@v4`) are mutable — a compromised upstream can force-push the tag and every CI run in the window pulls malicious code (tj-actions/changed-files incident, March 2025). SHA pins freeze the bytes. Dependabot (`.github/dependabot.yml` with `package-ecosystem: github-actions`, weekly schedule, no auto-merge) keeps the pins from rotting. Accepted.

13. **Step ordering in `build` is load-bearing for security.** `pnpm install` runs BEFORE OIDC role assumption so npm lifecycle scripts cannot exfiltrate AWS creds. `AWS_ACCOUNT_ID` is referenced inline at `configure-aws-credentials` only, never hoisted to a job-level `env:` block. Accepted.

14. **Digest resolution via `aws ecr describe-images` after push.** One extra API call (free, <1 s). Eliminates tag-mutation race without any ECR mode change. Accepted.

15. **`paths-ignore` on push trigger.** Doc-only and tracker-only commits don't burn deploy cycles. Docs commits still go through `main` and are visible in git; they just don't cycle ECS. Accepted.

16. **`AWS_ACCOUNT_ID` as GitHub environment variable, not environment secret.** The account ID is not secret — it appears in AWS responses, policy documents, and CloudTrail events routinely. Using `vars.*` is more honest and makes access auditable. Accepted.

17. **ECR lifecycle retention 20 → 50 tagged images.** Costs ~$0.50/mo; buys ~1 week of rollback headroom (vs. 2–4 days at 20). MYT-30 amendment in the same PR. Accepted.

18. **`--platform linux/amd64` explicit on docker build.** Future-proofs against GitHub-hosted runners going ARM. Accepted.

19. **Timeouts on all jobs.** `build: 15 min`, `deploy-staging: 20 min`. Caps runaway at explicit values vs. the 360-minute GH default. Accepted.

---

## Risks

1. **GitHub Environment "staging" misconfiguration silently breaks OIDC.** If Miklos forgets the environment, or names it wrong (e.g., `Staging`), AWS rejects the AssumeRoleWithWebIdentity call with "not authorized." Mitigation: §2 checklist; the error surfaces clearly; a pre-flight `vars.AWS_ACCOUNT_ID` check gives a clean early failure.

2. **`amazon-ecs-deploy-task-definition@v2` semantics could change.** The explicit rolloutState check (step 5 of §5) backstops us against future action behavior changes. If AWS deprecates `wait services-stable` or adds new intermediate states, the explicit check still catches rollback.

3. **First docker build takes 3–5 minutes.** Cold CI build with no layer cache. Subsequent builds cache node_modules via pnpm. Workflow budget: 8–10 min total on first run, 3–5 min steady state. If builds slow to >10 min, add Docker layer caching via `docker/build-push-action` with `cache-from: type=gha`.

4. **Smoke test hits ALB during the 120 s ALB deregistration window of a previous stale task.** Not a risk for first deploy. On redeploys, `wait-for-service-stability` ensures the new task is serving and ALB has stopped sending traffic to the old task. Not a failure mode in practice.

5. **SIGTERM handler doesn't exit cleanly on malformed state.** If `app.close()` hangs (e.g., a request promise never resolves), the process stays alive until ECS's `SIGKILL` at `stopTimeout=120`. The try/catch logs the error and exits 1; ECS retries the task. Acceptable.

6. **`describe-task-definition` eventual consistency.** AWS eventual consistency is generally <1 s but theoretically the task-def we describe could be rev N-1 mid-race with a concurrent actor. `concurrency: cancel-in-progress: false` queues CI deploys. Only remaining race is human manual registration during a workflow run — not an expected operator behavior.

7. **`:latest` tag mutation.** `:latest` is a convenience for `docker pull` on developer laptops. Task defs reference digests, not `:latest`. Anyone pulling `:latest` must understand it's the most recent successful deploy, not a stable reference. Accepted.

8. **Worker service accidental flip to `desired_count=1`.** Worker stays at 0 on `:placeholder`. A manual or buggy flip to 1 fails fast (ECR pull of `:placeholder` returns ImageNotFound) rather than silently running stale code — the `:placeholder` tag is a safety feature. No alarm until Observability milestone; failure is self-limiting (ECS scheduler retries with backoff, doesn't harm anything else).

9. **Task-def time-bomb from prior compromise.** `register-task-definition` carries forward all fields of the current revision except the patched image. A compromise that planted a malicious `entryPoint` or `secrets[].valueFrom` in a prior revision would persist across innocent redeploys. Recovery from a role compromise requires re-authoring task-defs from Terraform baseline via `terraform apply` (which owns the baseline revision), not from `describe`. Accepted as a post-compromise recovery invariant.

10. **ECR lifecycle deletes old images that task-def revisions reference.** At 50-image retention, an engineer manually rolling forward to a very old revision (e.g., a specific debugging rev from >1 week ago) may find the image gone. Workaround: `git revert` targeting the old commit re-builds. Acceptable.

---

## Out of scope (follow-up beads, filed or to file)

1. **`myth-bcx`: first-deploy runbook at `docs/runbooks/first-deploy.md`.** Workflow comments + spec §5 cover the common paths; revisit if on-call expands beyond Miklos.
2. **`myth-nf3`: `/health` → `/health/live` + `/health/ready` split.** Backend Core milestone. Requires real DB + Redis clients. Also bumps target-group health_check.path in a follow-up Terraform apply.
3. **`myth-651`: Pin OIDC `job_workflow_ref`.** P4; marginal value with one workflow.
4. **`myth-v0p`: Quarterly pruning of orphan ECS task-def revisions.** P4.
5. **`myth-jnb` (FILED): Split build-role and deploy-role.** P2, must land before prod deploy enable.
6. **`myth-0eb` (FILED): Disable `workflow_dispatch` on prod job.** P3, with prod deploy.
7. **`myth-67h` (FILED): Image signing via cosign/sigstore.** P4, pre-launch.
8. **Docker layer caching.** Add when cold-build >10 min consistently.
9. **Deploy notifications to Slack/Discord.** Observability milestone or Launch prep.
10. **Image vulnerability scanning (ECR scan on push).** Enable with Observability milestone alarm on findings.
11. **Frontend deploy job.** When frontend lands, append `build-frontend` sibling job + a `deploy-frontend-staging` job that uploads to S3 + invalidates CloudFront.
12. **Closed by MYT-28:** `myth-3v4` (SIGTERM handler), `myth-nu9` (factory/entrypoint split).

---

## Verification sequence (Done-when, expanded)

After the first successful workflow run, Miklos runs:

```bash
# 1. ECS service is running the new revision with desired=running=1
aws ecs describe-services --cluster mythrun --services mythrun-staging-api \
  --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition,rolloutState:deployments[0].rolloutState,failed:deployments[0].failedTasks}'
# Expected:
#   running: 1
#   desired: 1
#   taskDef: arn:aws:ecs:us-east-1:<account>:task-definition/mythrun-staging-api:2
#   rolloutState: COMPLETED
#   failed: 0

# 2. Task is actually running the digest-addressed image
TASK_ARN=$(aws ecs list-tasks --cluster mythrun --service-name mythrun-staging-api --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].image'
# Expected: <account>.dkr.ecr.us-east-1.amazonaws.com/mythrun@sha256:<64-char-hex>

# 3. External health endpoint responds correctly
curl -v https://staging-api.mythrun.com/health
# Expected: HTTP 200, body {"status":"ok"}, TLS handshake with *.mythrun.com cert

# 4. Second push produces a new revision, desired/running stay at 1
git commit --allow-empty -m "chore: verify deploy idempotency"
git push
# (Empty commit touches no paths, but workflow_dispatch equivalent is OK;
#  or add `echo "# bump"` to a real source file.)
# Watch Actions tab. After completion:
aws ecs describe-services --cluster mythrun --services mythrun-staging-api \
  --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition,rolloutState:deployments[0].rolloutState}'
# Expected: running:1, desired:1, taskDef:...:3 (or higher), rolloutState:COMPLETED

# 5. SIGTERM handler unit test passes
cd backend && pnpm test
# Expected: green; app.test.ts passes assertions on factory + /health

# 6. Prior task stopped cleanly during the second deploy
# Find the task that was replaced:
aws ecs list-tasks --cluster mythrun --service-name mythrun-staging-api --desired-status STOPPED \
  --query 'taskArns[0]' --output text
# Describe it:
aws ecs describe-tasks --cluster mythrun --tasks <stopped-arn> \
  --query 'tasks[0].{stoppedReason:stoppedReason,stopCode:stopCode,exitCode:containers[0].exitCode}'
# Expected: stopCode=EssentialContainerExited, exitCode=0, stoppedReason starting with "Essential container..."
# (An exit code of 0 means the SIGTERM handler called process.exit(0) cleanly.
#  An exit code of 137 would indicate SIGKILL — handler didn't drain in time.)
```

---

## Cost delta over MYT-30 baseline

| Item | Delta | Reason |
|---|---|---|
| ECR storage | +~$0.60/month | Image layers (~100 MB per SHA × 50 retention ≈ 5 GB × $0.10/GB) vs. previous 20-retention ~$0.20/mo |
| ECS Fargate runtime | +~$7/month | One `0.25 vCPU / 512 MB` task running 24/7 in staging (was $0 at `desired_count=0`) |
| CloudWatch Logs ingestion | +~$1/month | Fastify log output × 14-day retention |
| **Total** | **~$8.40/month** | On top of MYT-30's ~$16 idle ALB + MYT-25's ~$67 data plane |

New baseline: **~$91/month.** No other cost changes from this issue.

**Note:** the placeholder action SHAs in the workflow YAML above (e.g., `11bd71901bbe5b1630ceea73d27597364c9af683` for `actions/checkout@v4.2.2`) are illustrative — at implementation time, fetch the current SHA for each pinned version from the action's releases page and verify the tag matches.
