# CI/CD + First Staging Deploy Design

**Linear issue:** MYT-28 (Ops Foundation milestone, Urgent, due 2026-04-27)
**Parent specs:** `docs/specs/2026-04-20-setup-guide.md` (Phase 5.3), `docs/specs/2026-04-10-infrastructure-devops.md`, `docs/specs/2026-04-07-week0-ops-foundation.md`
**Prior issue:** MYT-30 (serving infra — ECR repo, ECS cluster + services at `desired_count=0` on `:placeholder`, ALB, OIDC provider, `mythrun-github-actions-staging` role with 6-condition trust)
**Status:** Draft, pending agent-team review

---

## Goal

Stand up a GitHub Actions workflow that builds the backend image, pushes it to ECR, and flips the staging ECS service from `desired_count=0` on `:placeholder` to `desired_count=1` on the just-built `:$GIT_SHA` tag — on every push to `main`. This is the Ops Foundation ship gate: when it works, a code change flows from `git push` to a healthy staging container in one step.

## Done when

1. A push to `main` triggers `.github/workflows/deploy.yml` and the workflow succeeds end-to-end
2. `aws ecs describe-services --cluster mythrun --services mythrun-staging-api --query 'services[0]'` returns `runningCount = 1` on a task-def revision whose image URI is `<account>.dkr.ecr.us-east-1.amazonaws.com/mythrun:<merge-commit-SHA>`
3. `curl -fsS https://staging-api.mythrun.com/health` returns HTTP 200 with body `{"status":"ok"}`
4. The `deployments[0].rolloutState` on the staging service is `COMPLETED` (circuit breaker did not fire)
5. A second push (any no-op commit) re-runs the workflow end-to-end in under 10 minutes, producing task-def revision 3 on the staging service (verifies idempotency)
6. Backend `SIGTERM` handler drains in-flight requests via `app.close()` before exit (verified by reading the container's log output during the service update: `{"level":"info","signal":"SIGTERM","msg":"shutting down"}`)

## What this task does NOT do

- **Production deploy job.** Production infra doesn't exist yet (Platform Readiness milestone). The workflow is structured so adding it later is a pure-append (one new job with `needs: deploy-staging`, `environment: production`, reusing the `build` job's image output). The shape is documented in §7 for future reference.
- **Worker service deploy.** The staging worker service exists at `desired_count=0` on `:placeholder`. No `dist/worker.js` exists in the backend yet (Prep Pipeline milestone). The workflow ignores the worker service entirely — it stays at 0 via MYT-30's `ignore_changes = [desired_count, task_definition]`.
- **Runbook document.** `myth-bcx` (first-deploy runbook at `docs/runbooks/first-deploy.md`) is deferred. The workflow file itself, with its comments, is the runbook for now.
- **PR-triggered CI.** The project pushes direct to `main` (see CLAUDE.md "Human-Agent Review Workflow"). No PR flow, so no PR triggers on the workflow. Branch protection rules unchanged.
- **`/health` split into `/health/live` + `/health/ready`.** Deferred to `myth-nf3` (requires DB + Redis clients, Backend Core milestone). The existing single `/health` route is what ALB and the smoke test both hit.
- **`server.ts` split into factory + entrypoint.** Deferred to `myth-nu9` (Backend Core milestone). Listen-on-import is tolerated for the first deploy.
- **CloudWatch alarm on deploy failures.** Observability milestone. First deploys surface failures via red CI + the engineer's eyeballs.
- **Rollback tooling.** Manual for now: `git revert <bad-commit> && git push` triggers a redeploy of the reverted state. Formalized when production infra lands.
- **Secret rotation, image vulnerability scanning, deploy metrics.** All later-milestone work.

---

## Architecture summary

Single workflow file at `.github/workflows/deploy.yml`. Two jobs in one pipeline:

```
push to main
     ↓
┌──────────────────────────────────────────────────────────────┐
│ build                                                        │
│   environment: staging  (OIDC trust requires env claim)      │
│   - checkout + pnpm install                                  │
│   - pnpm lint / typecheck / test                             │
│   - assume mythrun-github-actions-staging via OIDC           │
│   - ecr-login                                                │
│   - docker build -f backend/Dockerfile                       │
│   - docker push :$GIT_SHA + :latest                          │
│   - outputs: image = <ecr>/mythrun:$GIT_SHA                  │
└──────────────────────────────────────────────────────────────┘
     ↓
┌──────────────────────────────────────────────────────────────┐
│ deploy-staging  (needs: build)                               │
│   environment: staging                                       │
│   - assume mythrun-github-actions-staging via OIDC           │
│   - aws ecs describe-task-definition → strip read-only → JSON│
│   - amazon-ecs-render-task-definition (patch image field)    │
│   - aws ecs update-service --desired-count 1 (no-op if =1)   │
│   - amazon-ecs-deploy-task-definition (register new rev,     │
│       update service to it, wait-for-service-stability)      │
│   - smoke test: curl /health with jq body match, 3 retries   │
└──────────────────────────────────────────────────────────────┘
     ↓
    ✅ staging is live on :$GIT_SHA
```

**Why two jobs, not one:** When production infra lands, a third job `deploy-production` appends with `needs: deploy-staging`, `environment: production` (which triggers GH's required-reviewer pause), and reuses `${{ needs.build.outputs.image }}` — the exact same bytes that staging just validated. One build, two deploys. No risk of "prod got a different image than staging."

**Why the `build` job uses `environment: staging`:** The OIDC trust policy on `mythrun-github-actions-staging` requires the token's `environment` claim to be `staging`. GitHub only sets that claim when the job declares `environment:`. Since the staging role is what authorizes ECR push (repo is shared across envs), `environment: staging` on the build job is accurate: this job produces an artifact authorized by staging's credentials.

### Why the register-then-update pattern

`aws ecs update-service --force-new-deployment` re-pulls the image but **does not switch task-definition revisions**. Terraform registered task-def revision 1 pointing at `:placeholder`. If CI only calls `update-service`, the service keeps using revision 1, which pulls the `:placeholder` tag (which does not resolve in ECR — `:placeholder` is a literal tag name, not a real image). Task fails to start.

The correct sequence — documented by `myth-bcx` and reinforced by MYT-30's Angelfish review — is:

1. **describe** the current task def (revision 1 on first deploy, revision N on subsequent)
2. **patch** `containerDefinitions[0].image` to the new URI
3. **register** a new revision (the `aws-actions/amazon-ecs-deploy-task-definition` action handles steps 2–3)
4. **update-service** with `--task-definition mythrun-staging-api:N+1` and `--desired-count 1` on first deploy (no-op on subsequent)

The `aws-actions/amazon-ecs-deploy-task-definition@v2` action wraps steps 3–4 and additionally checks `deployments[0].rolloutState == COMPLETED` before returning success. That's important because `aws ecs wait services-stable` returns success after circuit-breaker rollback too (the service IS stable on its previous revision). The action's rolloutState check catches rollback-as-failure.

---

## Detailed design

### 1. Workflow file (`.github/workflows/deploy.yml`)

```yaml
name: Deploy

on:
  push:
    branches: [main]
  workflow_dispatch:   # manual trigger for redeploys without a new commit

permissions:
  id-token: write      # OIDC token minting
  contents: read       # checkout

concurrency:
  # All pushes to a given ref share a group. cancel-in-progress=false means
  # concurrent pushes QUEUE rather than kill an in-flight deploy.
  group: deploy-${{ github.ref }}
  cancel-in-progress: false

env:
  AWS_REGION: us-east-1
  ECR_REPO: mythrun

jobs:
  build:
    runs-on: ubuntu-latest
    environment: staging
    outputs:
      image: ${{ steps.build.outputs.image }}
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v4
        # Reads packageManager field from package.json

      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      - run: pnpm --filter @mythrun/backend lint
      - run: pnpm --filter @mythrun/backend typecheck
      - run: pnpm --filter @mythrun/backend test

      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - name: Build and push image
        id: build
        env:
          REGISTRY: ${{ steps.ecr.outputs.registry }}
        run: |
          IMAGE_URI="$REGISTRY/${{ env.ECR_REPO }}:${{ github.sha }}"
          LATEST_URI="$REGISTRY/${{ env.ECR_REPO }}:latest"
          docker build -t "$IMAGE_URI" -t "$LATEST_URI" -f backend/Dockerfile .
          docker push "$IMAGE_URI"
          docker push "$LATEST_URI"
          echo "image=$IMAGE_URI" >> "$GITHUB_OUTPUT"

  deploy-staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    env:
      ECS_CLUSTER: mythrun
      ECS_SERVICE: mythrun-staging-api
      TASK_DEF_FAMILY: mythrun-staging-api
      CONTAINER_NAME: api
      API_HOSTNAME: staging-api.mythrun.com
    steps:
      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Fetch current task definition
        # Describe the existing revision, strip the read-only fields that
        # register-task-definition rejects, write to disk for the render step.
        run: |
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

      - name: Render new task definition with image
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-def.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ needs.build.outputs.image }}

      - name: Ensure desired-count is 1
        # First deploy: flips service from 0 to 1. Subsequent deploys: no-op
        # (desired-count is already 1). Terraform's ignore_changes=[desired_count]
        # on the service means we won't fight subsequent plans.
        run: |
          aws ecs update-service \
            --cluster "${{ env.ECS_CLUSTER }}" \
            --service "${{ env.ECS_SERVICE }}" \
            --desired-count 1 > /dev/null

      - name: Deploy to ECS
        # Registers the rendered task def as a new revision, updates the service
        # to reference it, and waits for rolloutState=COMPLETED. Exits non-zero
        # if the deployment circuit breaker rolls back.
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.taskdef.outputs.task-definition }}
          cluster: ${{ env.ECS_CLUSTER }}
          service: ${{ env.ECS_SERVICE }}
          wait-for-service-stability: true
          wait-for-minutes: 10

      - name: Smoke test
        # Three attempts, 10s apart, 30s timeout each. Retries absorb DNS/TLS
        # handshake flake. Body match via `jq -e` catches the failure mode
        # where a misconfigured ALB returns its default 200 (not our JSON).
        run: |
          for attempt in 1 2 3; do
            echo "Smoke test attempt $attempt of 3..."
            if body=$(curl -fsS --max-time 30 "https://${{ env.API_HOSTNAME }}/health"); then
              echo "Response: $body"
              if echo "$body" | jq -e '.status == "ok"' > /dev/null; then
                echo "Smoke test passed."
                exit 0
              fi
            fi
            sleep 10
          done
          echo "Smoke test failed after 3 attempts"
          exit 1
```

### 2. GitHub Environment configuration (manual prep)

Before the first workflow run, Miklos configures:

**GitHub repo → Settings → Environments → New environment: `staging`**

1. **Deployment branches:** Restrict to `main` only.
   - Purpose: belt-and-suspenders on the OIDC trust's `ref` condition. If the workflow ever runs from a non-main ref, GitHub refuses to mint an env-scoped token before AWS ever sees it.
2. **Environment secret:** `AWS_ACCOUNT_ID = <12-digit AWS account ID>`
   - Scoped to the `staging` environment, not the repo. Future `production` environment gets its own `AWS_ACCOUNT_ID` secret (same value, but env-scoped so secret changes don't accidentally leak across environments).
3. **Required reviewers:** *not set* for staging. (Set for `production` when that environment is created at Launch.)
4. **Wait timer:** *not set*. Staging deploys proceed immediately once `build` job finishes.

### 3. Backend change: SIGTERM handler

**File:** `backend/src/server.ts`

**Current state:**
```typescript
import Fastify from 'fastify'

export const buildApp = () => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}

const app = buildApp()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
```

**Updated:**
```typescript
import Fastify from 'fastify'

export const buildApp = () => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}

const app = buildApp()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'shutting down')
    await app.close()
    process.exit(0)
  })
}
```

**Why it matters:**

ECS sends `SIGTERM` when replacing a task. The task-def has `stopTimeout = 120` (MYT-30), giving the container 120 seconds to exit gracefully before `SIGKILL`. ALB `deregistration_delay = 120` gives in-flight requests that same 120 seconds to complete before the target is removed from the pool. These two windows align deliberately.

Without a handler, Node's default `SIGTERM` behavior terminates the process immediately, dropping every in-flight request. For staging today there is no traffic to drop — but a 30–60 second LLM call in production would be cut off mid-stream. Adding the 6-line handler now avoids the "we'll remember to add it later" failure mode.

Fastify's `app.close()` stops accepting new connections and waits for active requests to finish before resolving. Six lines, zero dependencies, lands in the same PR as the workflow.

### 4. Smoke test semantics

Three attempts, 10-second backoff, 30-second curl timeout per attempt.

- **Why retry:** `wait-for-service-stability` confirms the task is healthy from the ALB's perspective (target group reports healthy), but there's a short window where Route 53 cache, TLS session resumption, or TCP SYN-ACK latency causes the first external curl to fail. Retries absorb this.
- **Why body match not just `-f`:** `curl -f` fails only on HTTP 4xx/5xx. A misconfigured ALB returning its own 200 (e.g., a fixed-response default action we accidentally plumbed through) would pass `-f` but return the wrong body. `jq -e '.status == "ok"'` catches that class of bug.
- **Why fail the job on all-three-attempts-failing:** The deploy technically succeeded (ECS reports healthy), but the external path is broken. Red CI surfaces "routing/DNS/TLS regression" before anyone else notices.

### 5. Failure modes and recovery

| Failure | AWS state | CI result | Recovery |
|---|---|---|---|
| lint/typecheck/test fails | no AWS calls made | red | fix code, re-push |
| `docker build` fails | image not in ECR | red | fix Dockerfile or app code, re-push |
| `docker push` fails (ECR auth error) | image not in ECR | red | check OIDC role, ECR policy; re-push |
| `describe-task-definition` returns error | no new revision | red | check IAM trust policy for this step's role |
| `register-task-definition` fails | revision not created | red | check role's `ecs:RegisterTaskDefinition` permission |
| `update-service` circuit breaker rolls back | service restored to previous rev | red (action detects via rolloutState) | fix root cause, re-push |
| `wait-for-service-stability` times out (10 min) | deployment still in progress | red | investigate manually; ECS circuit breaker will eventually rollback |
| Smoke test fails 3x | deploy succeeded, ECS healthy | red | check Route 53 record, ALB listener rule, cert validity |

**First-deploy pathological case:** A bad image fails its container healthcheck → target group marks targets unhealthy → ECS deployment circuit breaker fires → service rolls back. On first deploy the "previous revision" is task-def rev 1 (`:placeholder`), which also can't boot (that tag doesn't exist in ECR). Service settles at `runningCount = 0, desiredCount = 1`. Smoke test fails. CI red. Recovery: fix the backend code, re-push — CI produces task-def rev 3, service switches to it, healthy tasks come up.

**Rollback (non-MYT-28):** For any bad deploy post-first-green, the recovery is `git revert <bad-commit> && git push`. CI runs again with the reverted code, producing a new task-def revision with the previous image, service updates to it. There is no "deploy previous revision" shortcut in this workflow — intentional. Everything flows through the pipeline.

### 6. Concurrency semantics

`concurrency: { group: deploy-${{ github.ref }}, cancel-in-progress: false }` produces:

- Two pushes to `main` in quick succession: both workflows run to completion in order. The second waits for the first.
- A push during an in-flight `workflow_dispatch` (or vice versa): both queue, same `deploy-refs/heads/main` group.
- **Never**: an in-flight deploy is killed mid-action. `cancel-in-progress: false` is load-bearing — cancelling between `register-task-definition` and `update-service` would leave an orphan task-def revision.

Orphan task-def revisions are cheap (free, and deregistered automatically 90 days after last use per MYT-30's ECR lifecycle; task defs never clean up automatically but count against no quota). They accumulate harmlessly. `myth-v0p` tracks quarterly pruning.

### 7. Future production pattern (documented, not implemented)

When production infra lands (Platform Readiness milestone), append one job to the same workflow:

```yaml
  deploy-production:
    needs: deploy-staging
    runs-on: ubuntu-latest
    environment: production   # GH pauses here until required reviewer clicks Approve
    env:
      ECS_CLUSTER: mythrun
      ECS_SERVICE: mythrun-production-api
      TASK_DEF_FAMILY: mythrun-production-api
      CONTAINER_NAME: api
      API_HOSTNAME: api.mythrun.com
    steps:
      - name: Assume AWS role via OIDC
        uses: aws-actions/configure-aws-credentials@v6
        with:
          role-to-assume: arn:aws:iam::${{ secrets.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-production
          aws-region: ${{ env.AWS_REGION }}
      # ... identical pattern to deploy-staging, pointing at prod resources ...
      # Reuses ${{ needs.build.outputs.image }} — no rebuild. Same bytes as staging.
```

**Configuration at that time:**
- Create GitHub Environment `production` with **required reviewer = Miklos**
- Create AWS IAM role `mythrun-github-actions-production` (same pattern as staging, scoped to prod cluster + task-def family; OIDC trust pins `environment:production`)
- Add AWS_ACCOUNT_ID as `production`-scoped environment secret

**Operationally:** every push to `main` triggers the full pipeline. Staging deploys automatically. The production job pauses and notifies the reviewer (UI badge + optional email). Miklos reviews staging — runs any manual smoke tests, checks dashboards, eyeballs logs — then clicks Approve (or Reject). On Approve, prod deploys using the same image that staging validated.

**Why no automated soak time before prod:** Observability milestone adds CloudWatch alarms; before then, a forced soak just delays the deploy without gaining signal. After alarms exist, a 5-minute soak can be added to the workflow if a post-mortem ever shows value.

---

## Decisions log

1. **Two jobs, not one.** `build` → `deploy-staging`. Slight overhead (~10s job startup) but makes adding `deploy-production` a pure append. Alternative (one monolithic job) would require a partial rewrite later. Accepted.

2. **`aws-actions/amazon-ecs-deploy-task-definition` over hand-rolled `aws ecs register-task-definition` + `update-service`.** Both approaches work. The action checks `rolloutState == COMPLETED` automatically, catching circuit-breaker rollback as a failure (naive `aws ecs wait services-stable` reports success on rollback). Also maintained by AWS, gets updated for API changes. Accepted. Angelfish review on MYT-30 also recommended.

3. **`environment: staging` on the `build` job, not a separate build-only role.** The OIDC trust on `mythrun-github-actions-staging` requires the env claim. The staging role happens to have ECR push permissions (which authorizes the build step). A dedicated build role with relaxed trust would technically be cleaner separation-of-concerns, but costs another Terraform resource and another OIDC trust to maintain. Not worth it for a solo-dev project where the same person owns both concerns. If a future team wants build-and-deploy segregation, creating `mythrun-github-actions-build` later is straightforward. Accepted.

4. **`:latest` tag alongside `:$GIT_SHA`.** Task defs always reference `:$GIT_SHA` for reproducibility. `:latest` exists for humans running `docker pull` locally. ECR repo is MUTABLE (MYT-30 §4.2), so `:latest` overwrites on each push — this is expected behavior, not drift. Accepted.

5. **Retry loop in smoke test.** Three attempts with 10s backoff absorbs DNS/TLS flake between "ECS reports healthy" and "external curl reaches ALB." Alternative (single attempt with longer curl timeout) is cheaper but produces misleading-failure reports when retries would have passed. Accepted.

6. **Body match via `jq -e '.status == "ok"'`.** Protects against ALB returning its own 200 (e.g., a fixed-response default action) rather than the app's. Alternative (bare `curl -f`) passes any 200. The extra assertion costs nothing. Accepted.

7. **`concurrency: cancel-in-progress: false`.** Queue concurrent deploys, don't kill in-flight. Killing between `register-task-definition` and `update-service` would leave orphan revisions and an unexpected service state. Accepted.

8. **Production gating = GH Environment + required reviewer, not tag-based or branch-based.** Chosen in brainstorm. Requires one UI click per prod deploy; no extra git discipline. Matches the pattern the setup guide already scaffolds. Accepted.

9. **No PR triggers.** Project workflow is push-direct-to-main (CLAUDE.md "Human-Agent Review Workflow"). PR CI would be dead infrastructure until that policy changes. Accepted.

10. **Explicit `aws ecs update-service --desired-count 1` step.** First deploy flips 0→1; subsequent deploys no-op. `ignore_changes = [desired_count]` on the service resource in Terraform means no conflict. Alternative (relying on the deploy action's `desired-count` input, which may or may not exist in the current version) is fragile across action releases. Accepted.

11. **SIGTERM handler in same PR as the workflow.** Six lines; deferring to Backend Core milestone is valid but creates a window where the first real production deploy could drop in-flight requests on rollouts. Bundling is safe because the backend code is already minimal and the change has no surface area. Accepted.

---

## Risks

1. **GitHub Environment "staging" misconfiguration silently breaks OIDC.** If Miklos forgets the environment, or names it wrong (e.g., `Staging`), AWS rejects the AssumeRoleWithWebIdentity call with "not authorized" — confusing error. Mitigation: checklist in §2, the step is explicit, and the error message will immediately route to the OIDC condition check.

2. **`AWS_ACCOUNT_ID` exposure.** The account ID is not a secret (public in many AWS responses), but scoping it as an environment secret limits accidental leakage if the secret is ever renamed to something sensitive. Acceptable.

3. **First docker build takes 3–5 minutes.** Cold CI build with no layer cache. Subsequent builds cache node_modules via pnpm. Workflow budget: 8–10 min total on first run, 3–5 min steady state. If builds slow to >10 min, add Docker layer caching via `docker/build-push-action` or ECR image cache.

4. **Smoke test hits ALB during the 120s ALB deregistration window of a previous stale task.** Not a risk for first deploy (no previous task). On redeploys, `wait-for-service-stability` ensures the new task is serving before smoke test runs, and ALB has stopped sending traffic to the old task. Not a failure mode in practice.

5. **SIGTERM handler doesn't exit cleanly on malformed state.** If `app.close()` hangs (e.g., a request promise never resolves), the process stays alive until ECS's `SIGKILL` at stopTimeout=120. That's the safety net. Acceptable.

6. **`describe-task-definition` sometimes returns a slightly stale response.** AWS eventual consistency is generally <1s but theoretically the task-def we describe could be rev N-1 mid-race with another workflow run. `concurrency: cancel-in-progress: false` queues deploys, so there's no concurrent workflow to race with. Only risk is manual `aws ecs register-task-definition` during a workflow run, which isn't a workflow the user is expected to perform.

7. **ECR `:latest` tag mutation is a known supply-chain soft spot.** The workflow trusts that `:$GIT_SHA` is immutable in practice (ECR is MUTABLE mode per MYT-30, but we never re-push the same SHA). Task defs reference `:$GIT_SHA`, not `:latest`, so `:latest` is a convenience tag only. If that contract breaks (someone manually pushes a different image under the same SHA tag), the impact is "next deploy pulls that image," caught by smoke test. Acceptable.

---

## Out of scope (follow-up beads to file alongside MYT-28)

1. **myth-bcx: first-deploy runbook doc at `docs/runbooks/first-deploy.md`.** The workflow file comments this issue's content inline; a separate runbook is redundant for now. Revisit when the deploy process grows (e.g., production, multiple services).

2. **myth-nf3: `/health` → `/health/live` + `/health/ready` split.** Backend Core milestone. Requires real DB + Redis clients. Update ALB target-group path from `/health` to `/health/ready` in the same Terraform follow-up.

3. **myth-nu9: `server.ts` factory/entrypoint split.** Backend Core milestone. Keeps `buildApp` importable without side-effect listen.

4. **myth-651: Pin OIDC `job_workflow_ref` via GH custom claim mapping.** Hardens the trust policy so only the exact workflow file path can assume the role. Useful once the repo grows multiple workflows. P4.

5. **myth-3v4 is CLOSED by this issue** (SIGTERM handler ships here).

6. **myth-v0p: Quarterly pruning of orphan ECS task-def revisions.** Not triggered by MYT-28 but more relevant now that CI produces a new revision per deploy. Still P4.

7. **Production deploy job + production GH Environment + prod OIDC role.** Filed as the Platform Readiness milestone's responsibility. No new bead yet.

8. **Docker layer caching to speed up CI.** Add via `docker/build-push-action` with `cache-from`/`cache-to` when build time exceeds 10 min consistently. No bead filed; will emerge from observation.

9. **Deploy notification to Slack/Discord.** Nice-to-have. Observability milestone or Launch prep.

10. **Image vulnerability scanning (ECR scan on push).** Free AWS feature. Enable in a follow-up along with Observability milestone alarm on findings.

---

## Verification sequence (Done-when, expanded)

After the first successful workflow run, Miklos runs:

```bash
# 1. ECS service is running the new revision
aws ecs describe-services --cluster mythrun --services mythrun-staging-api \
  --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition,rolloutState:deployments[0].rolloutState}'
# Expected:
#   running: 1
#   desired: 1
#   taskDef: arn:aws:ecs:us-east-1:<account>:task-definition/mythrun-staging-api:2
#   rolloutState: COMPLETED

# 2. Task is actually running our image (not :placeholder)
aws ecs describe-tasks --cluster mythrun \
  --tasks $(aws ecs list-tasks --cluster mythrun --service-name mythrun-staging-api --query 'taskArns[0]' --output text) \
  --query 'tasks[0].containers[0].image'
# Expected: <account>.dkr.ecr.us-east-1.amazonaws.com/mythrun:<SHA of HEAD commit>

# 3. External health endpoint responds correctly
curl -v https://staging-api.mythrun.com/health
# Expected: HTTP 200, body {"status":"ok"}, TLS handshake with *.mythrun.com cert

# 4. Second push (no-op commit or workflow_dispatch) produces revision 3
git commit --allow-empty -m "chore: verify deploy idempotency"
git push
# Watch Actions tab: workflow runs, new task-def revision registered, service updates
# Expected: runningCount stays 1, taskDef ARN ends in :3, rolloutState COMPLETED

# 5. SIGTERM handler fires on the redeploy
# Watch CloudWatch logs during the second deploy; old task should log:
#   {"level":"info","signal":"SIGTERM","msg":"shutting down"}
# immediately before ECS reports it STOPPED.
```

---

## Cost delta over MYT-30 baseline

| Item | Delta | Reason |
|---|---|---|
| ECR storage | +~$0.10/month | Image layers (~100MB per SHA × retention of 20 images ≈ 2 GB × $0.10/GB) |
| ECS Fargate runtime | +~$7/month | One `0.25 vCPU / 512 MB` task running 24/7 in staging (was $0 at `desired_count=0`) |
| CloudWatch Logs ingestion | +~$1/month | Fastify log output × 14-day retention |
| **Total** | **~$8/month** | On top of MYT-30's ~$16 idle ALB + MYT-25's ~$67 data plane |

New baseline: **~$91/month.** No other cost changes from this issue.
