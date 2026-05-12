# MYT-47 Dev tool Phase 0 + ship-gate infrastructure — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stub the dev tool front-end (Vite SPA at `backend/dev-tool/`, local-only) and the ship gate (`pnpm dev-tool:check`) that enforces dev-tool coverage on every subsequent prep-pipeline PR.

**Architecture:** Vite + vanilla TS SPA running on `127.0.0.1:5273` with a dev-server proxy that forwards `/api/*` and `/health/*` to the local backend at `localhost:3000` — so the browser sees one origin and no CORS plugin is needed. Three contract files in `backend/src/contract/` are the source-of-truth for the gated surface (routes/events/jobs). A `coverage.json` manifest in the dev tool declares what's covered; a check script in `backend/scripts/` errors if a contract entry lacks coverage. CI workflow `.github/workflows/dev-tool-check.yml` runs on PR + push to main.

**Tech Stack:** Vite 6 + TypeScript 5 + plain CSS + vanilla DOM (no React/Tailwind/router). pnpm workspaces. Vitest (already in backend workspace) for the ship-gate's tests. tsx for the CLI shell.

**Working directory:** `.worktrees/myt-47/` (worktree on branch `myt-47-dev-tool-ship-gate`). All commands below run from this directory unless noted.

**Spec:** `docs/superpowers/specs/2026-05-11-myt-47-dev-tool-phase-0-design.md`

---

### Task 1: Amend parent spec §12 (separate prior commit)

This lands FIRST as its own commit so `git blame` on the parent-spec edits attributes the design decision to a deliberate amendment, not to MYT-47 implementation.

**Files:**
- Modify: `docs/specs/2026-04-13-world-campaign-pipeline.md` §12.3, §12.4, §12.6
- Modify: `docs/specs/2026-04-13-world-campaign-pipeline.md` §12.5.1 (weaken type-enforcement claim) and §12.5.2 (`/health/ready` example)

- [ ] **Step 1: Update §12.3 Architecture to single local-only mode**

Replace the block at lines 811–815 (the "two modes" list + env-switcher paragraph) with:

```markdown
The tool runs **local-only**. `pnpm dev:dev-tool` boots Vite on `127.0.0.1:5273` with a dev-server proxy that forwards `/api/*` and `/health/*` to `http://localhost:3000` — so the browser sees one same-origin host and no CORS plugin is needed on the API. There is no staging deploy and no env switcher; if you need to validate something against the deployed staging API, expand `pnpm smoke:staging`. The dev tool exists to iterate on the local backend, not to debug staging.
```

- [ ] **Step 2: Update §12.4 Auth to drop the production-deploy reference**

Replace the §12.4 paragraph (line 819) with:

```markdown
The dev tool reuses the existing bypass-plugin auth path (`x-mythrun-dev-sub` header), already wired for development. The tool stores the active "dev user" identity in `localStorage` and lets the engineer switch between fake identities — this is how multi-player flows are exercised by one human. The bypass plugin's 6-layer defense gates this to `NODE_ENV=development|test`; synthetic identities only work against the local API. The dev tool is local-only, so this matches its threat model.
```

- [ ] **Step 3: Update §12.5.1 to weaken the "type-system enforces sync" claim**

Replace the second paragraph of §12.5.1 (the "Every pipeline route handler imports its entry from here ..." sentence and the "These three files are the load-bearing ..." paragraph) with:

```markdown
At Phase 0 the contracts are empty and the lists do not structurally force route handlers to reference them — the enforcement layer (a `registerPipelineRoute(app, route, handler)` helper that takes `route: PipelineRoute`, or a Fastify `onRoute` hook that fails boot when a pipeline-path URL is registered without being in `PIPELINE_ROUTES`) lands in MYT-50 alongside the first real routes. Phase 0 documents the convention; MYT-50 enforces it mechanically. The check script (§12.5.3) is the runtime gate.
```

- [ ] **Step 4: Update §12.5.2 coverage manifest example — remove `/health/ready`**

Replace the example JSON block (lines 839–850) and the line after it ("At Phase 0 the manifest is essentially empty (just `/health/ready`)...") with:

```markdown
At Phase 0 the manifest is empty (no pipeline routes/events/jobs exist yet). `/health/ready` is NOT in `coverage.routes` — it's a system-wide health endpoint, not a pipeline surface; the dev tool's smoke panel exercises it but the ship gate's scope is the prep pipeline only.

```json
{
  "version": 1,
  "routes": [],
  "events": [],
  "jobs": [],
  "exempt": {
    "routes": {},
    "events": {},
    "jobs": {}
  }
}
```
```

- [ ] **Step 5: Update §12.5.4 CI integration paragraph**

Replace the §12.5.4 body with:

```markdown
A dedicated workflow `.github/workflows/dev-tool-check.yml` runs `pnpm dev-tool:check` on `pull_request` AND `push: branches: [main]`. Mirrors `wiki-check.yml`'s precedent (which also runs on both). The check is NOT folded into `deploy.yml` because deploy.yml only fires on push-to-main (not PRs) and its install filter excludes any non-backend-dep workspace.

```yaml
- run: pnpm dev-tool:check
```

Failing the check red-lights the workflow.
```

- [ ] **Step 6: Update §12.6 Hard Boundaries — drop the "ships to staging" line**

Replace the §12.6 bullet list with:

```markdown
- The dev tool is local-only. It does NOT ship anywhere — no staging deploy, no production deploy. `.dockerignore` excludes `backend/dev-tool/` as belt-and-suspenders.
- It uses the same routes as the real frontend will — no special "dev-tool" routes added to the API.
- It does not maintain its own state model; it reads from `GET /status` on load and SSE thereafter.
- Code is not factored for reuse. When the real frontend lands, the dev tool stays as an internal debugging surface; the production app is a clean build.
- All HTTP calls go through `api-client.ts`'s `apiCall` (relative paths only, headers set centrally). No bare `fetch`, no absolute URLs.
- The dev tool uses `.textContent` only, never `.innerHTML`.
- The dev tool stores nothing secret in `localStorage` — only the active dev-sub key. Tokens / JWTs / Anthropic keys never land in `localStorage`.
- The ship gate is not optional or skippable. Adding `--no-verify` to commits with a failing `dev-tool:check` is a process violation, not a workaround.
```

- [ ] **Step 7: Commit the amendment as its own commit**

```bash
git add docs/specs/2026-04-13-world-campaign-pipeline.md
git commit -m "spec(prep-pipeline): amend §12 — dev tool is local-only, no staging deploy

Per MYT-47 brainstorming + blind review:
- §12.3 drops the env switcher and staging-deploy mode; tool runs only
  via Vite dev server on 127.0.0.1:5273 with proxy to localhost:3000
- §12.4 acknowledges synthetic identities only work against local API
  (bypass plugin gated to NODE_ENV=development|test)
- §12.5.1 weakens 'type-system enforces sync' claim — actual
  enforcement (helper or onRoute hook) lands in MYT-50 with first
  real routes
- §12.5.2 drops the /health/ready example from coverage (it's not a
  pipeline route) and adds the version field
- §12.5.4 moves CI integration to its own workflow file
  (.github/workflows/dev-tool-check.yml) on PR + push, matching
  wiki-check.yml precedent
- §12.6 strikes 'ships to staging'; adds api-client/textContent/
  localStorage hard rules

This commit lands BEFORE MYT-47's implementation commits so git blame
on §12 attributes the design change to a deliberate amendment, not to
implementation churn."
```

---

### Task 2: Backend contract files

The three single-source-of-truth files for the gated surface. Land before the check script so the script's imports resolve.

**Files:**
- Create: `backend/src/contract/pipeline-routes.ts`
- Create: `backend/src/contract/pipeline-events.ts`
- Create: `backend/src/contract/pipeline-jobs.ts`

- [ ] **Step 1: Create `pipeline-routes.ts`**

```ts
// Declarative list of prep-pipeline HTTP routes. The ship-gate check
// (backend/scripts/dev-tool-check.ts) reads this list to ensure every
// entry has corresponding dev-tool coverage (or an explicit exempt
// entry).
//
// NOTE: at Phase 0 this list does NOT structurally force route handlers
// to import their entry from here. The enforcement layer lands in MYT-50
// alongside the first real routes — either a registerPipelineRoute helper
// that takes `route: PipelineRoute`, or a Fastify onRoute hook that fails
// boot when a pipeline-path URL is registered without being in
// PIPELINE_ROUTES. Phase 0 documents the convention; MYT-50 enforces it.
//
// The list seeds empty; routes accumulate as MYT-50 onward lands them.
// Format: '<METHOD> /api/<path>' (e.g., 'POST /api/worlds').
export const PIPELINE_ROUTES: readonly string[] = [] as const

export type PipelineRoute = (typeof PIPELINE_ROUTES)[number]
```

- [ ] **Step 2: Create `pipeline-events.ts`**

```ts
// Declarative list of prep-pipeline SSE event types emitted by the
// worker via redisRealtime and forwarded to clients on the
// /api/{worlds,campaigns}/:id/status/stream routes. The ship-gate check
// requires every entry to have corresponding dev-tool coverage.
//
// Seeds empty. Events accumulate as MYT-50 (status surface) and MYT-52
// (entity events) land them.
export const PIPELINE_SSE_EVENTS: readonly string[] = [] as const

export type PipelineSseEvent = (typeof PIPELINE_SSE_EVENTS)[number]
```

- [ ] **Step 3: Create `pipeline-jobs.ts`**

```ts
// Declarative list of prep-pipeline BullMQ job type names processed by
// the worker (backend/src/worker.ts). The ship-gate check requires every
// entry to have corresponding dev-tool coverage — exempt entries are
// permitted for jobs that fire transitively (e.g., barriers).
//
// Seeds empty. Jobs accumulate as MYT-49 (worker wiring) and MYT-50+
// (real processors) land them.
export const PIPELINE_BULLMQ_JOBS: readonly string[] = [] as const

export type PipelineBullmqJob = (typeof PIPELINE_BULLMQ_JOBS)[number]
```

- [ ] **Step 4: Verify TS compiles**

Run:
```bash
pnpm --filter @mythrun/backend typecheck
```
Expected: `tsc` exits 0 with no errors. The three new files type-check cleanly.

- [ ] **Step 5: Commit**

```bash
git add backend/src/contract/
git commit -m "feat(myt-47): seed pipeline contract files

Three source-of-truth files for the gated pipeline surface:
- pipeline-routes.ts (HTTP routes)
- pipeline-events.ts (SSE event types)
- pipeline-jobs.ts (BullMQ job type names)

All seeded empty; entries accumulate as MYT-49 / MYT-50+ land real
pipeline surfaces. Type annotated as readonly string[] (not bare
'as const') so .includes() accepts string args without 'as never'."
```

---

### Task 3: Dev-tool workspace scaffold (package.json + configs + lockfile)

Create the new pnpm workspace at `backend/dev-tool/`. No application code yet — just the configuration shell that makes `pnpm install` + `pnpm dev:dev-tool` viable.

**Files:**
- Create: `backend/dev-tool/package.json`
- Create: `backend/dev-tool/vite.config.ts`
- Create: `backend/dev-tool/tsconfig.json`
- Create: `backend/dev-tool/eslint.config.js`
- Create: `backend/dev-tool/src/vite-env.d.ts`
- Modify: `pnpm-workspace.yaml`
- Modify: `package.json` (root, scripts)
- Modify: `backend/package.json` (scripts)
- Modify: `.dockerignore`

- [ ] **Step 1: Create `backend/dev-tool/package.json`**

```json
{
  "name": "@mythrun/dev-tool",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "typecheck": "tsc --noEmit",
    "lint": "eslint . --no-error-on-unmatched-pattern"
  },
  "devDependencies": {
    "vite": "^6.0.0",
    "typescript": "^5.6.0"
  }
}
```

- [ ] **Step 2: Create `backend/dev-tool/vite.config.ts`**

```ts
import { defineConfig } from 'vite'

// Local-only dev server. Proxy makes /api/* and /health/* requests
// same-origin from the browser's perspective so no CORS plugin is
// needed on the backend.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    fs: { strict: true },
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
})
```

- [ ] **Step 3: Create `backend/dev-tool/tsconfig.json`**

Standalone, does NOT extend `backend/tsconfig.json` — Bundler-mode resolution is needed for Vite, not NodeNext.

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noFallthroughCasesInSwitch": true,
    "noImplicitOverride": true,
    "allowImportingTsExtensions": true,
    "noEmit": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["vite/client"]
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

- [ ] **Step 4: Create `backend/dev-tool/eslint.config.js`**

```js
import root from '../../eslint.config.js'

export default [
  ...root,
  { ignores: ['src/**/*.css', 'index.html', 'node_modules/**'] },
]
```

- [ ] **Step 5: Create `backend/dev-tool/src/vite-env.d.ts`**

```ts
/// <reference types="vite/client" />
```

- [ ] **Step 6: Add `backend/dev-tool` to `pnpm-workspace.yaml`**

Read current contents, add `backend/dev-tool` as a new packages entry alongside existing entries. For example, if current shape is:
```yaml
packages:
  - backend
  - docs/wiki
```

Becomes:
```yaml
packages:
  - backend
  - backend/dev-tool
  - docs/wiki
```

- [ ] **Step 7: Add scripts to root `package.json`**

Edit root `package.json` `scripts` block to add two new entries (preserve existing entries):

```json
"dev:dev-tool":   "pnpm --filter @mythrun/dev-tool dev",
"dev-tool:check": "pnpm --filter @mythrun/backend dev-tool:check"
```

- [ ] **Step 8: Add `dev-tool:check` script to `backend/package.json`**

Add to `backend/package.json` `scripts` block (preserve existing):

```json
"dev-tool:check": "tsx scripts/dev-tool-check.ts"
```

- [ ] **Step 9: Add `backend/dev-tool/` to `.dockerignore`**

Append to `.dockerignore` near the existing `**/__tests__` / docs / `.beads` exclusions, with a comment:

```
# Dev tool is local-only by design; never include in the build context.
backend/dev-tool
```

- [ ] **Step 10: Regenerate the lockfile**

```bash
pnpm install
```
Expected: pnpm picks up the new workspace, resolves Vite + TypeScript (TypeScript was already in the lockfile via backend; Vite is new). `pnpm-lock.yaml` is modified.

- [ ] **Step 11: Verify `pnpm typecheck` and `pnpm lint` recurse into dev-tool**

```bash
pnpm typecheck
pnpm lint
```
Expected: both run `tsc --noEmit` / `eslint .` against `@mythrun/dev-tool` (visible in output as `@mythrun/dev-tool typecheck$ tsc --noEmit`). Both pass — there's no source code yet, so the lints are trivially clean.

- [ ] **Step 12: Commit scaffold + lockfile**

```bash
git add backend/dev-tool/ pnpm-workspace.yaml package.json backend/package.json .dockerignore pnpm-lock.yaml
git commit -m "feat(myt-47): scaffold @mythrun/dev-tool workspace + ship-gate plumbing

- New workspace at backend/dev-tool/ with package.json, vite.config.ts,
  tsconfig.json, eslint.config.js, src/vite-env.d.ts
- Vite pinned to 127.0.0.1:5273 with strictPort + fs.strict + proxy
  for /api and /health to localhost:3000 (same-origin from browser)
- Standalone tsconfig (Bundler resolution); does not extend backend
  tsconfig (which is NodeNext)
- Root scripts: dev:dev-tool, dev-tool:check
- backend/package.json adds dev-tool:check (tsx scripts/...)
- .dockerignore excludes backend/dev-tool/ as belt-and-suspenders
- pnpm-lock.yaml regenerated with vite added

No application code yet; the workspace boots empty. Subsequent commits
populate src/ and the check script."
```

---

### Task 4: HTML + main.ts + styles.css skeleton + boot smoke

The minimal page that proves the workspace runs. Just renders "Mythrun dev tool" with no functional components yet.

**Files:**
- Create: `backend/dev-tool/index.html`
- Create: `backend/dev-tool/src/main.ts`
- Create: `backend/dev-tool/src/styles.css`
- Create: `backend/dev-tool/README.md`

- [ ] **Step 1: Create `backend/dev-tool/index.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Mythrun dev tool</title>
  </head>
  <body>
    <header>
      <h1>Mythrun dev tool</h1>
    </header>
    <main></main>
    <script type="module" src="/src/main.ts"></script>
  </body>
</html>
```

- [ ] **Step 2: Create `backend/dev-tool/src/styles.css`**

Plain CSS, wiki-styled. Replace tokens like the body color if the wiki uses a different palette — but a safe default:

```css
:root {
  --fg: #1a1a1a;
  --fg-muted: #555;
  --bg: #fafaf7;
  --border: #ddd;
  --ok-bg: #e8f5e9;
  --ok-border: #66bb6a;
  --err-bg: #ffebee;
  --err-border: #ef5350;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  padding: 0;
  font-family: system-ui, sans-serif;
  color: var(--fg);
  background: var(--bg);
}

header {
  padding: 16px 24px;
  border-bottom: 1px solid var(--border);
  display: flex;
  align-items: center;
  gap: 24px;
}

header h1 {
  margin: 0;
  font-family: var(--mono);
  font-size: 18px;
  font-weight: 600;
}

main {
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  max-width: 900px;
}

.identity-switcher label {
  font-family: var(--mono);
  font-size: 13px;
  color: var(--fg-muted);
}

.identity-switcher select {
  font-family: var(--mono);
  font-size: 13px;
  padding: 4px 8px;
  margin-left: 8px;
}

.card {
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 16px;
  background: white;
}

.card.ok {
  background: var(--ok-bg);
  border-color: var(--ok-border);
}

.card.err {
  background: var(--err-bg);
  border-color: var(--err-border);
}

.card h2 {
  margin: 0 0 12px 0;
  font-family: var(--mono);
  font-size: 14px;
  font-weight: 600;
}

.card button {
  font-family: var(--mono);
  font-size: 12px;
  padding: 4px 12px;
  cursor: pointer;
}

.card .result {
  margin: 12px 0 0 0;
  font-family: var(--mono);
  font-size: 12px;
  white-space: pre-wrap;
  color: var(--fg-muted);
}
```

- [ ] **Step 3: Create skeleton `backend/dev-tool/src/main.ts`**

```ts
import './styles.css'

const main = document.querySelector<HTMLElement>('main')
if (!main) throw new Error('layout missing required element <main>')

const placeholder = document.createElement('p')
placeholder.textContent = '(no components mounted yet)'
main.appendChild(placeholder)
```

- [ ] **Step 4: Create `backend/dev-tool/README.md`**

```markdown
# @mythrun/dev-tool

Local-only engineering UI for the Mythrun backend. Throwaway — not the production frontend.

## Bring-up

```
pnpm install
pnpm dev:dev-tool
```

Open `http://127.0.0.1:5273`. Requires the local backend running at `localhost:3000` (`pnpm dev`).

See `docs/wiki/content/runtime/dev-tool.html` for the full overview, ship gate, and conventions.
```

- [ ] **Step 5: Smoke verify the page boots**

Start the local backend in one terminal (or skip if you already have it running):
```bash
pnpm db:up
pnpm dev   # in a separate terminal, runs backend on localhost:3000
```

Start the dev tool in another terminal:
```bash
pnpm dev:dev-tool
```
Expected output: `VITE v6.x.x  ready in NNN ms` followed by `Local:   http://127.0.0.1:5273/`.

Open `http://127.0.0.1:5273` in a browser. Expected: page renders with "Mythrun dev tool" header and "(no components mounted yet)" text. No console errors.

Stop the Vite server with Ctrl-C.

- [ ] **Step 6: Verify typecheck + lint still pass**

```bash
pnpm typecheck
pnpm lint
```
Expected: both green.

- [ ] **Step 7: Commit**

```bash
git add backend/dev-tool/index.html backend/dev-tool/src/main.ts backend/dev-tool/src/styles.css backend/dev-tool/README.md
git commit -m "feat(myt-47): dev-tool skeleton HTML + main.ts + styles + README

Minimal page renders the 'Mythrun dev tool' header. No functional
components yet — those land in following commits. Styles are
wiki-styled (system fonts, monospace headings, semantic ok/err colors).
pnpm dev:dev-tool boots Vite on 127.0.0.1:5273; smoke-verified."
```

---

### Task 5: identity.ts module

Pure module-scope state + event emission. No automated tests at Phase 0 — verified by Task 8 (identity-switcher) and Task 9 (health-panel) wiring.

**Files:**
- Create: `backend/dev-tool/src/identity.ts`

- [ ] **Step 1: Create `identity.ts`**

```ts
// Read/write the active dev-sub identity in localStorage and emit a
// custom event on changes so other components can re-render.
//
// DEV_SUBS is the canonical list of synthetic identities the dev tool
// offers. Future MYT-51 seed migration MUST insert exactly these rows
// in Postgres so authenticated routes work end-to-end. Five identities
// cover the 2–5 player range from spec §12.2 with one spare for solo-
// test scenarios.

const STORAGE_KEY = 'mythrun.devtool.devSub'
const EVENT = 'mythrun.identitychanged'

export const DEV_SUBS = [
  'dev-user-1',
  'dev-user-2',
  'dev-user-3',
  'dev-user-4',
  'dev-user-5',
] as const

export type DevSub = (typeof DEV_SUBS)[number]

function isDevSub(value: string): value is DevSub {
  return (DEV_SUBS as readonly string[]).includes(value)
}

export function getCurrentDevSub(): DevSub {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored !== null && isDevSub(stored)) {
    return stored
  }
  return 'dev-user-1'
}

export function setCurrentDevSub(sub: DevSub): void {
  localStorage.setItem(STORAGE_KEY, sub)
  window.dispatchEvent(new CustomEvent<DevSub>(EVENT, { detail: sub }))
}

export function onIdentityChanged(cb: (sub: DevSub) => void): () => void {
  const handler = (e: Event): void => {
    cb((e as CustomEvent<DevSub>).detail)
  }
  window.addEventListener(EVENT, handler)
  return () => {
    window.removeEventListener(EVENT, handler)
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
pnpm --filter @mythrun/dev-tool typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Verify lint passes**

```bash
pnpm --filter @mythrun/dev-tool lint
```
Expected: 0 errors / 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add backend/dev-tool/src/identity.ts
git commit -m "feat(myt-47): dev-tool identity module

DEV_SUBS canonical list (5 identities), getCurrentDevSub /
setCurrentDevSub backed by localStorage, onIdentityChanged custom-event
pub/sub. No automated tests at Phase 0 — verified by manual identity-
switcher wiring in the next task."
```

---

### Task 6: api-client.ts module

Single fetch wrapper. Path-guard, header injection from identity.

**Files:**
- Create: `backend/dev-tool/src/api-client.ts`

- [ ] **Step 1: Create `api-client.ts`**

```ts
// Single fetch wrapper. Uses RELATIVE paths only — Vite dev server
// proxies /api/* and /health/* to localhost:3000, so the browser only
// ever sees same-origin requests. Sets x-mythrun-dev-sub from current
// identity on every call.
//
// All dev-tool HTTP calls go through this function. No bare fetch
// elsewhere. When SSE arrives (MYT-50), EventSource also targets a
// relative path so it's same-origin too.

import { getCurrentDevSub } from './identity.js'

export interface ApiResponse<T> {
  status: number
  ok: boolean
  body: T | null
  latencyMs: number
  error?: string
}

export async function apiCall<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResponse<T>> {
  // Path guard: relative paths only. Prevents a future bug where someone
  // passes an absolute URL and the dev-sub header leaks to another origin.
  if (!path.startsWith('/')) {
    throw new Error(`apiCall: path must start with '/' (got ${JSON.stringify(path)})`)
  }

  const start = performance.now()
  const headers = new Headers(init.headers)
  headers.set('x-mythrun-dev-sub', getCurrentDevSub())
  if (typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }

  try {
    const res = await fetch(path, { ...init, headers })
    const text = await res.text()
    let body: T | null = null
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as T
      } catch {
        // Non-JSON response. Leave body null; caller diagnoses via status.
      }
    }
    return {
      status: res.status,
      ok: res.ok,
      body,
      latencyMs: Math.round(performance.now() - start),
    }
  } catch (err) {
    return {
      status: 0,
      ok: false,
      body: null,
      latencyMs: Math.round(performance.now() - start),
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
pnpm --filter @mythrun/dev-tool typecheck
```
Expected: 0 errors.

- [ ] **Step 3: Verify lint passes**

```bash
pnpm --filter @mythrun/dev-tool lint
```
Expected: 0 errors / 0 warnings.

- [ ] **Step 4: Commit**

```bash
git add backend/dev-tool/src/api-client.ts
git commit -m "feat(myt-47): dev-tool api-client wrapper

Single fetch wrapper enforcing: relative paths only (throws on absolute
URLs), x-mythrun-dev-sub header injection from identity.ts, automatic
content-type for string bodies. Returns ApiResponse<T> with status,
ok, body, latencyMs, error. Verified by health-panel wiring in next
task."
```

---

### Task 7: components/identity-switcher.ts + wire into main

**Files:**
- Create: `backend/dev-tool/src/components/identity-switcher.ts`
- Modify: `backend/dev-tool/src/main.ts`

- [ ] **Step 1: Create `components/identity-switcher.ts`**

```ts
// Renders a <select> for the current dev-sub identity. Writes to
// identity.ts on change, which broadcasts the change event.

import { DEV_SUBS, getCurrentDevSub, setCurrentDevSub, type DevSub } from '../identity.js'

export function mountIdentitySwitcher(parent: HTMLElement): void {
  const wrap = document.createElement('div')
  wrap.className = 'identity-switcher'

  const label = document.createElement('label')
  label.textContent = 'Acting as: '

  const select = document.createElement('select')
  const current = getCurrentDevSub()
  for (const sub of DEV_SUBS) {
    const opt = document.createElement('option')
    opt.value = sub
    opt.textContent = sub
    if (sub === current) opt.selected = true
    select.appendChild(opt)
  }
  select.addEventListener('change', () => {
    setCurrentDevSub(select.value as DevSub)
  })

  label.appendChild(select)
  wrap.appendChild(label)
  parent.appendChild(wrap)
}
```

- [ ] **Step 2: Update `backend/dev-tool/src/main.ts` to mount the switcher**

Replace contents with:

```ts
import { mountIdentitySwitcher } from './components/identity-switcher.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

mountIdentitySwitcher(header)

const placeholder = document.createElement('p')
placeholder.textContent = '(health panel mounts next)'
main.appendChild(placeholder)
```

- [ ] **Step 3: Smoke verify in the browser**

Restart `pnpm dev:dev-tool`. Open `http://127.0.0.1:5273`.

Expected:
1. The header shows the title AND a dropdown labeled "Acting as:" with options `dev-user-1` through `dev-user-5`.
2. The default selection is `dev-user-1`.
3. Change the dropdown to `dev-user-3`. Refresh the page. Expected: `dev-user-3` is still selected (localStorage persists across reload).
4. Open browser devtools → Application → Local Storage → `http://127.0.0.1:5273`. Expected: `mythrun.devtool.devSub = "dev-user-3"`.

Reset to `dev-user-1` for cleanliness. Stop the Vite server.

- [ ] **Step 4: Verify typecheck + lint**

```bash
pnpm typecheck
pnpm lint
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/identity-switcher.ts backend/dev-tool/src/main.ts
git commit -m "feat(myt-47): identity switcher component wired into header

<select> dropdown bound to identity.ts. localStorage persistence verified
manually (refresh preserves selection). Component is functional —
mountX(parent) returns void; cross-component coordination via the
custom event from identity.ts."
```

---

### Task 8: components/health-panel.ts + full smoke

Wires the smoke-test panel. End of this task: full dev-tool page works against local backend with 200 from /health/ready.

**Files:**
- Create: `backend/dev-tool/src/components/health-panel.ts`
- Modify: `backend/dev-tool/src/main.ts`

- [ ] **Step 1: Create `components/health-panel.ts`**

```ts
// Smoke test card. Calls /health/ready on mount and on button click.
// Does NOT re-run on identity change — /health/ready is public, so
// identity has no observable effect; re-running would pollute logs
// for no signal. Future panels that depend on identity will subscribe
// to onIdentityChanged in their own mountFoo().

import { apiCall } from '../api-client.js'

export function mountHealthPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'

  const title = document.createElement('h2')
  title.textContent = 'GET /health/ready'

  const button = document.createElement('button')
  button.textContent = 'Run'

  const result = document.createElement('pre')
  result.className = 'result'
  result.textContent = '(not yet run)'

  async function run(): Promise<void> {
    result.textContent = 'running...'
    card.classList.remove('ok', 'err')
    const res = await apiCall('/health/ready')
    const lines = [
      `status:    ${String(res.status)}`,
      `ok:        ${String(res.ok)}`,
      `latency:   ${String(res.latencyMs)}ms`,
      `body:      ${res.body !== null ? JSON.stringify(res.body, null, 2) : '(empty)'}`,
    ]
    if (res.error !== undefined) lines.push(`error:     ${res.error}`)
    result.textContent = lines.join('\n')
    card.classList.toggle('ok', res.ok)
    card.classList.toggle('err', !res.ok)
  }

  button.addEventListener('click', () => {
    void run()
  })

  card.appendChild(title)
  card.appendChild(button)
  card.appendChild(result)
  parent.appendChild(card)

  void run()
}
```

- [ ] **Step 2: Update `backend/dev-tool/src/main.ts`**

Replace contents with:

```ts
import { mountIdentitySwitcher } from './components/identity-switcher.js'
import { mountHealthPanel } from './components/health-panel.js'
import './styles.css'

const header = document.querySelector<HTMLElement>('header')
const main = document.querySelector<HTMLElement>('main')
if (!header || !main) throw new Error('layout missing required elements')

mountIdentitySwitcher(header)
mountHealthPanel(main)
```

- [ ] **Step 3: Smoke verify the full page works against the local backend**

Ensure the local backend is running (`pnpm dev` in a separate terminal — needs Postgres + Redis up via `pnpm db:up`).

Start the dev tool:
```bash
pnpm dev:dev-tool
```

Open `http://127.0.0.1:5273`. Expected:

1. Header shows title + identity dropdown.
2. Body shows a card titled "GET /health/ready".
3. The card auto-runs once on mount and turns GREEN (`.card.ok`) with:
   - `status:    200`
   - `ok:        true`
   - `latency:   <small number>ms`
   - `body:      {... JSON of /health/ready response ...}`
4. Click the "Run" button. Card briefly shows `running...` then re-displays the green result.

Open browser devtools → Network tab. Filter on `health`. Verify the request URL is `http://127.0.0.1:5273/health/ready` (relative path → same-origin from browser view). Verify the request carries an `x-mythrun-dev-sub` header (devtools → request headers).

Change identity to `dev-user-3`. The card does NOT auto-re-run (per the comment). Click "Run" manually — request goes through with the new sub in the header.

Stop the local backend (Ctrl-C the backend terminal). Reload the dev tool page. Expected: card turns RED (`.card.err`) with `status: 0`, `ok: false`, `error: <network failure message>`.

Restart the backend. Click "Run" again. Card turns green.

Stop the Vite server. Stop the local backend.

- [ ] **Step 4: Verify typecheck + lint**

```bash
pnpm typecheck
pnpm lint
```
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add backend/dev-tool/src/components/health-panel.ts backend/dev-tool/src/main.ts
git commit -m "feat(myt-47): health-panel component + complete dev-tool wiring

Smoke test card calls /health/ready via api-client; auto-runs on mount.
Visual state via .card.ok / .card.err. Does NOT re-run on identity
change (public route — no observable signal). End-to-end smoke verified
manually: dev tool page on 127.0.0.1:5273 renders green health check
when backend is up, red when down."
```

---

### Task 9: coverage.json

The ship-gate's coverage manifest. Seeded empty.

**Files:**
- Create: `backend/dev-tool/coverage.json`

- [ ] **Step 1: Create `coverage.json`**

```json
{
  "version": 1,
  "routes": [],
  "events": [],
  "jobs": [],
  "exempt": {
    "routes": {},
    "events": {},
    "jobs": {}
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/dev-tool/coverage.json
git commit -m "feat(myt-47): seed ship-gate coverage manifest

Empty at Phase 0 (no pipeline routes/events/jobs exist yet). /health/ready
is NOT in coverage — it's not a pipeline route (D9). Carries version: 1
for future schema evolution detection. Subsequent issues append
matching entries when they add backend pipeline surface."
```

---

### Task 10: Ship-gate check function + tests (TDD)

This is the load-bearing task. Pure check logic extracted into a testable function; CLI shell is thin.

**Files:**
- Create: `backend/src/dev-tool-check/check-coverage.ts` (pure function)
- Create: `backend/src/dev-tool-check/__tests__/check-coverage.test.ts` (vitest)

- [ ] **Step 1: Write failing test file**

Create `backend/src/dev-tool-check/__tests__/check-coverage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { checkCoverage } from '../check-coverage.js'

describe('checkCoverage', () => {
  it('passes when contracts are empty', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('errors when a contract entry lacks coverage and exempt', () => {
    const result = checkCoverage(
      { routes: ['POST /api/worlds'], events: [], jobs: [] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('routes/POST /api/worlds')
    expect(result.errors[0]).toContain('not in coverage')
  })

  it('passes when a contract entry is covered', () => {
    const result = checkCoverage(
      { routes: ['POST /api/worlds'], events: [], jobs: [] },
      {
        version: 1,
        routes: ['POST /api/worlds'],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toEqual([])
  })

  it('passes when a contract entry is exempt with a valid reason', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: ['post-creation'] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: {
          routes: {},
          events: {},
          jobs: {
            'post-creation':
              'transitively exercised — barrier job fires automatically when per-player jobs complete',
          },
        },
      },
    )
    expect(result.errors).toEqual([])
  })

  it('errors when an exempt reason is too short', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: ['post-creation'] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: {
          routes: {},
          events: {},
          jobs: { 'post-creation': 'too short' },
        },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('exempt reason is too short')
  })

  it('warns when coverage contains an entry not in any contract (stale coverage)', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 1,
        routes: ['POST /api/worlds'],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toEqual([])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('POST /api/worlds')
    expect(result.warnings[0]).toContain('no longer in contract')
  })

  it('errors when exempt contains an entry not in any contract (stale exempt)', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: {
          routes: { 'POST /api/old': 'a long-enough reason explaining the old exemption' },
          events: {},
          jobs: {},
        },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('exempt but no longer in contract')
  })

  it('errors when the coverage version is unrecognized', () => {
    const result = checkCoverage(
      { routes: [], events: [], jobs: [] },
      {
        version: 2 as unknown as 1,
        routes: [],
        events: [],
        jobs: [],
        exempt: { routes: {}, events: {}, jobs: {} },
      },
    )
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('version')
  })
})
```

- [ ] **Step 2: Run tests; they should fail (module not yet defined)**

```bash
pnpm --filter @mythrun/backend test backend/src/dev-tool-check/__tests__/check-coverage.test.ts --run
```

Expected: failure with `Cannot find module '../check-coverage.js'` or similar (the file doesn't exist yet).

- [ ] **Step 3: Implement `check-coverage.ts`**

Create `backend/src/dev-tool-check/check-coverage.ts`:

```ts
// Pure check logic, decoupled from filesystem I/O. The CLI shell at
// backend/scripts/dev-tool-check.ts loads the contracts and coverage
// JSON and passes them in. Tests use this function directly.

const MIN_REASON_LENGTH = 20

export interface Contracts {
  readonly routes: readonly string[]
  readonly events: readonly string[]
  readonly jobs: readonly string[]
}

export interface Coverage {
  readonly version: 1
  readonly routes: readonly string[]
  readonly events: readonly string[]
  readonly jobs: readonly string[]
  readonly exempt: {
    readonly routes: Readonly<Record<string, string>>
    readonly events: Readonly<Record<string, string>>
    readonly jobs: Readonly<Record<string, string>>
  }
}

export interface CheckResult {
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
}

type Kind = 'routes' | 'events' | 'jobs'

export function checkCoverage(contracts: Contracts, coverage: Coverage): CheckResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (coverage.version !== 1) {
    errors.push(
      `coverage.json version ${String(coverage.version)} not understood by this script`,
    )
    return { errors, warnings }
  }

  const kinds: ReadonlyArray<readonly [Kind, readonly string[]]> = [
    ['routes', contracts.routes],
    ['events', contracts.events],
    ['jobs', contracts.jobs],
  ]

  for (const [kind, contract] of kinds) {
    const coveredList: readonly string[] = coverage[kind]
    const exempt: Readonly<Record<string, string>> = coverage.exempt[kind]
    const covered = new Set(coveredList)
    const contractSet = new Set(contract)

    for (const entry of contract) {
      if (covered.has(entry)) continue
      const reason = exempt[entry]
      if (reason !== undefined) {
        if (reason.trim().length < MIN_REASON_LENGTH) {
          errors.push(
            `${kind}/${entry} exempt reason is too short (< ${String(MIN_REASON_LENGTH)} chars). Write a real reason: who, why, and which Linear/MYT-* issue addresses the gap.`,
          )
        }
        continue
      }
      errors.push(
        `${kind}/${entry} is in contract but neither in coverage nor exempt — add a dev-tool UI for it (and add the entry to backend/dev-tool/coverage.json), OR add it to coverage.exempt.${kind} with a reason.`,
      )
    }

    for (const entry of coveredList) {
      if (!contractSet.has(entry)) {
        warnings.push(
          `${kind}/${entry} is in coverage but no longer in contract — consider removing`,
        )
      }
    }

    for (const entry of Object.keys(exempt)) {
      if (!contractSet.has(entry)) {
        errors.push(
          `${kind}/${entry} is in exempt but no longer in contract — remove the exempt entry`,
        )
      }
    }
  }

  return { errors, warnings }
}
```

- [ ] **Step 4: Run tests; they should pass**

```bash
pnpm --filter @mythrun/backend test backend/src/dev-tool-check/__tests__/check-coverage.test.ts --run
```

Expected: all 8 tests pass.

- [ ] **Step 5: Verify backend typecheck + lint still pass**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add backend/src/dev-tool-check/
git commit -m "feat(myt-47): ship-gate check-coverage pure function with vitest

8 test cases covering: empty pass, missing-coverage error, covered pass,
exempt-with-valid-reason pass, exempt-too-short error, stale-coverage
warning, stale-exempt error, version mismatch error. MIN_REASON_LENGTH
of 20 chars prevents single-character handwave exemptions.

Pure function; the CLI shell (backend/scripts/dev-tool-check.ts) lands
next and just wires fs + module imports to this function."
```

---

### Task 11: Ship-gate CLI shell

Thin wrapper that wires fs + module imports to `checkCoverage`.

**Files:**
- Create: `backend/scripts/dev-tool-check.ts`

- [ ] **Step 1: Create the CLI shell**

```ts
#!/usr/bin/env tsx
// Ship gate CLI. Loads contract constants and the coverage manifest,
// invokes the pure checkCoverage function, prints results, exits 0/1.

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PIPELINE_ROUTES } from '../src/contract/pipeline-routes.js'
import { PIPELINE_SSE_EVENTS } from '../src/contract/pipeline-events.js'
import { PIPELINE_BULLMQ_JOBS } from '../src/contract/pipeline-jobs.js'
import { checkCoverage, type Coverage } from '../src/dev-tool-check/check-coverage.js'

const here = dirname(fileURLToPath(import.meta.url))
const coveragePath = join(here, '..', 'dev-tool', 'coverage.json')
const raw = await readFile(coveragePath, 'utf8')
const coverage = JSON.parse(raw) as Coverage

const result = checkCoverage(
  {
    routes: PIPELINE_ROUTES,
    events: PIPELINE_SSE_EVENTS,
    jobs: PIPELINE_BULLMQ_JOBS,
  },
  coverage,
)

for (const w of result.warnings) {
  console.warn(`warn:  ${w}`)
}
for (const e of result.errors) {
  console.error(`error: ${e}`)
}

const summary = `routes:${String(coverage.routes.length)} events:${String(coverage.events.length)} jobs:${String(coverage.jobs.length)}`
console.log(
  `dev-tool:check — ${String(result.errors.length)} error(s), ${String(result.warnings.length)} warning(s) [${summary}]`,
)
process.exit(result.errors.length > 0 ? 1 : 0)
```

- [ ] **Step 2: Run the check directly**

```bash
pnpm dev-tool:check
```

Expected output:
```
dev-tool:check — 0 error(s), 0 warning(s) [routes:0 events:0 jobs:0]
```
Exit code 0.

- [ ] **Step 3: Verify it fails when expected (manual sanity test)**

Temporarily add an entry to `backend/src/contract/pipeline-routes.ts`:

```ts
export const PIPELINE_ROUTES: readonly string[] = ['POST /api/test'] as const
```

Run:
```bash
pnpm dev-tool:check
```

Expected: prints `error: routes/POST /api/test is in contract but neither in coverage nor exempt ...` and exits 1.

Revert the temporary change:

```bash
git checkout backend/src/contract/pipeline-routes.ts
```

Re-run `pnpm dev-tool:check` — back to green.

- [ ] **Step 4: Verify backend typecheck + lint pass**

```bash
pnpm --filter @mythrun/backend typecheck
pnpm --filter @mythrun/backend lint
```

Expected: green.

- [ ] **Step 5: Commit**

```bash
git add backend/scripts/dev-tool-check.ts
git commit -m "feat(myt-47): ship-gate CLI shell wires checkCoverage to fs + contracts

backend/scripts/dev-tool-check.ts loads the three contract constants,
reads coverage.json from backend/dev-tool/, calls checkCoverage from
backend/src/dev-tool-check/, prints results, exits 0/1.

pnpm dev-tool:check exits 0 with summary 'routes:0 events:0 jobs:0'
at Phase 0 (empty contracts). Manually verified that adding a contract
entry without coverage produces a red exit."
```

---

### Task 12: CI workflow

New dedicated workflow file. Runs on PR + push to main.

**Files:**
- Create: `.github/workflows/dev-tool-check.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Dev tool check

on:
  pull_request:
    paths:
      - 'backend/src/contract/**'
      - 'backend/src/dev-tool-check/**'
      - 'backend/dev-tool/**'
      - 'backend/scripts/dev-tool-check.ts'
      - 'backend/package.json'
      - '.github/workflows/dev-tool-check.yml'
  push:
    branches: [main]
    paths:
      - 'backend/src/contract/**'
      - 'backend/src/dev-tool-check/**'
      - 'backend/dev-tool/**'
      - 'backend/scripts/dev-tool-check.ts'
      - 'backend/package.json'

jobs:
  check:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2

      - uses: pnpm/action-setup@903f9c1a6ebcba6cf41d87230be49611ac97822e # v6.0.3

      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version-file: .nvmrc
          cache: pnpm

      - run: pnpm install --frozen-lockfile --filter @mythrun/backend...

      - run: pnpm dev-tool:check
```

- [ ] **Step 2: Verify YAML parses**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/dev-tool-check.yml'))" && echo "OK"
```

Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/dev-tool-check.yml
git commit -m "ci(myt-47): add dev-tool-check workflow on PR + push to main

Mirrors wiki-check.yml precedent. Triggers on PR or push to main when
contract files, dev-tool, the check script, or the workflow itself
changes. Scoped install (--filter @mythrun/backend...) keeps it fast.

Action versions pinned by SHA to match deploy.yml's pinning convention."
```

---

### Task 13: Wiki page

**Files:**
- Create: `docs/wiki/content/runtime/dev-tool.html`

- [ ] **Step 1: Check wiki conventions**

Look at an existing runtime page to match the HTML shape:

```bash
ls docs/wiki/content/runtime/
head -50 docs/wiki/content/runtime/llm.html
```

Note the `<!-- mythrun:sources ... -->` source-tracking pattern at the top of existing wiki pages. The new dev-tool page tracks its sources (the design spec + key implementation files) so `pnpm wiki:check` can detect when they drift.

- [ ] **Step 2: Create the wiki page**

Adapt the source-tracking header from an existing runtime page. Then write the body. Approximate skeleton — fill in the wiki-conventional source-tracking lines by reading `docs/wiki/AUTHORING.md` if needed:

```html
<!--
mythrun:sources
  docs/superpowers/specs/2026-05-11-myt-47-dev-tool-phase-0-design.md
  docs/specs/2026-04-13-world-campaign-pipeline.md
  backend/dev-tool/vite.config.ts
  backend/dev-tool/src/api-client.ts
  backend/dev-tool/src/identity.ts
  backend/scripts/dev-tool-check.ts
  backend/src/dev-tool-check/check-coverage.ts
  backend/src/contract/pipeline-routes.ts
  backend/src/contract/pipeline-events.ts
  backend/src/contract/pipeline-jobs.ts
  backend/dev-tool/coverage.json
  .github/workflows/dev-tool-check.yml
-->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Dev tool — Mythrun wiki</title>
    <link rel="stylesheet" href="../../style.css" />
  </head>
  <body>
    <h1>Dev tool</h1>

    <p>Local-only engineering UI for the Mythrun backend. Runs via <code>pnpm dev:dev-tool</code> on
    <code>http://127.0.0.1:5273</code>. Throwaway — explicitly not the production frontend, no
    components survive into the real React app.</p>

    <h2>What it isn't</h2>
    <ul>
      <li>Not deployed anywhere. No staging URL, no production URL.</li>
      <li>Not a staging surface. For staging validation, expand <code>pnpm smoke:staging</code>.</li>
      <li>Not a production debug tool. Production traffic is real users; the dev tool exists for
      iterating on local code.</li>
    </ul>

    <h2>Bring-up</h2>
    <pre><code>pnpm install
pnpm db:up            # Postgres + Redis containers
pnpm dev              # backend on localhost:3000 (separate terminal)
pnpm dev:dev-tool     # Vite on 127.0.0.1:5273
</code></pre>

    <p>Open <code>http://127.0.0.1:5273</code>. The Vite dev server proxies <code>/api/*</code> and
    <code>/health/*</code> to <code>localhost:3000</code>, so the browser sees a single same-origin
    host — no CORS plugin needed on the backend.</p>

    <h2>Identity switcher</h2>
    <p>Header dropdown for the active dev-sub identity (one of
    <code>dev-user-1</code> through <code>dev-user-5</code>). Selection persists in
    <code>localStorage</code> under <code>mythrun.devtool.devSub</code>. Every API call carries the
    <code>x-mythrun-dev-sub</code> header set from the current identity.</p>

    <p>The synthetic identities only work against the local API — the bypass plugin's 6-layer
    defense gates it to <code>NODE_ENV=development|test</code>. Future multi-player flows are
    exercised by switching identities between requests to act as different players.</p>

    <p>At Phase 0 the only smoke test is <code>/health/ready</code>, which is a public route — the
    identity is sent but has no observable effect. That's expected; later issues add panels that
    actually depend on the identity.</p>

    <h2>Ship gate (<code>pnpm dev-tool:check</code>)</h2>

    <p>The gate prevents prep-pipeline features from landing without dev-tool coverage. Three
    canonical contract files declare the gated surface:</p>

    <ul>
      <li><code>backend/src/contract/pipeline-routes.ts</code> — HTTP routes</li>
      <li><code>backend/src/contract/pipeline-events.ts</code> — SSE event types</li>
      <li><code>backend/src/contract/pipeline-jobs.ts</code> — BullMQ job names</li>
    </ul>

    <p>The dev tool maintains a <code>coverage.json</code> declaring what it currently exercises.
    The check script (<code>backend/scripts/dev-tool-check.ts</code>) verifies that every contract
    entry is either in <code>coverage.&lt;kind&gt;</code> or in <code>coverage.exempt.&lt;kind&gt;</code>
    (with a reason ≥ 20 chars). Stale coverage entries warn; stale exempt entries error.</p>

    <p>The gate runs in CI on every PR and on every push to main via
    <code>.github/workflows/dev-tool-check.yml</code>. Failing the gate red-lights the workflow.</p>

    <h3>Adding a pipeline route (worked example for MYT-50+)</h3>
    <ol>
      <li>Add the route literal to <code>PIPELINE_ROUTES</code> in <code>pipeline-routes.ts</code>.</li>
      <li>Implement the route handler in <code>backend/src/routes/</code>.</li>
      <li>Add a UI component in <code>backend/dev-tool/src/components/</code> that exercises the
      route via <code>apiCall(...)</code>.</li>
      <li>Add the route entry to <code>coverage.json</code>'s <code>routes</code> array.</li>
      <li>Run <code>pnpm dev-tool:check</code> locally; verify green.</li>
      <li>Commit and push.</li>
    </ol>

    <h3>Exempt list</h3>
    <p>Sparingly used. Each entry needs a reason ≥ 20 characters explaining who/why and ideally
    pointing at the Linear issue that will address the gap. Reviewed in PR.</p>

    <h2>Hard rules</h2>
    <ul>
      <li><strong>Local-only by design.</strong> No env switcher, no staging mode, no CORS plugin.
      If you need to validate against deployed staging, expand <code>pnpm smoke:staging</code>.</li>
      <li><strong>All HTTP calls go through <code>api-client.ts</code>'s <code>apiCall</code>.</strong>
      No bare <code>fetch</code>. No absolute URLs (the function throws if given one).</li>
      <li><strong>Use <code>.textContent</code>, never <code>.innerHTML</code>.</strong> Defense
      against any stored-XSS-shaped response surface that future panels might render.</li>
      <li><strong>No secrets in <code>localStorage</code>.</strong> The dev-sub key is the only
      allowed entry. Tokens, JWTs, or Anthropic keys do NOT belong here. If a future need for a
      token arises, it goes in-memory or <code>sessionStorage</code> at minimum.</li>
      <li><strong>The ship gate is not skippable.</strong> Adding <code>--no-verify</code> to
      commits with a failing <code>dev-tool:check</code> is a process violation.</li>
    </ul>
  </body>
</html>
```

- [ ] **Step 3: Verify wiki check passes**

```bash
pnpm wiki:check
```

Expected: green. If `wiki:check` reports drift on the new page (which it shouldn't, since the page is new), follow the wiki-update playbook in `docs/wiki/AUTHORING.md`.

- [ ] **Step 4: Commit**

```bash
git add docs/wiki/content/runtime/dev-tool.html
git commit -m "docs(myt-47): wiki page for dev tool + ship gate

Local-only conventions, bring-up flow, identity switcher behavior,
ship-gate mechanism with a worked example for adding a pipeline route,
hard rules (api-client only, textContent only, no secrets in
localStorage, gate is not skippable). Sources block references the
design spec + key implementation files for wiki:check drift detection."
```

---

### Task 14: Final verification

Run all quality gates on the worktree HEAD before signaling ready for merge.

- [ ] **Step 1: Run typecheck across all workspaces**

```bash
pnpm typecheck
```

Expected: green. Both `@mythrun/backend` and `@mythrun/dev-tool` (and `@mythrun/wiki`) run their typecheck scripts.

- [ ] **Step 2: Run lint across all workspaces**

```bash
pnpm lint
```

Expected: green.

- [ ] **Step 3: Run backend tests**

```bash
pnpm test
```

Expected: green. The new `check-coverage.test.ts` (8 tests) reports as passing alongside existing tests.

- [ ] **Step 4: Run the wiki check**

```bash
pnpm wiki:check
```

Expected: green.

- [ ] **Step 5: Run the ship gate**

```bash
pnpm dev-tool:check
```

Expected: `dev-tool:check — 0 error(s), 0 warning(s) [routes:0 events:0 jobs:0]`, exit 0.

- [ ] **Step 6: Final manual smoke**

In one terminal:
```bash
pnpm db:up
pnpm dev    # backend
```

In another terminal:
```bash
pnpm dev:dev-tool
```

Open `http://127.0.0.1:5273`. Verify:
1. Header shows title + identity switcher dropdown with 5 entries.
2. Health panel auto-runs `/health/ready`, shows green with status 200.
3. Click "Run" button — re-runs, still green.
4. Change identity to `dev-user-3`. Refresh. Selection persists.
5. Network tab confirms request URL is relative (`/health/ready`, served via Vite proxy at port 5273).
6. Request carries `x-mythrun-dev-sub: dev-user-3` header.

Stop both servers.

- [ ] **Step 7: Push the worktree branch as a remote backup**

Optional but recommended per CLAUDE.md merge-back flow:

```bash
git push -u origin myt-47-dev-tool-ship-gate
```

Expected: branch pushed; remote backup exists.

- [ ] **Step 8: Signal ready for merge**

At this point all gates are green and the worktree branch is at the desired state. The actual merge back to main is handled per CLAUDE.md "Merging worktree work back" — from the main repo path: `git checkout main && git pull && git merge .worktrees/myt-47 && pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check && pnpm dev-tool:check && git push origin main`, then flip Linear MYT-47 to Done and `bd worktree remove myt-47`.

No commit at this step — Task 14 is verification only.

---

## Plan complete

After Task 14, MYT-47 is ready for the merge-back flow. The dev tool runs locally, the ship gate is enforced in CI, and every subsequent prep-pipeline issue (MYT-49, MYT-50, ...) will be forced to update the dev tool when it adds backend surface — or explicitly mark an exempt entry with a real reason.
