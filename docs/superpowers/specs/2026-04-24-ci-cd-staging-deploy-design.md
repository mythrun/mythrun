# CI/CD + First Staging Deploy Design

**Linear issue:** MYT-28 (Ops Foundation milestone, Urgent, due 2026-04-27)
**Parent specs:** `docs/specs/2026-04-20-setup-guide.md` (Phase 5.3), `docs/specs/2026-04-10-infrastructure-devops.md`, `docs/specs/2026-04-07-week0-ops-foundation.md`
**Prior issue:** MYT-30 (serving infra — ECR repo, ECS cluster + services at `desired_count=0` on `:placeholder`, ALB, OIDC provider, `mythrun-github-actions-staging` role with 6-condition trust)
**Version:** v3 (post two rounds of blind agent-team review: round 1 LeBron/Curry/Kobe/Giannis, round 2 Jordan/Duncan/Jokić/Shaq, 2026-04-24)
**Status:** Ready for implementation

---

## Goal

Stand up a GitHub Actions workflow that builds the backend image, pushes it to ECR, and flips the staging ECS service from `desired_count=0` on `:placeholder` to `desired_count=1` on the just-built `@sha256:<digest>`-addressed image — on every push to `main` that touches code. This is the Ops Foundation ship gate: when it works, a code change flows from `git push` to a healthy staging container in one step.

## Done when

1. A push to `main` (touching non-doc paths) triggers `.github/workflows/deploy.yml` and the workflow succeeds end-to-end
2. `aws ecs describe-services --cluster mythrun --services mythrun-staging-api --query 'services[0]'` returns `runningCount = 1, desiredCount = 1` on a task-def revision whose image URI is of the form `<account>.dkr.ecr.us-east-1.amazonaws.com/mythrun@sha256:<digest>`
3. `curl -fsS https://staging-api.mythrun.com/health` returns HTTP 200 with body `{"status":"ok"}`
4. The `deployments[0].rolloutState` on the staging service is `COMPLETED` — verified by an explicit post-deploy check step with retry-until-timeout (the deploy action does not check this automatically; `aws ecs wait services-stable` returns success on circuit-breaker rollback, so we assert it directly)
5. A second push (any non-doc commit) re-runs the workflow in under 10 minutes and produces a new task-def revision on the staging service. **Revision count ≥ prior+1** (may skip numbers if a previous deploy failed between `RegisterTaskDefinition` and `UpdateService`, leaving an orphan revision — accepted behavior)
6. **SIGTERM handler verification:** (a) unit test in `backend/src/__tests__/shutdown.test.ts` asserts `createShutdown(app)` returns a handler that calls `app.close()` before `process.exit(0)` (pure-function test, no process mocking); (b) `aws ecs describe-tasks --cluster mythrun --tasks <prior-task-arn>` on the task replaced during the second deploy shows `exitCode = 0` (confirms the handler ran to clean exit, not a SIGKILL at `stopTimeout`)
7. **Placeholder-safety invariant:** `aws ecr describe-images --repository-name mythrun --image-ids imageTag=placeholder` returns `ImageNotFoundException`. The `:placeholder` tag is a poison pill — if a task-def pointing at `:placeholder` ever boots (e.g., accidental `update-service --desired-count 1` on the worker), the pull must fail fast. Verified once at implementation; re-checked in observability alarms at Observability milestone.

## What this task does NOT do

- **Production deploy job.** Production infra doesn't exist yet (Platform Readiness milestone). The workflow is structured so adding it later is a pure-append (one new job with `needs: deploy-staging`, `environment: production`, reusing the `build` job's image output). Shape + hardening debt documented in §7.
- **Worker service deploy.** The staging worker service exists at `desired_count=0` on `:placeholder`. No `dist/worker.js` exists (Prep Pipeline milestone). The workflow ignores the worker service — it stays at 0 via MYT-30's `ignore_changes = [desired_count, task_definition]`. The `:placeholder` image tag is itself a safety feature: a manual flip of worker `desired_count` fails fast at ECR pull rather than running stale/wrong code.
- **Runbook document.** `myth-bcx` (first-deploy runbook) deferred. The workflow comments + §5 cover common paths; MYT-30 Risks §6 covers first-deploy circuit-breaker recovery.
- **PR-triggered CI.** Project pushes direct to `main` (CLAUDE.md). No PR flow, so no PR triggers.
- **`/health` split.** `myth-nf3`, Backend Core.
- **CloudWatch alarms on deploy failures.** Observability milestone.
- **Formalized rollback tooling.** Manual: `git revert <bad> && git push`. See MYT-30 Risks §6 for first-deploy stuck-state breakglass.
- **Image signing (cosign/sigstore).** `myth-67h` (P4, pre-launch).
- **Docker layer caching via buildx.** Add when cold-build >10 min consistently.
- **Frontend deploy.** When frontend lands, sibling `build-frontend` + `deploy-frontend-staging` jobs.
- **VPC interface endpoints for ECR + CloudWatch log retention + billing alarms.** Filed as `myth-sua` + `myth-57l` (P3, with Observability milestone).

---

## Architecture summary

Single workflow file at `.github/workflows/deploy.yml`. Two jobs in one pipeline:

```
push to main (code paths only)         workflow_dispatch
         ↓                                   ↓
┌─────────────────────────────────────────────────────────────────┐
│ build  (timeout-minutes: 15)                                    │
│   environment: staging  (OIDC trust requires env claim)         │
│   - checkout + pnpm install (scoped --filter @mythrun/backend...)│
│   - pnpm lint / typecheck / test (backend only)                 │
│   - pre-flight: assert vars.AWS_ACCOUNT_ID is set               │
│   - assume mythrun-github-actions-staging via OIDC              │
│   - ecr-login                                                   │
│   - docker build (FROM ECR pull-through-cached node:24-alpine,  │
│       --platform linux/amd64 + OCI labels)                      │
│   - docker push :$GIT_SHA + :latest                             │
│   - resolve image digest via `docker inspect`'s RepoDigests     │
│     (local, deterministic, no ECR API call — closes the TOCTOU  │
│     between push and describe)                                  │
│   - outputs: image = <ecr>/mythrun@sha256:<digest>              │
└─────────────────────────────────────────────────────────────────┘
         ↓
┌─────────────────────────────────────────────────────────────────┐
│ deploy-staging  (needs: build, timeout-minutes: 20)             │
│   environment: staging                                          │
│   - assume mythrun-github-actions-staging via OIDC              │
│   - aws ecs describe-task-definition → JSON (no pre-strip —     │
│     render-action strips read-only fields itself)               │
│   - amazon-ecs-render-task-definition (patch image → digest)    │
│   - amazon-ecs-deploy-task-definition (register + update,       │
│     wait-for-service-stability up to 15 min)                    │
│   - aws ecs update-service --desired-count 1 (first deploy:     │
│     flips 0→1; subsequent: no-op)                               │
│   - post-deploy assertion: poll rolloutState up to 2 min, must  │
│     reach COMPLETED AND runningCount == desiredCount == 1       │
│   - smoke test: curl /health, 3 retries, jq body match          │
└─────────────────────────────────────────────────────────────────┘
         ↓
        ✅ staging is live on the digest-addressed image
```

### Step-ordering notes (load-bearing)

1. **`pnpm install` runs BEFORE OIDC role assumption.** npm lifecycle scripts have access to `process.env` during install. By the time install completes, no AWS credentials exist — a compromised dependency cannot exfiltrate. **Do not hoist `AWS_ACCOUNT_ID` into job-level `env:`; reference it inline on `configure-aws-credentials` only.**

2. **Deploy action runs BEFORE `update-service --desired-count 1`.** If desired-count is flipped first, ECS sees `desiredCount=1` on a service still pinned to the `:placeholder` task-def revision, attempts to pull `:placeholder`, and logs placement failures until the deploy step updates the revision. Reversed: register new revision → update service to point at it → then flip desired-count.

3. **Digest resolution runs AFTER `docker push`, BEFORE render-task-definition.** Uses `docker inspect --format='{{index .RepoDigests 0}}'` on the local image — this reads docker's in-memory record of the digest the registry returned on the just-completed push. Deterministic, authoritative, requires no ECR API call, and closes the TOCTOU race that existed in v2 where an attacker with ECR push could re-tag between our push and our `describe-images`.

### ECS shutdown timing (corrected 240s mental model)

ECS replacement sequence on a redeploy:

1. New task registered + enters PROVISIONING (pull image, attach ENI)
2. New task RUNNING, registered with target group, enters healthcheck grace
3. Once new task reports healthy, old task enters deregistration:
   - ALB target-group deregistration: up to **120s** (`deregistration_delay = 120`), during which ALB drains in-flight requests to the old target
   - After deregistration completes, ECS sends SIGTERM to the old container
   - Container has up to **120s** (`stopTimeout = 120`) to drain via the SIGTERM handler before SIGKILL

**Worst-case shutdown is 240s**, not 120s — the two windows compose sequentially, not overlap. A 30–60s LLM call that arrived right at deregistration-start has ~120s of ALB-drain window PLUS up to ~120s of SIGTERM drain to complete. Plenty of headroom. `myth-nu9` (factory split) and the SIGTERM handler ensure we use both windows; the default Node behavior would skip both.

### Why the register-then-update-then-flip pattern

`aws ecs update-service --force-new-deployment` re-pulls the image but **does not switch task-definition revisions**. Terraform registered revision 1 pointing at `:placeholder`. If CI only calls `update-service`, the service keeps using revision 1 and pulls `:placeholder` (a literal tag name that does not exist in ECR). Task fails to start.

The correct sequence:

1. **describe** current task def
2. **render** — patch `containerDefinitions[0].image` to the new digest URI (render-action handles read-only field stripping internally)
3. **register** new revision (via deploy-action)
4. **update-service** with `--task-definition mythrun-staging-api:N+1` (via deploy-action)
5. **flip desired-count** to 1 (first deploy only)
6. **poll rolloutState** until COMPLETED — the deploy action's `wait-for-service-stability` uses `aws ecs wait services-stable` under the hood, which returns success even after circuit-breaker rollback (the service IS stable, on its previous revision). Without an explicit assertion, a rollback silently presents as green CI.

---

## Detailed design

### 1. Workflow file (`.github/workflows/deploy.yml`)

**Action SHA-pinning:** All third-party action references use SHA-pinning with the version as a trailing comment (Decisions log #12). Dependabot (`.github/dependabot.yml`, `package-ecosystem: github-actions`, weekly, no auto-merge) proposes bump PRs.

**Pre-implementation checklist:**
- Fetch current SHA for each `@<version>` from the action's releases page and replace the placeholders below
- Confirm `.npmrc`, `.dockerignore`, `backend/Dockerfile`, `backend/package.json`, `.nvmrc` all exist
- Confirm the staging workspace Terraform has the MYT-28 amendments applied (§8)

```yaml
name: Deploy

on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '.beads/**'
      - '**/*.md'
      - 'wiki/**'
      - '.github/wiki/**'
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  # Group by target ECS service, not by ref. Future branch-based preview
  # deploys or the prod append (§7) will not share a group with staging.
  group: deploy-mythrun-staging-api
  cancel-in-progress: false

env:
  AWS_REGION: us-east-1
  ECR_REPO: mythrun
  # Pull-through cache base-image reference. See §8 Terraform amendments
  # for the aws_ecr_pull_through_cache_rule that connects this prefix to
  # the Docker Hub upstream.
  BASE_IMAGE_REF: docker-hub/library/node:24-alpine

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: staging
    outputs:
      image: ${{ steps.digest.outputs.image }}
    steps:
      - uses: actions/checkout@<sha>  # v4.2.2

      - uses: pnpm/action-setup@<sha>  # v4.1.0

      - uses: actions/setup-node@<sha>  # v6.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      # Scope install to backend + transitive workspace deps. Prevents
      # breakage in @mythrun/wiki or sibling workspaces from red-lighting
      # a backend deploy. (Note: --frozen-lockfile still validates the full
      # lockfile; this limits LINKING, not resolution.)
      - run: pnpm install --frozen-lockfile --filter @mythrun/backend...

      - run: pnpm --filter @mythrun/backend lint
      - run: pnpm --filter @mythrun/backend typecheck
      - run: pnpm --filter @mythrun/backend test

      - name: Pre-flight — verify required vars are set
        run: |
          if [[ -z "${{ vars.AWS_ACCOUNT_ID }}" ]]; then
            echo "::error::vars.AWS_ACCOUNT_ID is not set. Configure at Settings → Environments → staging → Environment variables."
            exit 1
          fi

      - name: Assume AWS role via OIDC
        # Reference vars.AWS_ACCOUNT_ID inline — do NOT hoist to job-level env:.
        uses: aws-actions/configure-aws-credentials@<sha>  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@<sha>  # v2.0.1

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
            --build-arg BASE_IMAGE_REGISTRY="$REGISTRY" \
            --label "org.opencontainers.image.source=https://github.com/mythrun/mythrun" \
            --label "org.opencontainers.image.revision=${{ github.sha }}" \
            --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            --label "com.mythrun.workflow_run=${{ github.run_id }}" \
            --label "com.mythrun.workflow_run_url=${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
            -t "$IMAGE_URI" -t "$LATEST_URI" \
            -f backend/Dockerfile .
          docker push "$IMAGE_URI"
          docker push "$LATEST_URI"

      - name: Resolve image digest (local inspect, no ECR API call)
        id: digest
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
        run: |
          set -euo pipefail
          IMAGE_URI="$REGISTRY/${{ env.ECR_REPO }}:${{ github.sha }}"
          # RepoDigests is populated by docker after a successful push — it
          # contains <registry>/<repo>@sha256:<digest>. This reads docker's
          # in-memory record of what WE just pushed, bypassing any window
          # in which ECR's tag→image mapping could be mutated by an
          # attacker with ECR push (see Decisions log #4).
          DIGEST_REF=$(docker inspect --format='{{index .RepoDigests 0}}' "$IMAGE_URI")
          if [[ -z "$DIGEST_REF" || "$DIGEST_REF" != *"@sha256:"* ]]; then
            echo "::error::Failed to resolve digest-addressed URI from docker inspect"
            exit 1
          fi
          echo "Digest-addressed image: $DIGEST_REF"
          echo "image=$DIGEST_REF" >> "$GITHUB_OUTPUT"
          echo "::notice::Deployed image digest: $DIGEST_REF"

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
        uses: aws-actions/configure-aws-credentials@<sha>  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Fetch current task definition
        # The render-task-definition action strips read-only fields
        # internally, so no jq 'del(...)' pre-strip is needed. Keeping
        # a second stripper would create two sources of truth about
        # "what's read-only" and risk divergence as AWS adds fields.
        run: |
          set -euo pipefail
          aws ecs describe-task-definition \
            --task-definition "${{ env.TASK_DEF_FAMILY }}" \
            --query 'taskDefinition' \
            > task-def.json

      - name: Render new task definition with digest image
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@<sha>  # v1.7.3
        with:
          task-definition: task-def.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ needs.build.outputs.image }}

      - name: Deploy new revision
        # Registers the rendered task def as a new revision, updates the
        # service to reference it, and waits for `services-stable`.
        # NOTE: does NOT assert rolloutState — see the separate poll step.
        uses: aws-actions/amazon-ecs-deploy-task-definition@<sha>  # v2.3.2
        with:
          task-definition: ${{ steps.taskdef.outputs.task-definition }}
          cluster: ${{ env.ECS_CLUSTER }}
          service: ${{ env.ECS_SERVICE }}
          wait-for-service-stability: true
          wait-for-minutes: 15

      - name: Ensure desired-count is 1
        # First deploy: flips 0 → 1. Subsequent: no-op. Runs AFTER the deploy
        # action so ECS never tries to place on the :placeholder revision.
        run: |
          aws ecs update-service \
            --cluster "${{ env.ECS_CLUSTER }}" \
            --service "${{ env.ECS_SERVICE }}" \
            --desired-count 1 > /dev/null

      - name: Verify deployment completed (poll rolloutState)
        # `aws ecs wait services-stable` returns SUCCESS even after
        # circuit-breaker rollback. Poll rolloutState with timeout to catch
        # rollback-as-success. The desired-count flip above can take a few
        # seconds to reconcile through the scheduler — 12 attempts × 10s
        # gives a 2-min window.
        run: |
          set -euo pipefail
          max_attempts=12
          for attempt in $(seq 1 "$max_attempts"); do
            SVC_JSON=$(aws ecs describe-services \
              --cluster "${{ env.ECS_CLUSTER }}" \
              --services "${{ env.ECS_SERVICE }}" \
              --query 'services[0]')
            ROLLOUT=$(echo "$SVC_JSON" | jq -r '.deployments[] | select(.status=="PRIMARY") | .rolloutState')
            RUNNING=$(echo "$SVC_JSON" | jq -r '.runningCount')
            DESIRED=$(echo "$SVC_JSON" | jq -r '.desiredCount')
            FAILED=$(echo "$SVC_JSON" | jq -r '.deployments[] | select(.status=="PRIMARY") | .failedTasks')
            echo "attempt=$attempt rolloutState=$ROLLOUT running=$RUNNING desired=$DESIRED failed=$FAILED"

            # Fast-fail on FAILED — no point polling if circuit breaker already fired.
            if [[ "$ROLLOUT" == "FAILED" ]]; then
              echo "::error::Deployment FAILED (circuit breaker). See MYT-30 Risks §6 for recovery."
              exit 1
            fi

            # Success: COMPLETED + counts match + no failed tasks.
            if [[ "$ROLLOUT" == "COMPLETED" && "$RUNNING" == "$DESIRED" && "$FAILED" == "0" ]]; then
              echo "Deployment verified."
              exit 0
            fi

            if [[ "$attempt" -lt "$max_attempts" ]]; then
              sleep 10
            fi
          done
          echo "::error::Deployment did not reach COMPLETED within 2 min (last rolloutState=$ROLLOUT, running=$RUNNING/$DESIRED)"
          exit 1

      - name: Smoke test
        env:
          API_HOSTNAME: ${{ env.API_HOSTNAME }}
        run: |
          set -euo pipefail
          attempts=3
          for attempt in $(seq 1 "$attempts"); do
            echo "Smoke test attempt $attempt of $attempts..."
            # jq failure is guarded by the enclosing 'if' — do not hoist out.
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

**Settings → Environments → New environment: `staging`**

1. **Deployment branches:** `main` only.
2. **Environment variable** (not secret): `AWS_ACCOUNT_ID = <12-digit AWS account ID>`. Account IDs aren't secret — using `vars.*` removes them from the leaked-secret mental model.
3. **Required reviewers:** not set for staging.
4. **Wait timer:** not set.

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
```

### 3. Backend changes

**Bundles `myth-3v4` (SIGTERM handler) + `myth-nu9` (factory/entrypoint split).** Both close with this PR.

**File layout:**

- `backend/src/app.ts` — pure factory + pure `createShutdown` function. No side effects on import. Tests import from here.
- `backend/src/server.ts` — entrypoint. Imports `buildApp` + `createShutdown`, starts listener, registers signal handlers. Dockerfile `CMD` continues to reference `dist/server.js`.
- `backend/src/__tests__/app.test.ts` — tests the factory: `/health` returns `{status:"ok"}`, import is side-effect-free.
- `backend/src/__tests__/shutdown.test.ts` — tests `createShutdown` as a pure function: invoking the returned handler calls `app.close()` and then `process.exit(0)` in that order.

**`backend/src/app.ts` (new):**

```typescript
import Fastify, { type FastifyInstance } from 'fastify'

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}

export type ShutdownSignal = 'SIGTERM' | 'SIGINT'

export type ShutdownHandler = (signal: ShutdownSignal) => Promise<void>

export const createShutdown = (app: FastifyInstance): ShutdownHandler => {
  return async (signal) => {
    try {
      app.log.info({ signal }, 'shutting down')
      // Yield once so pino's async log queue drains before close.
      await new Promise<void>((resolve) => setImmediate(resolve))
      await app.close()
      process.exit(0)
    } catch (err) {
      app.log.error({ err, signal }, 'error during shutdown')
      process.exit(1)
    }
  }
}
```

**`backend/src/server.ts` (rewritten):**

```typescript
import { buildApp, createShutdown } from './app.js'

const app = buildApp()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

const handleShutdown = createShutdown(app)
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => void handleShutdown(signal))
}
```

**`backend/src/__tests__/shutdown.test.ts` (new — real test for Done-when #6(a)):**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createShutdown, buildApp } from '../app.js'

describe('createShutdown', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    // Intercept process.exit so the test runner doesn't actually exit.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it('calls app.close before process.exit(0) on clean shutdown', async () => {
    const app = buildApp()
    const callOrder: string[] = []

    const closeSpy = vi.spyOn(app, 'close').mockImplementation(async () => {
      callOrder.push('close')
    })
    exitSpy.mockImplementation((code) => {
      callOrder.push(`exit:${code}`)
      return undefined as never
    })

    const handler = createShutdown(app)
    await handler('SIGTERM')

    expect(closeSpy).toHaveBeenCalledOnce()
    expect(exitSpy).toHaveBeenCalledWith(0)
    expect(callOrder).toEqual(['close', 'exit:0'])
  })

  it('exits with code 1 if app.close throws', async () => {
    const app = buildApp()
    vi.spyOn(app, 'close').mockRejectedValueOnce(new Error('boom'))

    const handler = createShutdown(app)
    await handler('SIGTERM')

    expect(exitSpy).toHaveBeenCalledWith(1)
  })
})
```

**`backend/src/__tests__/app.test.ts` (new — factory-only):**

```typescript
import { describe, it, expect, afterEach } from 'vitest'
import { buildApp } from '../app.js'

describe('buildApp', () => {
  let app: ReturnType<typeof buildApp>
  afterEach(async () => {
    await app?.close()
  })

  it('builds a Fastify instance with no side effects on import', async () => {
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

**Dockerfile change:** one line, to reference the pull-through-cached base image:

```dockerfile
ARG BASE_IMAGE_REGISTRY
FROM ${BASE_IMAGE_REGISTRY:-docker.io}/docker-hub/library/node:24-alpine AS builder
# ... rest unchanged
```

When `BASE_IMAGE_REGISTRY` is the ECR registry host (passed from the workflow via `--build-arg`), pulls go through the ECR pull-through cache. The `:-docker.io` fallback means local `docker build` without the arg still works by pulling directly from Docker Hub — useful for local development. Note: `docker.io/docker-hub/library/node:24-alpine` is not a real Docker Hub path; the fallback is aspirational. In practice local dev users should `docker build --build-arg BASE_IMAGE_REGISTRY=docker.io/library -f backend/Dockerfile .` if they want to bypass ECR, accepting that the Dockerfile path assumes the `docker-hub/library/` prefix. **Simplification option:** have a `Dockerfile.ci` for CI (hardcoded ECR path) and keep `Dockerfile` pointing at `docker.io/library/node:24-alpine` for local use. Preferred if pull-through-cache Dockerfile becomes awkward.

**Dockerfile CMD:** unchanged. `CMD ["dumb-init", "node", "dist/server.js"]` still runs the entrypoint; `server.ts` now imports `app.ts`, and `tsc` compiles both to `dist/`.

### 4. Smoke test semantics

Three attempts, 10-second backoff between (not after last), 30-second curl timeout per attempt. Body match via `jq -e '.status == "ok"'` — forgiving of additional response fields (`{"status":"ok","version":"1.2.3"}` still passes) but catches ALB-default-200 or wrong-body failures.

### 5. Failure modes and recovery

| Failure | AWS state | CI result | Recovery |
|---|---|---|---|
| lint/typecheck/test fails | no AWS calls | red | fix code, re-push |
| `docker build` fails | no image | red | fix Dockerfile or app code |
| Pull-through cache miss fails | no base image pulled | red | check pull-through rule + IAM; usually transient (Docker Hub availability) |
| `docker push` fails | no image in ECR | red | check OIDC role, ECR policy |
| `docker inspect` returns empty RepoDigests | digest not captured | red | rare — re-run; docker daemon restart issue |
| `describe-task-definition` errors | no new revision | red | check IAM trust |
| `register-task-definition` fails | no new revision | red | check role's `ecs:RegisterTaskDefinition` |
| Register succeeds, `update-service` fails | orphan revision | red | re-push (orphan is cheap; `myth-v0p` prunes quarterly) |
| Deploy action times out at 15 min | deploy in-flight | red | check ECS events; circuit breaker will fire |
| Circuit breaker fires (Nth deploy) | rolled back to prior working rev | red (rolloutState poll catches it) | fix root cause, re-push |
| Circuit breaker fires (FIRST deploy) | rolled back to rev 1 `:placeholder` which can't pull → service stuck at running=0 | red | **See MYT-30 Risks §6:** `aws ecs update-service --cluster mythrun --service mythrun-staging-api --force-new-deployment --task-definition <new-healthy-rev>`. If still stuck: `--desired-count 0` drain, then re-deploy |
| `rolloutState` poll times out at 2 min (not FAILED, not COMPLETED) | deployment still reconciling | red | investigate — network partition, scheduler backup, or a slow-to-converge health check |
| Smoke test fails 3x, ECS healthy | deploy succeeded, external path broken | red | Route 53 record, ALB listener rule, cert validity |
| Smoke test fails after `/health` splits to DB/Redis (`myth-nf3`) | healthy targets are actually degraded | red | backend dependency check surface — triage upstream failure |

**ECR retention math:** with 50-image lifecycle retention minus 2 permanent tags (`:latest`, `:placeholder`) = 48 git-SHA slots. At 10 merges/day: ~5 days rollback headroom. At 5 merges/day: ~10 days. `myth-v0p` quarterly pruning handles task-def-revision accumulation separately.

### 6. Concurrency semantics

`concurrency: { group: deploy-mythrun-staging-api, cancel-in-progress: false }`:

- Two pushes to `main` in quick succession: both workflows run in order, second waits for first.
- Push during `workflow_dispatch` (or vice versa): both queue, same group.
- When `deploy-production` is appended (§7), it uses its own `deploy-mythrun-production-api` group → staging commit B can deploy while production commit A awaits approval.
- **Never:** an in-flight deploy is killed mid-action.

**Team-scale note:** at 5 engineers pushing concurrently, queue depth 5 × 8 min/deploy = ~40 min from last merge to last deploy live. Acceptable for staging; at launch, if observed cadence frequently produces obsolete queued deploys (A queued behind B where B supersedes A), consider `cancel-in-progress: true` for staging only. Prod stays `false`.

**Orphan task-def revisions:** harmless, free, count against no quota. Every in-flight failure between `register` and `update-service` creates one. `myth-v0p` tracks quarterly pruning.

### 7. Future production pattern (documented, not implemented)

```yaml
  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: production   # GH pauses here until required reviewer approves
    concurrency:
      group: deploy-mythrun-production-api
      cancel-in-progress: false
    env:
      ECS_CLUSTER: mythrun
      ECS_SERVICE: mythrun-production-api
      TASK_DEF_FAMILY: mythrun-production-api
      CONTAINER_NAME: api
      API_HOSTNAME: api.mythrun.com
    steps:
      - uses: aws-actions/configure-aws-credentials@<sha>  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-production
          aws-region: ${{ env.AWS_REGION }}
      # ... identical to deploy-staging, pointing at prod resources ...
      # Reuses ${{ needs.build.outputs.image }} — same digest-addressed image as staging.
```

**Configuration at launch time:** create GH Environment `production` with required reviewer = Miklos, `main`-only branches, `AWS_ACCOUNT_ID` as prod-scoped env variable.

**Production hardening debt (beads filed):**

- **`myth-jnb` (P2, MUST precede prod deploy):** split `mythrun-github-actions-staging` into build-role (ECR push only) + env-specific deploy roles (ECS + PassRole + ECR pull only).
- **`myth-0eb` (P3):** disable `workflow_dispatch` on `deploy-production` job.
- **`myth-67h` (P4, pre-launch):** image signing via cosign/sigstore, verify at deploy.
- **`myth-651` (P4):** pin `job_workflow_ref` via GitHub custom claim mapping.
- **`myth-sua` (P3):** VPC interface endpoints for ECR + S3 gateway endpoint.
- **`myth-57l` (P3):** CloudWatch log retention audit + account-wide billing alarms.

### 8. Supporting Terraform amendments (bundled with MYT-28 PR)

Three changes to the infra workspaces land alongside the workflow file:

**(a) `infra/modules/serving/main.tf` — add `create_before_destroy` lifecycle to both task definitions.**

On both `aws_ecs_task_definition.api` (around line 197) and `aws_ecs_task_definition.worker` (around line 236), add:

```hcl
lifecycle {
  create_before_destroy = true
}
```

MYT-30's original comment at lines 114-119 argued a lifecycle block was "cosmetic + misleading." Round 2 review (Duncan) demonstrated it's load-bearing: changing any task-def argument in the HCL (env var, memory, log group) triggers a destroy-and-replace. Without `create_before_destroy`, Terraform deregisters the current tracked revision *before* registering the replacement — a race during which an ECS scheduler action could find a missing task-def. With the block, the new revision is registered first, state re-points to it, then old revision deregisters. Update the inline comment in MYT-30's serving module to reflect this.

**(b) `infra/environments/shared/main.tf` — ECR pull-through cache for Docker Hub.**

Add:

```hcl
# Pull-through cache so `docker pull` of base images (Node, Alpine, etc.)
# goes through our ECR instead of Docker Hub directly. Avoids the 100-pull/
# 6h anonymous rate limit that GitHub-hosted runner IP pools can trigger
# at team scale, and improves cold-start latency by keeping pulls in-region.
resource "aws_ecr_pull_through_cache_rule" "docker_hub" {
  ecr_repository_prefix = "docker-hub"
  upstream_registry_url = "registry-1.docker.io"
}
```

Cache repos are auto-created on first pull (e.g., `docker-hub/library/node`). The IAM role (staging workspace) needs two additional actions (see (c)).

**(c) `infra/environments/staging/main.tf` — expand ECR IAM permissions for pull-through cache.**

On `data.aws_iam_policy_document.gh_actions_staging`'s ECR statement (around lines 190-203), add `ecr:CreateRepository` and `ecr:BatchImportUpstreamImage` scoped to the pull-through repo prefix:

```hcl
statement {
  actions = [
    "ecr:CreateRepository",
    "ecr:BatchImportUpstreamImage",
  ]
  resources = [
    "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/docker-hub/*",
  ]
}
```

Plus extend the existing ECR pull statement's resources to include the cache-repo prefix:

```hcl
resources = [
  "arn:aws:ecr:us-east-1:${account}:repository/mythrun",
  "arn:aws:ecr:us-east-1:${account}:repository/docker-hub/*",  # ADDED
]
```

Note: v2's proposed `ecr:DescribeImages` addition is **no longer needed** — the workflow now resolves digests via `docker inspect` on the local image rather than `aws ecr describe-images`. This dissolves Duncan (round 2) B1.

**(d) `infra/environments/shared/main.tf` — bump ECR retention 20 → 50.**

On `aws_ecr_lifecycle_policy.mythrun` (around line 71), change `countNumber = 20` to `countNumber = 50`. Optional refinement: split into two rules — keep `:placeholder` + `:latest` unconditionally, and retain 50 most-recent tagged git-SHA images separately. Defer the refinement; single-rule bump is sufficient for MYT-28.

**.dockerignore tightening.**

Update `/.dockerignore` to add: `.git`, `.github`, `infra/`, `docs/`, `.beads/`, `wiki/`, `coverage/`, `*.tsbuildinfo`, `README.md`, `CLAUDE.md`, `ONBOARDING.md`, `AGENTS.md`, `.vscode`, `.idea`. Current content doesn't leak into the image (the Dockerfile uses explicit `COPY` paths, not `COPY . .`), but it does inflate the build context transferred to the Docker daemon — adds ~100MB on every cold build.

---

## Decisions log

1. **Two jobs, not one.** `build` → `deploy-staging`. Makes adding `deploy-production` a pure append. Accepted.

2. **Explicit rolloutState poll with timeout after deploy action.** `aws-actions/amazon-ecs-deploy-task-definition@v2` calls `aws ecs wait services-stable`, which returns success on circuit-breaker rollback. Explicit polling (12 attempts × 10s = 2-min window) catches rollback-as-success AND slow-to-converge reconciliations. Single-shot sleep (v2) replaced with poll loop that fast-fails on `FAILED` state. Accepted.

3. **`environment: staging` on the `build` job.** OIDC trust requires the env claim. Accepted for MYT-28. `myth-jnb` (P2) splits build-role from deploy-role before prod lands.

4. **`docker inspect` for digest resolution, not `aws ecr describe-images`.** v2 used `describe-images` which creates a TOCTOU window between `docker push` and the describe call — an attacker with ECR push could re-tag between. `docker inspect --format='{{index .RepoDigests 0}}'` reads docker's local record of the digest the registry returned during push, closing the window. Bonus: no `ecr:DescribeImages` IAM permission needed. Accepted.

5. **Retry loop in smoke test.** Three attempts × 10s backoff (not after last), absorbs DNS/TLS flake. Accepted.

6. **Body match via `jq -e '.status == "ok"'`.** Protects against ALB default-200. Accepted.

7. **`concurrency: cancel-in-progress: false`, grouped by ECS service name.** Queue concurrent deploys. Service-keyed grouping keeps prod approval from blocking staging. Accepted.

8. **Production gating = GH Environment + required reviewer.** Chosen in brainstorm. Accepted.

9. **No PR triggers.** Project pushes direct to main. Accepted.

10. **`update-service --desired-count 1` AFTER the deploy action.** Prevents ECS from trying to place on `:placeholder`. `ignore_changes = [desired_count]` avoids Terraform conflict. Accepted.

11. **SIGTERM handler + factory/entrypoint split bundled.** Closes `myth-3v4` + `myth-nu9`. New pure `createShutdown()` function enables direct testing without process-exit mocking. Accepted.

12. **Third-party actions SHA-pinned + Dependabot weekly, no auto-merge.** Defense against tag-force-push supply-chain attacks. Accepted.

13. **Step ordering in `build` is load-bearing for security.** `pnpm install` before OIDC assumption; `AWS_ACCOUNT_ID` referenced inline only. Accepted.

14. **`paths-ignore` on push trigger.** Doc-only commits don't cycle ECS. Side-effect: `workflow_dispatch` after a docs-only HEAD builds from current main (including doc commits) with a new `$GIT_SHA` → produces a duplicate image with different tag but identical bytes. Acceptable — counts against 50-image retention but is infrequent. Accepted.

15. **`AWS_ACCOUNT_ID` as GitHub environment variable, not secret.** Account IDs are not secret. Accepted.

16. **ECR lifecycle retention 20 → 50.** ~$0.60/mo for ~5 days of rollback headroom at 10 merges/day. Optional future refinement: split `:latest`/`:placeholder` into a separate always-keep rule. Accepted.

17. **`--platform linux/amd64` explicit on docker build.** Future-proofs against GitHub-hosted runners going ARM. Accepted.

18. **Timeouts on all jobs.** `build: 15`, `deploy-staging: 20`. Accepted.

19. **ECR pull-through cache for Docker Hub base images.** `node:24-alpine` currently pulled anonymously from Docker Hub. Rate limit (100/6h per IP) is a team-scale landmine and a possible today-landmine on cache-miss sprees. Pull-through cache eliminates the limit entirely. One Terraform resource (`aws_ecr_pull_through_cache_rule`), two IAM actions (`ecr:CreateRepository`, `ecr:BatchImportUpstreamImage`), one Dockerfile build-arg. Accepted.

20. **No jq pre-strip of read-only fields in the deploy job.** `aws-actions/amazon-ecs-render-task-definition@v1.7.3` strips read-only fields internally. Keeping a manual jq strip as well creates two sources of truth about "what's read-only" — risk of divergence when AWS adds new read-only fields. Accepted; v2's pre-strip step removed.

21. **240-second shutdown drain mental model.** ALB deregistration (120s) + SIGTERM stopTimeout (120s) compose sequentially, not overlap. v2's "120s drain" description was wrong; v3 documents the full 240s worst-case in §3. No code change — the SIGTERM handler already uses both windows correctly. Accepted.

22. **`.dockerignore` tightened.** Reduces build-context transfer size by ~100MB per cold build. Accepted.

---

## Risks

1. **GitHub Environment "staging" misconfiguration breaks OIDC silently.** Pre-flight check gives a clean early failure.

2. **`amazon-ecs-deploy-task-definition@v2` behavior change.** The explicit rolloutState poll backstops us.

3. **First docker build takes 3–5 minutes.** Pull-through cache keeps base image fast after first warm-up; pnpm cache via setup-node keeps node_modules fast. Steady-state 3–5 min.

4. **Smoke test hits ALB during old-task deregistration window.** First deploy: no old task, not an issue. Redeploys: `wait-for-service-stability` + rolloutState poll confirm new task is healthy before smoke runs.

5. **SIGTERM handler hangs.** Try/catch logs + exits 1; ECS SIGKILL at stopTimeout=120 is the ultimate safety net.

6. **`describe-task-definition` eventual consistency.** Queue serialization (cancel-in-progress: false) eliminates CI-to-CI races.

7. **`:latest` tag mutation.** Task defs reference digests, not `:latest`. `:latest` is convenience for `docker pull` on dev laptops.

8. **Worker service accidental flip to `desired_count=1`.** `:placeholder` pull fails fast (Done-when #7 verifies this). No traffic impact beyond failed-task noise until Observability alarms land.

9. **Task-def time-bomb from prior compromise.** Post-compromise recovery requires re-authoring task defs from Terraform baseline, not `describe`.

10. **ECR lifecycle deletes old images that task-def revisions reference.** At 50-image retention / 48 git-SHA slots / 10 merges-per-day, rollback window is ~5 days. Acceptable.

11. **Pull-through cache upstream unavailability.** If Docker Hub is down and the ECR cache has no copy yet (first pull), build fails. Cache hit after first pull = immune. Accepted.

12. **`docker inspect` RepoDigests empty on flaky push.** Failure mode: `docker push` reports success but docker's metadata update lags. Not observed in practice; pre-flight assertion catches it if it happens.

---

## Out of scope (follow-up beads)

1. **`myth-bcx`:** first-deploy runbook.
2. **`myth-nf3`:** `/health` → `/health/live` + `/health/ready`.
3. **`myth-651`:** OIDC `job_workflow_ref` pinning.
4. **`myth-v0p`:** quarterly task-def revision pruning.
5. **`myth-jnb` (FILED):** split build-role/deploy-role before prod.
6. **`myth-0eb` (FILED):** disable `workflow_dispatch` on prod.
7. **`myth-67h` (FILED):** image signing (cosign/sigstore).
8. **`myth-sua` (FILED):** VPC interface endpoints for ECR + S3 gateway.
9. **`myth-57l` (FILED):** CloudWatch log retention audit + billing alarms.
10. **Docker layer caching** via buildx + GHA cache. Add when cold-build >10 min.
11. **Deploy notifications** (Slack/Discord). Observability / Launch.
12. **Image vulnerability scanning.** Observability alarm on findings.
13. **Frontend deploy jobs.** Sibling `build-frontend` + `deploy-frontend-staging`.
14. **Fargate vCPU quota bump request** (6 → 32). Pre-launch AWS ticket, Miklos to file independently.
15. **Closed by MYT-28:** `myth-3v4` (SIGTERM), `myth-nu9` (factory split).

---

## Verification sequence (Done-when, expanded)

```bash
# 1. Service at desired=running=1 on digest-addressed revision
aws ecs describe-services --cluster mythrun --services mythrun-staging-api \
  --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition,rolloutState:deployments[0].rolloutState,failed:deployments[0].failedTasks}'
# Expected: running: 1, desired: 1, taskDef: arn...:2, rolloutState: COMPLETED, failed: 0

# 2. Task running the digest-addressed image
TASK_ARN=$(aws ecs list-tasks --cluster mythrun --service-name mythrun-staging-api --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" --query 'tasks[0].containers[0].image'
# Expected: <account>.dkr.ecr.us-east-1.amazonaws.com/mythrun@sha256:<64-hex>

# 3. External health endpoint responds
curl -v https://staging-api.mythrun.com/health
# Expected: HTTP 200, body {"status":"ok"}, TLS handshake with *.mythrun.com cert

# 4. Second push produces a new revision
echo "# bump" >> backend/src/__tests__/app.test.ts  # force a code-path commit
git add -A && git commit -m "chore: verify deploy idempotency" && git push
# After Actions completes:
aws ecs describe-services --cluster mythrun --services mythrun-staging-api \
  --query 'services[0].taskDefinition'
# Expected: arn...:3 (or higher)

# 5. SIGTERM handler + factory split — unit tests pass
cd backend && pnpm test
# Expected: shutdown.test.ts + app.test.ts green

# 6. Prior task stopped cleanly (clean SIGTERM handling)
aws ecs list-tasks --cluster mythrun --service-name mythrun-staging-api --desired-status STOPPED \
  --query 'taskArns[-1]' --output text
aws ecs describe-tasks --cluster mythrun --tasks <stopped-arn> \
  --query 'tasks[0].{stoppedReason:stoppedReason,stopCode:stopCode,exitCode:containers[0].exitCode}'
# Expected: exitCode=0, stopCode=EssentialContainerExited.
# exitCode=137 would indicate SIGKILL — handler didn't drain in time.

# 7. :placeholder invariant holds
aws ecr describe-images --repository-name mythrun --image-ids imageTag=placeholder 2>&1
# Expected: ImageNotFoundException

# 8. Pull-through cache is wired
aws ecr describe-pull-through-cache-rules --query 'pullThroughCacheRules[?ecrRepositoryPrefix==`docker-hub`]'
# Expected: one rule, upstream registry-1.docker.io
aws ecr describe-repositories --repository-names docker-hub/library/node 2>/dev/null \
  && echo "cache hit (repo auto-created on first pull)" \
  || echo "cache clean (not yet pulled — expected before first build)"
```

---

## Cost delta over MYT-30 baseline

| Item | Delta (solo) | Delta (team-of-5 post-launch) | Reason |
|---|---|---|---|
| ECR storage | +~$0.60/mo | +~$1.20/mo | 50-image retention (~5 GB at team scale) |
| ECR pull-through cache storage | +~$0.20/mo | +~$0.40/mo | Base-image layer storage |
| ECS Fargate runtime (staging) | +~$7/mo | +~$7/mo | `desired_count=1` continuous on 0.25 vCPU / 512 MB |
| CloudWatch Logs (ingestion + storage) | +~$1/mo (solo) | +~$5-15/mo (team) | 14-day retention; Fastify request logging × real traffic |
| NAT bandwidth (ECR pulls) | negligible | +~$13/mo | Fargate→ECR cross-AZ egress; `myth-sua` VPC endpoints eliminate |
| GitHub Actions minutes | $0 (within included) | +~$70/mo | 12k min/mo × $0.008/min overage on Team plan |
| **Total MYT-28 delta** | **~$9/mo** | **~$90/mo** | |

**New baseline at solo scale: ~$92/mo.** At team-of-five scale after launch: ~$173/mo projected without `myth-sua` endpoints, ~$160/mo with. Cost scaling is dominated by GitHub Actions overage minutes — worth re-validating plan tier as team grows.

**Note:** action SHAs in workflow YAML (`<sha>` placeholders) must be resolved at implementation time from each action's releases page. Pre-implementation checklist item.
