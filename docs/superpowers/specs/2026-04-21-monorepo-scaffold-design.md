# Monorepo Scaffold Design

> **Linear issue**: MYT-27
> **Milestone**: Ops Foundation (2026-04-27)
> **Date**: 2026-04-21
> **Status**: Design approved; ready for implementation plan

## Goal

Set up a pnpm monorepo with a minimal Fastify backend that serves `GET /health`, runs tests, passes strict TypeScript type-checking, lints clean, builds into a multi-stage Docker image, and is committed to `main`.

This is the first real code in the Mythrun production repo. It is the smallest possible artifact that lets us prove the CI/CD deploy pipeline (MYT-28) works end-to-end. It is deliberately narrow — everything beyond a health check lands in the Backend Core milestone, not this one.

## Done when

```bash
pnpm install
pnpm test                                          # all tests pass
pnpm typecheck                                     # no TS errors
pnpm lint                                          # no ESLint errors
docker build -t mythrun -f backend/Dockerfile .    # image builds (repo-root context)
docker run -p 3000:3000 mythrun                    # container starts
curl http://localhost:3000/health                  # => {"status":"ok"}
```

> **Note:** the `docker build` command uses repo-root context (`.`) rather than `backend/` because the pnpm monorepo requires the Dockerfile to see both `pnpm-workspace.yaml` and `pnpm-lock.yaml` at the repo root. This is a deviation from MYT-27's original acceptance-criteria phrasing (`docker build -t mythrun backend/`) — MYT-27 will be updated to match.

All seven commands succeed from a fresh clone on a machine with Node 24 LTS, pnpm 10, and Docker.

## Scope decisions

**Intentionally minimal.** No DB connection, no Redis, no env-var loader, no logger abstraction, no error-handler plugin, no config module. Fastify's default logging is fine for the health check. Every piece of production infrastructure is added in Backend Core (Platform milestone), not now.

The risk of a deliberately minimal scaffold is that Backend Core will restructure what's here. That's acceptable — moving files is cheap, premature abstraction is expensive.

## Principles

These conventions are locked in for this scaffold and carry forward through the project:

1. **Agent-legibility first.** Small files, grep-friendly names, colocated tests, one-command verification, stable ecosystems. See memory `reference_agent_legible_code.md` for the full principle set.
2. **Tests live in `__tests__/` subdirectories next to source** (Meta/Jest convention — user preference).
3. **Strict TypeScript.** No `any`, no implicit any, strict null checks, `exactOptionalPropertyTypes`. Enforced by tsconfig and ESLint.
4. **No default exports** — enforced by ESLint via `no-restricted-syntax`.
5. **Function <50 lines, module <400 lines** — enforced by ESLint (`max-lines`, `max-lines-per-function`).
6. **Node 24 LTS** is the production target. Pinned in Dockerfile exactly, relaxed locally via `package.json` engines (`>=24.0.0`) so dev machines on Node 25 still work.
7. **Prettier handles formatting, ESLint handles correctness.** Separation prevents rule conflicts.
8. **No pre-commit hooks yet.** CI catches failures. Add lefthook later if rapid iteration creates friction.

## Repo structure

```
mythrun/
├── AGENTS.md                       # thin pointer → CLAUDE.md (non-Claude agent orientation)
├── CLAUDE.md                       # canonical project conventions (already exists)
├── ONBOARDING.md                   # (already exists)
├── README.md                       # (already exists)
├── package.json                    # root workspace + aggregate pnpm -r scripts
├── pnpm-workspace.yaml             # packages: [backend]
├── .nvmrc                          # 24
├── .gitignore                      # Node + TS + Terraform + editor detritus
├── .prettierrc.json                # shared formatter config
├── .prettierignore                 # dist, node_modules, pnpm-lock.yaml, docs/specs/
├── eslint.config.js                # flat config; shared across packages
├── .beads/                         # (already exists, git-committed)
├── .claude/settings.json           # (already exists — PostToolUse hook for plan→beads reminder)
├── docs/                           # (already exists)
└── backend/
    ├── package.json                # name: @mythrun/backend
    ├── tsconfig.json               # strict, NodeNext, target ES2023
    ├── tsconfig.build.json         # extends base; excludes __tests__/ and *.test.ts
    ├── Dockerfile                  # multi-stage, node:24-alpine, non-root, HEALTHCHECK
    ├── .dockerignore
    └── src/
        ├── server.ts               # builds Fastify app, listens on PORT
        └── __tests__/
            └── server.test.ts      # Vitest via app.inject()
```

Root-level `.prettierrc.json`, `.prettierignore`, and `eslint.config.js` are shared across all packages. When `frontend/` lands in Phase 3a, it inherits them automatically — no duplication.

## Root `package.json`

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
    "prettier": "^3.x"
  }
}
```

Aggregate scripts use `pnpm -r` so verification is one command from repo root regardless of CWD. Critical for agent workflows — no guessing which package to run in.

## Backend `package.json`

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
    "lint": "eslint src",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "fastify": "^5.x"
  },
  "devDependencies": {
    "@types/node": "^24.x",
    "tsx": "^4.x",
    "typescript": "^5.x",
    "vitest": "^3.x",
    "eslint": "^9.x",
    "@typescript-eslint/parser": "^8.x",
    "@typescript-eslint/eslint-plugin": "^8.x"
  }
}
```

## TypeScript config

**`backend/tsconfig.json`** (base; used by editors, ESLint, tests):

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
    "resolveJsonModule": true
  },
  "include": ["src/**/*"]
}
```

**`backend/tsconfig.build.json`**:

```json
{
  "extends": "./tsconfig.json",
  "exclude": ["**/__tests__/**", "**/*.test.ts"]
}
```

## ESLint config

**`eslint.config.js`** (flat config):

- Extends `@typescript-eslint/strict-type-checked` + `@typescript-eslint/stylistic-type-checked`
- Extends `eslint-config-prettier` last (disables all formatting rules)
- Custom rules:
  - `no-restricted-syntax: ["error", "ExportDefaultDeclaration"]` — no default exports
  - `max-lines: ["warn", 400]` — module size
  - `max-lines-per-function: ["warn", 50]` — function size
  - `@typescript-eslint/no-explicit-any: "error"`
  - `@typescript-eslint/no-non-null-assertion: "error"`
- Ignore: `dist/`, `node_modules/`, `docs/`, `.beads/`

## Prettier config

**`.prettierrc.json`**:

```json
{
  "semi": false,
  "singleQuote": true,
  "trailingComma": "all",
  "printWidth": 100,
  "arrowParens": "always"
}
```

**`.prettierignore`**: `dist/`, `node_modules/`, `pnpm-lock.yaml`, `docs/specs/`, `.beads/`.

## Health-check server

**`backend/src/server.ts`**:

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

- `buildApp()` is exported so tests can call `app.inject()` without a real listener.
- `host: '0.0.0.0'` is required for Docker — `127.0.0.1` would fail the ECS health check.

**`backend/src/__tests__/server.test.ts`**:

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

- The `.js` extension on `../server.js` is required by NodeNext module resolution. Missing it is the single most common early-backend error; call it out now.
- Test fails if `buildApp` does not exist yet — it satisfies TDD's "failing test first."

## Dockerfile

**`backend/Dockerfile`**:

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

Build context is the repo root (`docker build -t mythrun -f backend/Dockerfile .`). This lets the builder see `package.json`, `pnpm-lock.yaml`, and `backend/` simultaneously, which pnpm workspaces requires for `--filter` to resolve.

**`backend/.dockerignore`**:

```
node_modules
dist
**/__tests__
**/*.test.ts
.env*
*.log
```

## AGENTS.md (thin pointer)

**`AGENTS.md`** (replaces the beads auto-generated one):

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

## .gitignore

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

## .nvmrc

```
24
```

## Explicit non-goals

These are deferred to later milestones to avoid scope creep:

- No env-var validation / config loader (Backend Core)
- No Pino logger configuration beyond Fastify's default (Backend Core)
- No error handler plugin (Backend Core)
- No Postgres / Redis / BullMQ wiring (Backend Core + Platform)
- No auth middleware (Auth & Users)
- No pre-commit hooks (add lefthook later if needed)
- No `frontend/` package (Frontend milestone)
- No CI/CD workflow (MYT-28, next issue)
- No production Dockerfile differences from staging (single image for both)

## Sources

- CLAUDE.md (repo root) — project conventions
- `docs/specs/2026-04-20-setup-guide.md` Phases 2 + 5 — original scaffold spec from Setup Guide
- `docs/specs/2026-04-13-backend-core.md` — what this scaffold will grow into next week
- Memory: `reference_agent_legible_code.md` — agent-legibility principles
- Memory: `user_test_convention.md` — `__tests__/` directory pattern
