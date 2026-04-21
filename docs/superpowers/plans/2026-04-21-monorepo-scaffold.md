# Monorepo Scaffold Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a pnpm monorepo with a minimal Fastify backend that serves `GET /health`, passes TDD-driven tests, strict TypeScript type-checking, ESLint/Prettier, and a working multi-stage Dockerfile.

**Architecture:** pnpm workspace (root) with one package (`backend/`). Fastify 5 under strict TypeScript. Tests colocated in `__tests__/` subdirectories alongside source. Multi-stage Dockerfile builds from repo root (so pnpm workspace config is visible to the build) and produces a non-root, health-checked runtime image.

**Tech Stack:** pnpm 10, Node 24 LTS, TypeScript 5 (strict + NodeNext), Fastify 5, Vitest, ESLint 9 (flat config) + `typescript-eslint`, Prettier 3, Docker (multi-stage, `node:24-alpine`).

**Linear issue:** MYT-27
**Design spec:** `docs/superpowers/specs/2026-04-21-monorepo-scaffold-design.md`

---

## Pre-flight notes

- The repo already contains: `CLAUDE.md`, `ONBOARDING.md`, `README.md`, `docs/`, `.beads/`, `.claude/settings.json`, and an `AGENTS.md` that beads auto-generated. The AGENTS.md will be replaced with a thin pointer version in Task 8.
- Build context for Docker is **repo root**, not `backend/`. The Dockerfile lives at `backend/Dockerfile` but build command uses `-f backend/Dockerfile .`.
- ESLint uses `typescript-eslint` (single meta-package, not `@typescript-eslint/parser`+`@typescript-eslint/eslint-plugin`) because that's the flat-config pattern for ESLint 9. This differs from the spec's devDependencies list (which used legacy package names) — the config goal is identical, only the npm package names differ.
- After each commit, `git push` is optional per-task. At minimum, push before ending the session.

---

## Task 1: Root-level workspace scaffolding

**Files:**

- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.nvmrc`
- Create: `.gitignore`

- [ ] **Step 1: Create `package.json` at repo root**

```json
{
  "name": "mythrun",
  "private": true,
  "packageManager": "pnpm@10.30.3",
  "engines": { "node": ">=24.0.0" },
  "scripts": {
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "test": "pnpm -r test",
    "build": "pnpm -r build",
    "dev": "pnpm --filter backend dev",
    "format": "prettier --write .",
    "format:check": "prettier --check ."
  },
  "devDependencies": {
    "prettier": "^3.3.0",
    "eslint": "^9.15.0",
    "typescript-eslint": "^8.15.0",
    "eslint-config-prettier": "^9.1.0"
  }
}
```

- [ ] **Step 2: Create `pnpm-workspace.yaml`**

```yaml
packages:
  - 'backend'
```

- [ ] **Step 3: Create `.nvmrc`**

```
24
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
*.log
.env
.env.*
!.env.*.example
.DS_Store
.vscode/
.idea/
*.tsbuildinfo
.terraform/
*.tfstate
*.tfstate.backup
.terraform.lock.hcl
```

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-workspace.yaml .nvmrc .gitignore
git commit -m "chore: root pnpm workspace scaffolding

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend package manifest and first install

**Files:**

- Create: `backend/package.json`
- Created by install: `pnpm-lock.yaml`, `node_modules/`

- [ ] **Step 1: Create `backend/package.json`**

```json
{
  "name": "@mythrun/backend",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "lint": "eslint src --no-error-on-unmatched-pattern",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fastify": "^5.1.0"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "tsx": "^4.19.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0"
  }
}
```

Note the `--no-error-on-unmatched-pattern` on the lint script — lets it succeed when `src/` is empty (which it is right now, before Task 6). Remove this flag in a later cleanup if the stricter default is preferred once src has files.

- [ ] **Step 2: Run first install**

```bash
pnpm install
```

Expected: pnpm creates `pnpm-lock.yaml` and `node_modules/`. Exits cleanly. You'll see a message like `Progress: resolved X, reused Y, downloaded Z`.

- [ ] **Step 3: Verify install worked**

```bash
ls pnpm-lock.yaml node_modules/.pnpm/ | head -5
```

Expected: `pnpm-lock.yaml` exists and `node_modules/.pnpm/` contains dependency entries.

- [ ] **Step 4: Commit**

```bash
git add backend/package.json pnpm-lock.yaml
git commit -m "chore: add backend package with Fastify + TypeScript + Vitest

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

Note: `node_modules/` is gitignored, so it's not staged. Only `backend/package.json` and `pnpm-lock.yaml` go in.

---

## Task 3: TypeScript configuration

**Files:**

- Create: `backend/tsconfig.json`
- Create: `backend/tsconfig.build.json`

- [ ] **Step 1: Create `backend/tsconfig.json` (base)**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "esModuleInterop": true,
    "skipLibCheck": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": false,
    "resolveJsonModule": true,
    "forceConsistentCasingInFileNames": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 2: Create `backend/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["**/__tests__/**", "**/*.test.ts"]
}
```

- [ ] **Step 3: Verify typecheck succeeds (src/ is still empty — this checks config validity)**

```bash
mkdir -p backend/src
pnpm --filter @mythrun/backend typecheck
```

Expected: exits 0 with no output. If you see `error TS18003: No inputs were found`, that's fine — `tsconfig.json` has `include: ["src/**/*"]` and the empty `src/` matches nothing. Handle by creating a placeholder or accept non-zero exit here. To get a clean exit without files, add `"noEmit": true` only via the command flag (already done) — tsc 5.x tolerates empty matches when `noEmit` is set. If it still errors, skip this step — Task 6 creates real source files and the typecheck will succeed then.

- [ ] **Step 4: Commit**

```bash
git add backend/tsconfig.json backend/tsconfig.build.json
git commit -m "chore: strict TypeScript config for backend

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: ESLint + Prettier configuration

**Files:**

- Create: `eslint.config.js` (repo root)
- Create: `.prettierrc.json` (repo root)
- Create: `.prettierignore` (repo root)

- [ ] **Step 1: Create `eslint.config.js`**

```javascript
import tseslint from 'typescript-eslint'
import eslintConfigPrettier from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', '.beads/**', '**/*.config.js'],
  },
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Default exports are forbidden. Use named exports only.',
        },
      ],
      'max-lines': ['warn', { max: 400, skipBlankLines: true, skipComments: true }],
      'max-lines-per-function': ['warn', { max: 50, skipBlankLines: true, skipComments: true }],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  eslintConfigPrettier,
)
```

Key choices:

- `projectService: true` lets typescript-eslint auto-discover the tsconfig for each linted file (handles monorepo nested tsconfigs cleanly).
- `tsconfigRootDir: import.meta.dirname` anchors it to the repo root.
- `eslintConfigPrettier` must be the **last** element — it overrides earlier formatting rules so Prettier has sole authority on formatting.
- Config files themselves are in `ignores` so they don't get type-checked as part of the main project.

- [ ] **Step 2: Create `.prettierrc.json`**

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always"
}
```

- [ ] **Step 3: Create `.prettierignore`**

```
dist/
node_modules/
pnpm-lock.yaml
docs/specs/
.beads/
```

- [ ] **Step 4: Verify Prettier runs**

```bash
pnpm format:check
```

Expected: either exits 0 ("All matched files use Prettier code style!") or exits 1 listing files that don't match. If it lists existing `CLAUDE.md` / `README.md` / `ONBOARDING.md` as malformatted, run `pnpm format` to fix, then re-check.

- [ ] **Step 5: Verify ESLint runs (still no src files)**

```bash
pnpm --filter @mythrun/backend lint
```

Expected: exits 0 with no output (no files to lint yet, thanks to `--no-error-on-unmatched-pattern`).

- [ ] **Step 6: Commit**

```bash
git add eslint.config.js .prettierrc.json .prettierignore
# If pnpm format modified any existing files, add them too:
git add -u
git commit -m "chore: ESLint (flat config) + Prettier setup

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Write the failing health-check test (TDD — test first)

**Files:**

- Create: `backend/src/__tests__/server.test.ts`

- [ ] **Step 1: Create the test file**

```typescript
import { describe, it, expect } from 'vitest'
import { buildApp } from '../server.js'

describe('GET /health', () => {
  it('returns {status: "ok"}', async () => {
    const app = buildApp()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })
})
```

Note the `../server.js` import — NodeNext module resolution requires `.js` extensions in relative imports **even though the actual file is `.ts`**. This is the single most common pitfall when starting a NodeNext TS project; if you forget the `.js`, TS will report `Cannot find module '../server'`.

- [ ] **Step 2: Run the test and verify it fails**

```bash
pnpm --filter @mythrun/backend test
```

Expected: fails with an error along the lines of `Failed to resolve import "../server.js"` or `Cannot find module` — because `backend/src/server.ts` does not exist yet. This is the "red" phase of TDD: the test defines "done," and it fails because the thing under test doesn't exist.

- [ ] **Step 3: Do NOT commit yet**

The test file is staged in working tree but not committed. The next task implements the server to make it pass; we commit both together.

---

## Task 6: Implement the health-check server (TDD — make it pass)

**Files:**

- Create: `backend/src/server.ts`

- [ ] **Step 1: Create `backend/src/server.ts`**

```typescript
import Fastify from 'fastify'

export const buildApp = () => {
  const app = Fastify({ logger: true })
  app.get('/health', async () => ({ status: 'ok' }))
  return app
}

const app = buildApp()
const port = Number(process.env.PORT ?? 3000)
await app.listen({ port, host: '0.0.0.0' })
```

Why `buildApp()` is exported: tests call it to get an app instance without needing to bind a real TCP port. `app.inject()` simulates HTTP calls in-process.

Why `host: '0.0.0.0'`: required inside Docker containers. `127.0.0.1` binds only to the container loopback, so port forwarding and ECS health probes both fail.

- [ ] **Step 2: Run the test and verify it passes**

```bash
pnpm --filter @mythrun/backend test
```

Expected: `✓ GET /health > returns {status: "ok"}` with exit code 0. TDD "green" phase.

- [ ] **Step 3: Run typecheck**

```bash
pnpm --filter @mythrun/backend typecheck
```

Expected: exits 0, no output.

- [ ] **Step 4: Run lint**

```bash
pnpm --filter @mythrun/backend lint
```

Expected: exits 0, no output. If ESLint complains about type-checked rules not finding a tsconfig, verify `eslint.config.js` has `projectService: true` set.

- [ ] **Step 5: Run format check**

```bash
pnpm format:check
```

Expected: exits 0. If it flags the new `.ts` files, run `pnpm format` and re-check.

- [ ] **Step 6: Commit both the test and implementation together**

```bash
git add backend/src/server.ts backend/src/__tests__/server.test.ts
git commit -m "feat: health check endpoint with TDD test coverage

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Verify the build produces a runnable artifact

**Files:**

- (none — this verifies existing config)

- [ ] **Step 1: Run build**

```bash
pnpm --filter @mythrun/backend build
```

Expected: exits 0. Creates `backend/dist/server.js` (and a directory structure mirroring `src/`, minus `__tests__/`).

- [ ] **Step 2: Verify `__tests__` is excluded from dist**

```bash
ls backend/dist/
ls backend/dist/__tests__/ 2>&1 | head -1
```

Expected: `backend/dist/` contains `server.js`. `backend/dist/__tests__/` does NOT exist (ls prints "No such file or directory"). If `__tests__/server.test.js` shows up, `tsconfig.build.json`'s exclude glob is wrong — fix and rebuild.

- [ ] **Step 3: Run the built artifact locally to smoke-test**

Start it in the background:

```bash
(cd backend && PORT=3001 node dist/server.js &) && sleep 1
curl -sS http://localhost:3001/health
```

Expected: `{"status":"ok"}`.

- [ ] **Step 4: Stop the local process**

```bash
pkill -f "node dist/server.js" || true
```

- [ ] **Step 5: No commit needed** (dist/ is gitignored; this task is pure verification).

---

## Task 8: Replace AGENTS.md with thin pointer

**Files:**

- Modify: `AGENTS.md` (currently beads auto-generated, replace wholesale)

- [ ] **Step 1: Overwrite `AGENTS.md` with thin pointer content**

```markdown
# Agent Instructions

This repo's canonical conventions live in [CLAUDE.md](./CLAUDE.md). Read it first.

## Beads (task tracking)

Work is tracked in `.beads/`. Quick reference:

- `bd ready` — find unblocked work
- `bd show <id>` — view issue
- `bd update <id> --status=in_progress` — claim
- `bd close <id>` — complete

Full beads workflow: `bd onboard`.

## Specs

Production design specs are in `docs/specs/`. Start with `2026-04-06-production-architecture-overview.md` if unfamiliar with the project.
```

- [ ] **Step 2: Commit**

```bash
git add AGENTS.md
git commit -m "docs: replace auto-generated AGENTS.md with thin pointer to CLAUDE.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Dockerfile + local container smoke test

**Files:**

- Create: `backend/Dockerfile`
- Create: `backend/.dockerignore`

- [ ] **Step 1: Create `backend/Dockerfile`**

```dockerfile
# ---- builder ----
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json ./backend/
RUN corepack enable && pnpm install --frozen-lockfile --filter @mythrun/backend
COPY backend/ ./backend/
WORKDIR /app/backend
RUN pnpm build

# ---- runtime ----
FROM node:24-alpine
WORKDIR /app
RUN addgroup -S mythrun && adduser -S mythrun -G mythrun
COPY --from=builder --chown=mythrun:mythrun /app/backend/dist ./dist
COPY --from=builder --chown=mythrun:mythrun /app/backend/package.json ./
COPY --from=builder --chown=mythrun:mythrun /app/backend/node_modules ./node_modules
USER mythrun
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget --quiet --tries=1 --spider http://localhost:3000/health || exit 1
CMD ["node", "dist/server.js"]
```

Why the full `node_modules/` from builder is copied rather than a fresh `--prod` install: simpler Dockerfile, consistent deps between build and runtime. Image is slightly larger because dev deps ride along — that's an acceptable tradeoff for the scaffold. Optimize in Platform milestone if needed.

- [ ] **Step 2: Create `backend/.dockerignore`**

```
node_modules
dist
**/__tests__
**/*.test.ts
.env*
*.log
```

- [ ] **Step 3: Build the image from repo root**

```bash
docker build -t mythrun -f backend/Dockerfile .
```

Expected: exits 0. The build walks through both stages. Final line: `Successfully tagged mythrun:latest` or similar.

Common failure modes:

- `lockfile is not up to date` → run `pnpm install` locally first so `pnpm-lock.yaml` is current.
- `EACCES` on COPY → verify the `mythrun` user was created before the COPY (it is, in this Dockerfile).
- `Cannot find module '/app/dist/server.js'` → the builder's `pnpm build` failed silently. Check builder stage output.

- [ ] **Step 4: Run the container and test the health endpoint**

```bash
docker run -d -p 3000:3000 --name mythrun-test mythrun
sleep 2
curl -sS http://localhost:3000/health
```

Expected: `{"status":"ok"}`.

- [ ] **Step 5: Verify non-root user inside container**

```bash
docker exec mythrun-test whoami
```

Expected: `mythrun` (not `root`).

- [ ] **Step 6: Verify HEALTHCHECK directive works**

```bash
docker inspect --format='{{.State.Health.Status}}' mythrun-test
```

Expected: `starting` (for the first 30s) or `healthy` (after the first probe interval). If it's `unhealthy`, the HEALTHCHECK wget command inside the container is failing — check that `wget` exists in `node:24-alpine` (it does) and that `/health` is reachable on localhost from inside the container.

- [ ] **Step 7: Stop and remove the test container**

```bash
docker stop mythrun-test && docker rm mythrun-test
```

- [ ] **Step 8: Commit**

```bash
git add backend/Dockerfile backend/.dockerignore
git commit -m "feat: multi-stage Dockerfile for backend with non-root user and HEALTHCHECK

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Final acceptance — run the spec's Done-when sequence end-to-end

**Files:** (none — pure verification)

- [ ] **Step 1: Run the full acceptance sequence from a clean working tree**

```bash
git status
```

Expected: clean (nothing to commit). If not, resolve before proceeding.

- [ ] **Step 2: From repo root, run each Done-when command**

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm lint
docker build -t mythrun -f backend/Dockerfile .
docker run -d -p 3000:3000 --name mythrun-accept mythrun
sleep 2
curl -sS http://localhost:3000/health
```

Expected:

- `pnpm install` — exits 0, "Already up to date."
- `pnpm test` — all tests pass
- `pnpm typecheck` — exits 0
- `pnpm lint` — exits 0
- `docker build` — exits 0
- `docker run` — prints a container ID
- `curl` — prints `{"status":"ok"}`

- [ ] **Step 3: Clean up acceptance container**

```bash
docker stop mythrun-accept && docker rm mythrun-accept
```

- [ ] **Step 4: Push all commits**

```bash
git push
```

Expected: pushes Tasks 1-9's commits to `origin/main`.

- [ ] **Step 5: Close MYT-27 in Linear**

Via MCP or the Linear UI: update MYT-27 state to `Done`.

---

## Self-review

The following sections from the spec are covered:

- **Goal + Done-when** → Tasks 5-10
- **Scope decisions (minimal)** → Task 6 (server is 10 lines, no logger/env/error-handler plugin)
- **Principles 1-8** → enforced via Tasks 1, 3, 4 (configs) and Task 6 (implementation)
- **Repo structure** → Tasks 1-9 create every file listed
- **Root `package.json`** → Task 1
- **Backend `package.json`** → Task 2
- **TypeScript config** → Task 3
- **ESLint config** → Task 4 (with corrected flat-config package names)
- **Prettier config** → Task 4
- **Health-check server + test** → Tasks 5 + 6
- **Dockerfile** → Task 9
- **AGENTS.md thin pointer** → Task 8
- **.gitignore, .nvmrc** → Task 1

No spec requirement is uncovered. Explicit non-goals (no config loader, no Pino, no auth, no frontend, etc.) are correctly absent — they belong to later milestones.

No placeholders remain. Every code step shows complete code; every verification step shows the exact command and expected output.

Type consistency verified: `buildApp` is the same name in Task 5 (test) and Task 6 (implementation). Package name `@mythrun/backend` is consistent across Task 2 (package.json), Task 9 (Dockerfile `--filter`), and all script invocations.
