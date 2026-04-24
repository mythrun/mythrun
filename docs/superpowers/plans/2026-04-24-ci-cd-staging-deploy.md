# MYT-28: CI/CD + First Staging Deploy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land a GitHub Actions workflow that builds the backend image on every push to `main`, pushes to ECR, and flips the staging ECS service from `desired_count=0` on `:placeholder` to `desired_count=1` on a digest-addressed real image — with smoke-test verification against `https://staging-api.mythrun.com/health`.

**Architecture:** Two-job workflow (`build` → `deploy-staging`), with image digests resolved locally via `docker inspect` (not ECR API, to close a TOCTOU race), an explicit `rolloutState` poll to catch silent circuit-breaker rollbacks, and a three-retry smoke test. Backend code is split into a pure factory (`app.ts`) and entrypoint (`server.ts`) to make the SIGTERM handler unit-testable. Supporting Terraform amendments add `create_before_destroy` on task definitions, an ECR pull-through cache for Docker Hub (avoiding anonymous-pull rate limits), and expanded IAM.

**Tech Stack:** GitHub Actions (YAML + OIDC), AWS ECS/Fargate + ECR, Terraform (AWS provider ~> 6.0), Fastify 5 + TypeScript strict, Vitest, pnpm 10 workspaces.

**Spec:** `docs/superpowers/specs/2026-04-24-ci-cd-staging-deploy-design.md` (v3).

**Closes:** MYT-28 (Linear), myth-3v4 (SIGTERM bead), myth-nu9 (factory split bead).

**Gating:** Two user-approval gates — one before `terraform apply` on shared + staging workspaces (Task 9), one before the first real deploy push (Task 14).

---

## File structure

### New files
- `backend/src/app.ts` — pure factory + pure `createShutdown`; no side effects on import
- `backend/src/__tests__/app.test.ts` — factory tests (`/health` via `inject`)
- `backend/src/__tests__/shutdown.test.ts` — pure-function test of `createShutdown`
- `.github/workflows/deploy.yml` — the CI pipeline
- `.github/dependabot.yml` — weekly action-version bump PRs

### Modified files
- `backend/src/server.ts` — becomes the entrypoint; imports from `app.ts`; registers signal handlers
- `backend/src/__tests__/server.test.ts` — DELETED (replaced by `app.test.ts`)
- `backend/Dockerfile` — `ARG BASE_IMAGE_REGISTRY` + updated `FROM`
- `.dockerignore` — tightened to exclude more non-runtime paths
- `infra/modules/serving/main.tf` — `lifecycle { create_before_destroy = true }` on both task defs
- `infra/environments/shared/main.tf` — `aws_ecr_pull_through_cache_rule.docker_hub` + retention 20 → 50
- `infra/environments/staging/main.tf` — IAM policy gains `ecr:CreateRepository` + `ecr:BatchImportUpstreamImage`; existing ECR pull statement extended to `docker-hub/*` prefix

### Miklos-manual (no files)
- GitHub repo → Settings → Environments → New: `staging`, `main`-only branch, `AWS_ACCOUNT_ID` as environment **variable** (not secret)

---

## Task 1: Factory split — create `app.ts` with `buildApp`

**Context:** Current `backend/src/server.ts` has `buildApp` exported but also calls `app.listen` at module scope, so any import binds port 3000. This is `myth-nu9`. The factory goes into a separate file so tests can import it without side effects.

**Files:**
- Create: `backend/src/app.ts`
- Create: `backend/src/__tests__/app.test.ts`
- Delete: `backend/src/__tests__/server.test.ts` (superseded)

- [ ] **Step 1: Write the failing factory test**

Create `backend/src/__tests__/app.test.ts`:

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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mythrun/backend test`
Expected: FAIL with `Cannot find module '../app.js'` (or similar module-resolution error).

- [ ] **Step 3: Create `app.ts` with `buildApp` only**

Create `backend/src/app.ts`:

```typescript
import Fastify, { type FastifyInstance } from 'fastify'

export const buildApp = (): FastifyInstance => {
  const app = Fastify({ logger: true })
  app.get('/health', () => ({ status: 'ok' }))
  return app
}
```

- [ ] **Step 4: Delete the superseded `server.test.ts`**

Run: `rm backend/src/__tests__/server.test.ts`

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @mythrun/backend test`
Expected: PASS; both `buildApp` tests green, no other tests run yet.

- [ ] **Step 6: Commit**

```bash
git add backend/src/app.ts backend/src/__tests__/app.test.ts backend/src/__tests__/server.test.ts
git commit -m "refactor(backend): extract buildApp to app.ts for test isolation

Closes the myth-nu9 factory-split concern: buildApp can now be imported
without side effects (no port bind on import). Prepares for SIGTERM
handler extraction in a following commit."
```

---

## Task 2: Add `createShutdown` pure function + test

**Context:** SIGTERM handler logic lives in `app.ts` as `createShutdown(app)` so it can be tested without `process.exit` mocking contaminating the test runner. The returned handler calls `app.close()` → `process.exit(0)` on success, `process.exit(1)` on error. Pino log flush is yielded via `setImmediate` before close.

**Files:**
- Modify: `backend/src/app.ts`
- Create: `backend/src/__tests__/shutdown.test.ts`

- [ ] **Step 1: Write the failing shutdown test**

Create `backend/src/__tests__/shutdown.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createShutdown, buildApp } from '../app.js'

describe('createShutdown', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
  })

  afterEach(() => {
    exitSpy.mockRestore()
  })

  it('calls app.close before process.exit(0) on clean shutdown', async () => {
    const app = buildApp()
    const callOrder: string[] = []

    vi.spyOn(app, 'close').mockImplementation(async () => {
      callOrder.push('close')
    })
    exitSpy.mockImplementation((code) => {
      callOrder.push(`exit:${code}`)
      return undefined as never
    })

    const handler = createShutdown(app)
    await handler('SIGTERM')

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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @mythrun/backend test`
Expected: FAIL with "createShutdown is not exported from '../app.js'" or similar.

- [ ] **Step 3: Add `createShutdown` + types to `app.ts`**

Replace `backend/src/app.ts` contents:

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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @mythrun/backend test`
Expected: PASS; all four tests (2 in `app.test.ts`, 2 in `shutdown.test.ts`) green.

- [ ] **Step 5: Typecheck + lint**

Run: `pnpm --filter @mythrun/backend typecheck && pnpm --filter @mythrun/backend lint`
Expected: PASS; no errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/app.ts backend/src/__tests__/shutdown.test.ts
git commit -m "feat(backend): add createShutdown pure function with unit test

Closes myth-3v4 (SIGTERM handler). Handler yields once via setImmediate
to let pino flush, awaits app.close() to drain in-flight requests, then
exits 0 (or 1 on close error). Extracted as a pure function so tests
don't need process.exit mocking pollution."
```

---

## Task 3: Rewrite `server.ts` as entrypoint

**Context:** `server.ts` becomes tiny — it just imports `buildApp` + `createShutdown`, starts the listener, and registers signal handlers. Dockerfile `CMD` continues to point at `dist/server.js`, so the runtime path is unchanged.

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Rewrite `server.ts`**

Replace `backend/src/server.ts` contents:

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

- [ ] **Step 2: Run the full backend verification suite**

Run: `pnpm --filter @mythrun/backend typecheck && pnpm --filter @mythrun/backend lint && pnpm --filter @mythrun/backend test && pnpm --filter @mythrun/backend build`
Expected: all four green. `pnpm build` produces `backend/dist/server.js` and `backend/dist/app.js`.

- [ ] **Step 3: Sanity check the built artifact locally**

Run: `cd backend && node --input-type=module -e "await import('./dist/app.js')"`
Expected: exits 0 with no output. Confirms `app.js` has no side effects when imported (would have bound port 3000 with the old `server.ts` content).

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.ts
git commit -m "refactor(backend): make server.ts a thin entrypoint over app.ts

Listen + signal registration only; all logic lives in app.ts.
Dockerfile CMD unchanged (still points at dist/server.js)."
```

---

## Task 4: Tighten `.dockerignore`

**Context:** Existing `.dockerignore` already covers the big hitters (`.git`, `node_modules`, `infra`). The tighten adds tooling noise and OS artifacts. No secret-leakage risk exists today because the Dockerfile uses explicit `COPY` paths, but a tighter ignore list keeps build context small (~100 MB saved per cold build).

**Files:**
- Modify: `.dockerignore`

- [ ] **Step 1: Append the additional exclusions**

Read the current `.dockerignore` (already includes `.git`, `.github`, `docs`, `.beads`, `.claude`, `infra`, etc.). Append these entries at the end, each on its own line:

```
# Additional tooling noise (MYT-28 tighten)
**/.DS_Store
*.tsbuildinfo
coverage
**/coverage
wiki
README.md
ONBOARDING.md
AGENTS.md
CLAUDE.md
.prettierignore
.prettierrc.json
.nvmrc
eslint.config.js
pnpm-workspace.yaml
```

Note: some of these were already in the file. Verify via `grep -c '^wiki$' .dockerignore` before adding — if already present, skip that line. `.dockerignore` accepts duplicate patterns without error, but avoid clutter.

- [ ] **Step 2: Verify build still works locally**

Run: `cd /Users/miklos/Desktop/Files/Mythrun/Code/mythrun && docker build -f backend/Dockerfile -t mythrun:local-test . 2>&1 | tail -20`
Expected: build succeeds, final `=> naming to docker.io/library/mythrun:local-test` line visible. This confirms the tightened ignore list didn't exclude a file the Dockerfile needs.

- [ ] **Step 3: Smoke test the image**

Run: `docker run --rm -d --name mythrun-test -p 3001:3000 mythrun:local-test && sleep 2 && curl -fsS http://localhost:3001/health && docker stop mythrun-test`
Expected: `{"status":"ok"}` printed; container stops cleanly.

- [ ] **Step 4: Commit**

```bash
git add .dockerignore
git commit -m "build(backend): tighten .dockerignore for smaller build context

Trims ~100MB from the docker build context on cold builds by excluding
tooling/docs/wiki/coverage paths. No secret-leakage change (Dockerfile
uses explicit COPY paths, not COPY . .)."
```

---

## Task 5: Dockerfile — parameterize base image registry

**Context:** Pull-through cache means CI pulls `node:24-alpine` through ECR (avoiding Docker Hub anonymous rate limits at team scale). The Dockerfile accepts `BASE_IMAGE_REGISTRY` as a build arg so CI can point it at ECR while local `docker build` (without the arg) falls back to Docker Hub.

**Files:**
- Modify: `backend/Dockerfile`

- [ ] **Step 1: Update Dockerfile FROM lines**

Open `backend/Dockerfile`. Current line 1-2:
```dockerfile
# ---- builder ----
FROM node:24-alpine AS builder
```

Replace with:
```dockerfile
# ---- builder ----
# BASE_IMAGE_REGISTRY is the ECR pull-through-cache registry host (e.g.,
# <account>.dkr.ecr.us-east-1.amazonaws.com). CI sets this via --build-arg.
# Unset/empty → Docker Hub direct (for local `docker build`).
ARG BASE_IMAGE_REGISTRY=""
FROM ${BASE_IMAGE_REGISTRY:+${BASE_IMAGE_REGISTRY}/}docker-hub/library/node:24-alpine AS builder
```

Then find line 13 (the runtime stage's `FROM node:24-alpine`), replace with:

```dockerfile
FROM ${BASE_IMAGE_REGISTRY:+${BASE_IMAGE_REGISTRY}/}docker-hub/library/node:24-alpine
```

**Note:** the `${VAR:+prefix}` syntax expands to `prefix` only when `VAR` is non-empty. When `BASE_IMAGE_REGISTRY` is empty, the FROM becomes `docker-hub/library/node:24-alpine` — which is not a valid Docker Hub path. For local builds, invoke with `--build-arg BASE_IMAGE_REGISTRY=<your-ecr>` OR keep a separate `Dockerfile.local` with the direct Docker Hub path. See Step 4.

- [ ] **Step 2: Verify the Dockerfile parses**

Run: `docker build --build-arg BASE_IMAGE_REGISTRY="" -f backend/Dockerfile -t mythrun:parse-test . 2>&1 | head -20`
Expected: build starts, likely fails at `FROM docker-hub/library/node:24-alpine` with "pull access denied" or "manifest unknown" — this is correct: we haven't set up the cache yet locally, and the local fallback doesn't resolve. Build with the positive case below first.

- [ ] **Step 3: Verify the Dockerfile builds against Docker Hub direct (via a sanity override)**

Temporarily create `backend/Dockerfile.local` with `FROM node:24-alpine` hardcoded in both stages. Build with that to confirm nothing else regressed:

Run: `docker build -f backend/Dockerfile.local -t mythrun:local-test . && docker rmi mythrun:local-test`
Expected: clean build + removal.

Then delete `backend/Dockerfile.local`:
Run: `rm backend/Dockerfile.local`

(The canonical `Dockerfile` will build successfully in CI once Tasks 7–9 land, because the ECR pull-through cache resolves `docker-hub/library/node:24-alpine` against Docker Hub automatically on first pull.)

- [ ] **Step 4: Commit**

```bash
git add backend/Dockerfile
git commit -m "build(backend): parameterize base image via BASE_IMAGE_REGISTRY ARG

CI will set --build-arg BASE_IMAGE_REGISTRY=<ecr-host> to route base
image pulls through our ECR pull-through cache. Local builds need to
provide the arg explicitly or use a temp Dockerfile.local pointing at
docker.io/library/node."
```

---

## Task 6: Terraform — `create_before_destroy` on task definitions

**Context:** Duncan's round-2 review flagged that `aws_ecs_task_definition` without a lifecycle block destroy-and-replaces on any container_definitions change, deregistering the current revision before registering the replacement. `create_before_destroy = true` flips the order — new revision first, state re-points, then old revision deregisters. Load-bearing for safe `terraform apply` on future task-def argument changes.

**Files:**
- Modify: `infra/modules/serving/main.tf` (lines 153 + 200)

- [ ] **Step 1: Add lifecycle block to `aws_ecs_task_definition.api`**

Open `infra/modules/serving/main.tf`. Find the `aws_ecs_task_definition "api"` block (line 153). Just before its closing `}` (around line 197–198, after the `tags` attribute), add:

```hcl
  lifecycle {
    create_before_destroy = true
  }
```

- [ ] **Step 2: Add lifecycle block to `aws_ecs_task_definition.worker`**

Find the `aws_ecs_task_definition "worker"` block (line 200). Add the same `lifecycle { create_before_destroy = true }` before its closing `}`.

- [ ] **Step 3: Update the inline comment explaining task-def lifecycle**

Find the MYT-30 comment near lines 114–119 that reads "No lifecycle block: AWS never destroys task-def revisions…" Replace with:

```hcl
# Task defs use create_before_destroy so in-place argument changes
# (env var, memory, log group) register the new revision before
# deregistering the old one. The previous "no lifecycle" stance (MYT-30)
# missed that destroy-and-replace fires on arg changes — correction in
# MYT-28 per Duncan review.
```

- [ ] **Step 4: Run `terraform plan` on the staging workspace**

Run: `cd infra/environments/staging && terraform plan -out=tfplan.t6 2>&1 | tee ../../../.plan-t6.out`
Expected: plan shows **no changes** to resources (adding a `lifecycle` block doesn't trigger a drift diff for `create_before_destroy`, only for `ignore_changes` / `prevent_destroy`). If plan shows any resource modification, stop and investigate.

- [ ] **Step 5: Commit**

```bash
git add infra/modules/serving/main.tf
git commit -m "fix(infra): add create_before_destroy to task defs (MYT-28 / Duncan review)

Without this, changing container_definitions triggers destroy-and-
replace, which deregisters the current revision before registering
the replacement — race where the scheduler could find a missing
task-def. create_before_destroy flips the order: register new,
state re-points, then deregister old."
rm .plan-t6.out infra/environments/staging/tfplan.t6
```

---

## Task 7: Terraform — ECR pull-through cache + retention bump

**Context:** Shaq's round-2 review flagged Docker Hub's 100-pulls-per-6-hours anonymous rate limit across GitHub-hosted runner IP pools — a landmine at team scale, possible today on cache-miss sprees. ECR's pull-through cache makes pulls go through our own ECR (same region), eliminating the limit entirely. Same commit bumps the `mythrun` repo's lifecycle retention 20 → 50 for an extra few days of rollback headroom.

**Files:**
- Modify: `infra/environments/shared/main.tf`

- [ ] **Step 1: Bump ECR lifecycle retention count 20 → 50**

Open `infra/environments/shared/main.tf`. Find line 71 (`countNumber = 20` inside rule #2 of `aws_ecr_lifecycle_policy.mythrun`). Change `20` to `50`.

- [ ] **Step 2: Add `aws_ecr_pull_through_cache_rule.docker_hub`**

At the end of the existing ECR block (immediately after the `aws_ecr_lifecycle_policy.mythrun` resource, so approximately line 77), add:

```hcl
# ======== ECR pull-through cache for Docker Hub ========
# Routes base-image pulls (node:24-alpine et al.) through our ECR instead
# of Docker Hub directly. Avoids the 100-pulls/6h anonymous rate limit
# that GitHub-hosted runner IP pools can trigger at team scale, and
# improves cold-start latency by keeping pulls in-region.
# Cache repos (e.g., docker-hub/library/node) are auto-created on first pull.
# IAM additions in the staging workspace's GH Actions role policy (MYT-28).

resource "aws_ecr_pull_through_cache_rule" "docker_hub" {
  ecr_repository_prefix = "docker-hub"
  upstream_registry_url = "registry-1.docker.io"
}
```

- [ ] **Step 3: Run `terraform plan` on the shared workspace**

Run: `cd infra/environments/shared && terraform plan -out=tfplan.t7 2>&1 | tee ../../../.plan-t7.out`
Expected: plan shows exactly two changes:
1. `aws_ecr_pull_through_cache_rule.docker_hub` will be **created**
2. `aws_ecr_lifecycle_policy.mythrun` will be **modified** (the policy JSON's rule #2 countNumber changes 20 → 50)

No other resources should change. If the plan shows a task-def diff or cluster diff, investigate immediately.

- [ ] **Step 4: Commit**

```bash
git add infra/environments/shared/main.tf
git commit -m "feat(infra): ECR pull-through cache for Docker Hub + retention 20→50

Adds aws_ecr_pull_through_cache_rule to avoid Docker Hub anonymous
rate limits on shared GitHub runner IPs. Bumps ECR lifecycle retention
on mythrun repo from 20 to 50 tagged images for ~5-day rollback window
at 10 merges/day (vs ~2 days previously).

Apply lands with staging IAM additions (MYT-28 next commit)."
rm .plan-t7.out infra/environments/shared/tfplan.t7
```

---

## Task 8: Terraform — IAM additions for pull-through cache

**Context:** The pull-through cache rule alone doesn't authorize the GH Actions role to USE the cache. The role needs `ecr:CreateRepository` (to auto-create cache repos on first pull) + `ecr:BatchImportUpstreamImage` (to trigger the Docker Hub pull), scoped to the `docker-hub/*` prefix. Also extends the existing ECR pull statement to include the cache-repo prefix so the role can pull from the cached images.

**Files:**
- Modify: `infra/environments/staging/main.tf` (lines 182–263)

- [ ] **Step 1: Extend the existing ECR pull statement's resources**

Find the statement at lines 189–203 (the one with `ecr:BatchCheckLayerAvailability`, etc., scoped to the `mythrun` repo). Replace its `resources` block:

Before (line 200–202):
```hcl
    resources = [
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun",
    ]
```

After:
```hcl
    resources = [
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/mythrun",
      "arn:aws:ecr:us-east-1:${data.aws_caller_identity.current.account_id}:repository/docker-hub/*",
    ]
```

- [ ] **Step 2: Add a new statement for pull-through cache creation**

Immediately after the statement you just modified (ending around line 203), insert:

```hcl
  # Pull-through cache: auto-create cache repos + trigger upstream pulls.
  # Scoped to the docker-hub/* prefix (set by the shared workspace's
  # aws_ecr_pull_through_cache_rule.docker_hub). Without these, the first
  # `docker pull` through the cache fails at ECR authz.
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

- [ ] **Step 3: Run `terraform plan` on the staging workspace**

Run: `cd infra/environments/staging && terraform plan -out=tfplan.t8 2>&1 | tee ../../../.plan-t8.out`
Expected: plan shows exactly one change: `aws_iam_role_policy.github_actions_staging` will be **modified** (the policy JSON gains the new statement + extended resources on the existing statement). No resource replacements. No other resources touched.

- [ ] **Step 4: Commit**

```bash
git add infra/environments/staging/main.tf
git commit -m "feat(infra): extend GH Actions staging IAM for pull-through cache

Adds ecr:CreateRepository + ecr:BatchImportUpstreamImage (scoped to
docker-hub/* prefix) so the role can trigger upstream pulls when a
base image isn't yet cached. Extends existing ECR pull statement's
resources to include the cache-repo prefix.

This is a conjugate of MYT-28 Task 7 (shared workspace pull-through-
cache rule). Both must apply together before the first CI build run."
rm .plan-t8.out infra/environments/staging/tfplan.t8
```

---

## Task 9: Apply Terraform — USER GATE

**Context:** Now we have three Terraform changes staged (Tasks 6, 7, 8). Before MYT-28's workflow can successfully deploy, these need to land in AWS. Two applies: shared first (creates the pull-through cache rule), then staging (adds IAM permissions that reference it).

**Cost delta:** < $1/mo total. Pull-through cache rule is free; cache storage is ~$0.20/mo; retention bump is ~$0.30/mo.

**Files:** none — this is a `terraform apply` task.

- [ ] **Step 1: Run `terraform plan` on shared workspace (final pre-apply review)**

Run: `cd infra/environments/shared && terraform plan`
Expected: 2 changes — create `aws_ecr_pull_through_cache_rule.docker_hub`, update `aws_ecr_lifecycle_policy.mythrun`.

- [ ] **Step 2: USER GATE — ask for approval to apply**

Stop. Present the plan output to Miklos. State:
> "Shared workspace apply: creates an ECR pull-through cache rule for Docker Hub and bumps image retention 20→50. Cost delta ~$0.20/mo. Approve?"

Wait for explicit "yes apply" / "go ahead" / equivalent.

- [ ] **Step 3: Apply shared**

Run: `cd infra/environments/shared && terraform apply`
Type `yes` at the prompt (or pass `-auto-approve` if the user prefers).
Expected: `Apply complete! Resources: 1 added, 1 changed, 0 destroyed.`

- [ ] **Step 4: Run `terraform plan` on staging workspace**

Run: `cd infra/environments/staging && terraform plan`
Expected: 1 change — update `aws_iam_role_policy.github_actions_staging`.

Also expected: changes related to Task 6 (task-def lifecycle blocks) may appear here IF the staging workspace uses the serving module that was modified. Verify the plan output shows either (a) no serving-module drift (lifecycle blocks don't trigger re-plan), or (b) task-def resources with the `lifecycle` annotation addition but **no replacement**. If any resource says "must be replaced" (leading `-/+` sigil), stop and investigate.

- [ ] **Step 5: USER GATE — ask for approval to apply staging**

Stop. Present the plan. State:
> "Staging workspace apply: adds 2 ECR actions (CreateRepository, BatchImportUpstreamImage) scoped to docker-hub/* prefix, and extends the existing ECR pull statement to include the cache-repo prefix. No resource replacements. Approve?"

Wait for explicit approval.

- [ ] **Step 6: Apply staging**

Run: `cd infra/environments/staging && terraform apply`
Expected: `Apply complete! Resources: 0 added, 1 changed, 0 destroyed.` (or +task-def lifecycle annotations if they show up here).

- [ ] **Step 7: Verify the pull-through cache rule is live**

Run: `aws ecr describe-pull-through-cache-rules --query 'pullThroughCacheRules[?ecrRepositoryPrefix==\`docker-hub\`]'`
Expected: one rule returned with `upstreamRegistryUrl: "registry-1.docker.io"`.

- [ ] **Step 8: Idempotency gate**

Run: `cd infra/environments/shared && terraform plan`
Run: `cd infra/environments/staging && terraform plan`
Expected: both report "No changes. Your infrastructure matches the configuration."

No commit in this task — the commits landed in Tasks 6-8. If the applies modified any `.terraform.lock.hcl` files, commit those with `chore(infra): update terraform provider locks`.

---

## Task 10: `.github/dependabot.yml`

**Context:** SHA-pinning actions (Task 12) closes supply-chain attacks but pins rot over time. Dependabot proposes weekly bump PRs, reviewed by hand — never auto-merged.

**Files:**
- Create: `.github/dependabot.yml`

- [ ] **Step 1: Create the config**

Create `.github/dependabot.yml`:

```yaml
version: 2
updates:
  # GitHub Actions version bumps (for SHA-pinned action references in
  # .github/workflows/*.yml). Proposes PRs weekly; reviewed by hand,
  # never auto-merged — every bump is a new audit opportunity.
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
    open-pull-requests-limit: 5
```

- [ ] **Step 2: Commit**

```bash
git add .github/dependabot.yml
git commit -m "ci: Dependabot config for github-actions ecosystem

Weekly PRs to bump SHA-pinned action references in deploy.yml.
No auto-merge — each PR is a manual security-audit opportunity."
```

---

## Task 11: Resolve action SHAs

**Context:** The workflow file pins each third-party action by commit SHA, with the version tag as a trailing comment. This is a research task — look up the current SHA for each action's current release. Done manually once; Dependabot maintains it after.

**Tooling:** for each action, fetch the releases page and get the SHA for the target tag. The `gh` CLI works: `gh api repos/<org>/<repo>/git/refs/tags/<version> --jq '.object.sha'` for lightweight tags, or `gh release view <version> -R <org>/<repo> --json tagName,targetCommitish` for others. Browser is also fine.

**Target versions** (from spec):
- `actions/checkout@v4.2.2`
- `pnpm/action-setup@v4.1.0`
- `actions/setup-node@v6.0.0`
- `aws-actions/configure-aws-credentials@v4.1.0`
- `aws-actions/amazon-ecr-login@v2.0.1`
- `aws-actions/amazon-ecs-render-task-definition@v1.7.3`
- `aws-actions/amazon-ecs-deploy-task-definition@v2.3.2`

**Files:** none (output is a list of SHAs consumed by Task 12).

- [ ] **Step 1: Fetch SHAs**

For each action, run (replacing `<org>/<repo>` and `<version>`):

```bash
gh api "repos/<org>/<repo>/git/refs/tags/<version>" --jq '.object.sha'
```

If the tag is annotated (returns `"type": "tag"` in the first response), dereference:
```bash
gh api "repos/<org>/<repo>/git/tags/<tag-sha>" --jq '.object.sha'
```

Record each SHA. Example for `actions/checkout@v4.2.2`:
```bash
gh api "repos/actions/checkout/git/refs/tags/v4.2.2" --jq '.object.sha'
```

If `gh` isn't configured, browser: visit `https://github.com/<org>/<repo>/releases/tag/<version>` and copy the SHA from the source-code link.

- [ ] **Step 2: Sanity-check one SHA**

Pick any one action/SHA. Verify the SHA is a real commit on the correct release:
```bash
gh api "repos/actions/checkout/commits/<sha>" --jq '.sha + " " + .commit.message'
```
Expected: output starts with the SHA and shows a release-like commit message (tag/version reference). If the SHA is a 404, re-fetch.

- [ ] **Step 3: Record the SHAs**

Keep the SHA list in the implementation agent's working memory for Task 12. No file to commit; the SHAs get baked into the workflow YAML directly.

---

## Task 12: Create `.github/workflows/deploy.yml`

**Context:** This is the whole pipeline: build → push → resolve digest → render task-def → deploy → poll rolloutState → smoke test. Uses the SHAs from Task 11. Full file content below.

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/deploy.yml` with the content below. Replace each `<SHA>` placeholder with the corresponding value from Task 11.

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
  # deploys or the prod append will not share a group with staging.
  group: deploy-mythrun-staging-api
  cancel-in-progress: false

env:
  AWS_REGION: us-east-1
  ECR_REPO: mythrun
  BASE_IMAGE_REF: docker-hub/library/node:24-alpine

jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: staging
    outputs:
      image: ${{ steps.digest.outputs.image }}
    steps:
      - uses: actions/checkout@<SHA>  # v4.2.2

      - uses: pnpm/action-setup@<SHA>  # v4.1.0

      - uses: actions/setup-node@<SHA>  # v6.0.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      # Scope install to backend + transitive workspace deps so sibling
      # workspace issues (e.g., @mythrun/wiki) don't red-light a backend
      # deploy. --frozen-lockfile still validates the full lockfile.
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
        # Load-bearing: pnpm install above runs BEFORE OIDC assume so npm
        # lifecycle scripts cannot exfiltrate AWS creds.
        uses: aws-actions/configure-aws-credentials@<SHA>  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Login to ECR
        id: ecr
        uses: aws-actions/amazon-ecr-login@<SHA>  # v2.0.1

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
          # RepoDigests is populated by docker after a successful push —
          # <registry>/<repo>@sha256:<digest>. Reading docker's local record
          # bypasses any window where an attacker with ECR push could re-tag
          # between our push and an ECR describe-images call.
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
        uses: aws-actions/configure-aws-credentials@<SHA>  # v4.1.0
        with:
          role-to-assume: arn:aws:iam::${{ vars.AWS_ACCOUNT_ID }}:role/mythrun-github-actions-staging
          aws-region: ${{ env.AWS_REGION }}

      - name: Fetch current task definition
        # The render-task-definition action strips read-only fields itself;
        # no jq 'del(...)' pre-strip needed.
        run: |
          set -euo pipefail
          aws ecs describe-task-definition \
            --task-definition "${{ env.TASK_DEF_FAMILY }}" \
            --query 'taskDefinition' \
            > task-def.json

      - name: Render new task definition with digest image
        id: taskdef
        uses: aws-actions/amazon-ecs-render-task-definition@<SHA>  # v1.7.3
        with:
          task-definition: task-def.json
          container-name: ${{ env.CONTAINER_NAME }}
          image: ${{ needs.build.outputs.image }}

      - name: Deploy new revision
        # Does NOT check rolloutState — see the explicit poll step below.
        uses: aws-actions/amazon-ecs-deploy-task-definition@<SHA>  # v2.3.2
        with:
          task-definition: ${{ steps.taskdef.outputs.task-definition }}
          cluster: ${{ env.ECS_CLUSTER }}
          service: ${{ env.ECS_SERVICE }}
          wait-for-service-stability: true
          wait-for-minutes: 15

      - name: Ensure desired-count is 1
        # First deploy: flips 0 → 1. Subsequent: no-op. Runs AFTER deploy
        # action so ECS never tries to place on the :placeholder revision.
        run: |
          aws ecs update-service \
            --cluster "${{ env.ECS_CLUSTER }}" \
            --service "${{ env.ECS_SERVICE }}" \
            --desired-count 1 > /dev/null

      - name: Verify deployment completed (poll rolloutState)
        # `aws ecs wait services-stable` returns SUCCESS even after
        # circuit-breaker rollback. Poll rolloutState to catch that.
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

            if [[ "$ROLLOUT" == "FAILED" ]]; then
              echo "::error::Deployment FAILED (circuit breaker). See MYT-30 Risks §6 for recovery."
              exit 1
            fi

            if [[ "$ROLLOUT" == "COMPLETED" && "$RUNNING" == "$DESIRED" && "$FAILED" == "0" ]]; then
              echo "Deployment verified."
              exit 0
            fi

            if [[ "$attempt" -lt "$max_attempts" ]]; then
              sleep 10
            fi
          done
          echo "::error::Deployment did not reach COMPLETED within 2 min"
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

- [ ] **Step 2: Validate the YAML syntax locally**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))" && echo "YAML OK"`
Expected: prints `YAML OK`. If PyYAML isn't installed: `pip3 install pyyaml` or use `npx yaml-lint .github/workflows/deploy.yml`.

- [ ] **Step 3: Confirm every `<SHA>` placeholder has been replaced**

Run: `grep -c '<SHA>' .github/workflows/deploy.yml`
Expected: `0`. If any count > 0, stop and resolve before proceeding.

- [ ] **Step 4: Commit (workflow file but do not push yet — push is Task 14)**

```bash
git add .github/workflows/deploy.yml
git commit -m "ci: MYT-28 staging deploy workflow

build + deploy-staging jobs wired to mythrun-github-actions-staging OIDC
role. register-then-update task-def sequencing via
amazon-ecs-deploy-task-definition action. Explicit rolloutState poll
catches silent circuit-breaker rollback (action uses 'services-stable'
wait which returns success on rollback). 3-retry smoke test with jq
body match on /health.

Digest resolved via 'docker inspect' RepoDigests — no ECR describe-images
call, closes the push→describe TOCTOU window.

Closes MYT-28."
```

---

## Task 13: Configure GitHub Environment — MIKLOS MANUAL

**Context:** The OIDC trust requires a GitHub Environment named `staging`. The workflow's `environment: staging` declaration also causes GitHub to look up `vars.AWS_ACCOUNT_ID` from the environment's variables.

**Files:** none (GitHub UI).

- [ ] **Step 1: Ask Miklos to configure the environment**

Instruct Miklos:

> Open https://github.com/mythrun/mythrun/settings/environments and click **New environment**.
>
> **Name:** `staging` (lowercase, exact)
>
> **Deployment branches and tags:** click **Selected branches and tags** → add rule `main` (branch, not tag).
>
> **Environment variables** (NOT secrets — click the variables tab):
> - Name: `AWS_ACCOUNT_ID`
> - Value: the 12-digit numeric AWS account ID (you can get it via `aws sts get-caller-identity --query Account --output text`)
>
> Do NOT set required reviewers, wait timer, or environment secrets. Save.

- [ ] **Step 2: Verify the environment exists via gh CLI**

Run: `gh api repos/mythrun/mythrun/environments/staging --jq '.name + " " + (.deployment_branch_policy.protected_branches | tostring)'`
Expected: `staging true` (or similar — the exact output confirms the environment was created with branch restriction).

- [ ] **Step 3: Verify the variable is set**

Run: `gh api repos/mythrun/mythrun/environments/staging/variables --jq '.variables[].name'`
Expected: `AWS_ACCOUNT_ID` (on its own line). If empty, the variable wasn't saved — ask Miklos to redo step 1's variables section.

No commit — GitHub UI config isn't version-controlled.

---

## Task 14: First deploy push — USER GATE

**Context:** All code and Terraform is committed locally. The workflow file is the last commit. Pushing to `main` triggers the first real CI run, which will:
1. Build + push the real image to ECR (triggering the pull-through cache on first base-image pull)
2. Register a new task-def revision with the digest image
3. Flip the service from `desired_count=0` → `1`
4. Poll rolloutState for up to 2 minutes
5. Curl `https://staging-api.mythrun.com/health` and expect `{"status":"ok"}`

This will take 5–10 minutes and is the first real exercise of all the infrastructure MYT-30 and MYT-28 built.

**Files:** none — a `git push` triggers everything.

- [ ] **Step 1: Confirm local state is ready**

Run: `git status && git log --oneline -15`
Expected: clean working tree, recent commits include all of Tasks 1–12 (8 expected: backend factory, shutdown, server.ts, .dockerignore, Dockerfile, task-def lifecycle, pull-through cache + retention, IAM, dependabot, workflow).

- [ ] **Step 2: Confirm Task 9 applies landed**

Run:
```bash
aws ecr describe-pull-through-cache-rules --query 'pullThroughCacheRules[?ecrRepositoryPrefix==`docker-hub`]' --output table
aws iam get-role-policy --role-name mythrun-github-actions-staging --policy-name deploy-permissions --query 'PolicyDocument.Statement[?Action[0]==`ecr:CreateRepository`]' --output json
```
Expected: first command shows the pull-through rule; second command returns the `ecr:CreateRepository` statement. If either is empty, Task 9 didn't fully land — investigate before pushing.

- [ ] **Step 3: Confirm Task 13 landed**

Run: `gh api repos/mythrun/mythrun/environments/staging/variables --jq '.variables[].name'`
Expected: `AWS_ACCOUNT_ID`. If empty, Task 13 didn't complete.

- [ ] **Step 4: USER GATE — ask for approval to push**

Stop. Summarize state to Miklos:
> "Local is ready. Pushing will trigger the first real staging deploy: builds the backend image, pushes to ECR, registers task-def rev 2, flips service to desiredCount=1, and smoke-tests. Expected duration 5–10 min. Cost delta: ~$7/mo once staging is running continuously. Approve push?"

Wait for explicit approval.

- [ ] **Step 5: Push**

Run: `git push origin main`
Expected: GitHub receives push; Actions tab shows the `Deploy` workflow running.

- [ ] **Step 6: Watch the workflow**

Run: `gh run watch --exit-status` (optionally `gh run view --web` to open in browser).
Expected: both `build` and `deploy-staging` jobs succeed; total ~5–10 min.

If `build` fails:
- Red on lint/typecheck/test → fix code, push again.
- Red on ECR login → check OIDC trust matches GH Environment config.
- Red on docker push → check ECR lifecycle + IAM scope.

If `deploy-staging` fails:
- Red on describe-task-definition → check IAM.
- Red on deploy-task-def action timeout (15 min) → inspect ECS service events via `aws ecs describe-services`.
- Red on "rolloutState FAILED" → ECS circuit breaker fired. See MYT-30 Risks §6:
  ```
  aws ecs describe-services --cluster mythrun --services mythrun-staging-api --query 'services[0].events[:10]'
  ```
  Identify root cause (image won't boot, task-def misconfigured, etc.), fix, push again.
- Red on smoke test → ECS healthy but external path broken. Check Route 53 + ALB listener rule + cert.

- [ ] **Step 7: Verify Done-when items 1, 2, 3, 4, 7, 8 from the spec**

Run each:

```bash
# Item 1/2/4: service at desired=running=1, rolloutState COMPLETED
aws ecs describe-services --cluster mythrun --services mythrun-staging-api \
  --query 'services[0].{running:runningCount,desired:desiredCount,taskDef:taskDefinition,rolloutState:deployments[0].rolloutState,failed:deployments[0].failedTasks}'

# Item 2: running image is digest-addressed
TASK_ARN=$(aws ecs list-tasks --cluster mythrun --service-name mythrun-staging-api --query 'taskArns[0]' --output text)
aws ecs describe-tasks --cluster mythrun --tasks "$TASK_ARN" --query 'tasks[0].containers[0].image'

# Item 3: external /health
curl -v https://staging-api.mythrun.com/health

# Item 7: :placeholder invariant
aws ecr describe-images --repository-name mythrun --image-ids imageTag=placeholder 2>&1

# Item 8: pull-through cache wired + at least one cache hit
aws ecr describe-pull-through-cache-rules --query 'pullThroughCacheRules[?ecrRepositoryPrefix==`docker-hub`]'
aws ecr describe-repositories --repository-names docker-hub/library/node 2>&1
```

Expected per item:
- running=desired=1, rolloutState=COMPLETED, failed=0, taskDef ends in `:2` (or higher if earlier runs created orphan revs)
- image is `<account>.dkr.ecr.us-east-1.amazonaws.com/mythrun@sha256:<64-hex>`
- HTTP 200, body `{"status":"ok"}`, TLS handshake presenting `*.mythrun.com` cert
- `ImageNotFoundException` for `:placeholder`
- one pull-through cache rule returned; `docker-hub/library/node` repo exists (auto-created on first pull during this deploy)

If any verification fails, investigate and fix before proceeding.

---

## Task 15: Idempotency check + close Linear/beads

**Context:** Spec Done-when #5 requires a second push to produce revision 3+ with the same smooth flow (proves the workflow isn't accidentally first-deploy-specific). Also wraps up by closing the Linear issue and the two beads that this work resolves.

**Files:**
- Modify: any file to make a second code-path commit (e.g., add a newline to a comment)

- [ ] **Step 1: Make a trivial code commit**

Run:
```bash
# A minimal, code-path change. Adds a trailing newline to app.ts if missing.
printf '\n' >> backend/src/app.ts
git add backend/src/app.ts
git commit -m "chore(myt-28): verify deploy idempotency"
git push origin main
```

(If the file already ends in newline and no change, use a different harmless edit — add a brief comment line in `backend/src/app.ts`, or bump a README under an already-non-ignored path.)

- [ ] **Step 2: Watch the second workflow run**

Run: `gh run watch --exit-status`
Expected: green in 5–10 min.

- [ ] **Step 3: Verify Done-when items 5 and 6**

```bash
# Item 5: new revision (≥ prior+1)
aws ecs describe-services --cluster mythrun --services mythrun-staging-api \
  --query 'services[0].taskDefinition'
# Expected: arn ending in :3 or higher

# Item 6(b): prior task stopped cleanly (exit code 0)
STOPPED_ARN=$(aws ecs list-tasks --cluster mythrun --service-name mythrun-staging-api \
  --desired-status STOPPED --query 'taskArns[-1]' --output text)
aws ecs describe-tasks --cluster mythrun --tasks "$STOPPED_ARN" \
  --query 'tasks[0].{stoppedReason:stoppedReason,stopCode:stopCode,exitCode:containers[0].exitCode}'
# Expected: exitCode=0, stopCode=EssentialContainerExited. exitCode=137 = SIGKILL (bad — handler didn't drain).
```

Item 6(a) — unit test coverage of `createShutdown` — was already verified in Task 2 by `pnpm test`.

- [ ] **Step 4: Close the Linear issue**

Use the Linear MCP tool to move MYT-28 to Done. The hook dispatches a wiki-update agent automatically after close — let it run to completion; it'll commit wiki updates in its own commits.

```
mcp__linear-server__save_issue with id=MYT-28, status=Done
```

Include a brief closing note in the Linear issue describing the final state (workflow live, first deploy green, beads closed, follow-up beads filed).

- [ ] **Step 5: Close the resolved beads**

Run:
```bash
bd close myth-3v4 --reason "Closed by MYT-28 (CI/CD + first staging deploy). SIGTERM handler lives in backend/src/app.ts's createShutdown pure function; unit-tested in shutdown.test.ts; wired in server.ts."
bd close myth-nu9 --reason "Closed by MYT-28. server.ts → app.ts factory split: buildApp + createShutdown export from app.ts; server.ts is a thin entrypoint. Tests in app.test.ts + shutdown.test.ts."
```

- [ ] **Step 6: Final push + session close**

If the wiki-update agent committed anything, ensure it's pushed:

```bash
git status
git log --oneline -5
git push origin main   # if any un-pushed commits
```

Done. MYT-28 shipped.

---

## Summary of commits expected (in order)

1. `refactor(backend): extract buildApp to app.ts for test isolation` (Task 1)
2. `feat(backend): add createShutdown pure function with unit test` (Task 2)
3. `refactor(backend): make server.ts a thin entrypoint over app.ts` (Task 3)
4. `build(backend): tighten .dockerignore for smaller build context` (Task 4)
5. `build(backend): parameterize base image via BASE_IMAGE_REGISTRY ARG` (Task 5)
6. `fix(infra): add create_before_destroy to task defs (MYT-28 / Duncan review)` (Task 6)
7. `feat(infra): ECR pull-through cache for Docker Hub + retention 20→50` (Task 7)
8. `feat(infra): extend GH Actions staging IAM for pull-through cache` (Task 8)
9. (no commit — Task 9 is `terraform apply`)
10. `ci: Dependabot config for github-actions ecosystem` (Task 10)
11. (no commit — Task 11 is SHA research)
12. `ci: MYT-28 staging deploy workflow` (Task 12)
13. (no commit — Task 13 is GitHub UI config)
14. (no commit — Task 14 is the first push; commits already live)
15. `chore(myt-28): verify deploy idempotency` (Task 15)

Expected ~11 commits across the implementation, plus zero-to-several from the post-close wiki-update agent.

---

## Rollback (if needed)

If MYT-28 ships something broken:

- **Backend code regression:** `git revert <sha> && git push` redeploys the reverted state through the same pipeline.
- **Terraform regression:** `git revert` the Terraform commit(s), then `terraform apply` in the affected workspace(s).
- **Stuck ECS deploy:** Per MYT-30 Risks §6:
  ```
  aws ecs update-service --cluster mythrun --service mythrun-staging-api \
    --force-new-deployment --task-definition mythrun-staging-api:<last-good-rev>
  ```
  If still stuck, `--desired-count 0` drain, then redeploy.
- **Pull-through cache issue:** ECR's fallback is that pulls fail cleanly; remove the pull-through-cache rule + revert the Dockerfile to direct `FROM node:24-alpine`.

No formal runbook is part of MYT-28 scope (deferred to `myth-bcx`).
