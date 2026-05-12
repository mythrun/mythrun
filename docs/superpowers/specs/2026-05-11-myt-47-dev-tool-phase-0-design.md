# MYT-47 — Dev tool Phase 0 + ship-gate infrastructure (design)

> **Status:** Design approved 2026-05-11 (brainstorming pass). Implementation next via writing-plans.
> **Linear:** MYT-47
> **Spec parent:** `docs/specs/2026-04-13-world-campaign-pipeline.md` §12
> **Estimate per Linear:** 1 working day
> **Worktree:** `.worktrees/myt-47` on branch `myt-47-dev-tool-ship-gate`

## 1. Goal

Land two things that every subsequent prep-pipeline issue depends on:

1. **Dev tool skeleton** — a Vite SPA at `backend/dev-tool/` runnable via `pnpm dev:dev-tool`. Carries an identity switcher (synthetic `dev-user-*` sub selection persisted in `localStorage`) and a smoke-test panel that calls `GET http://localhost:3000/health/ready` so we have an end-to-end confidence check on day one.
2. **Ship-gate infrastructure** — three canonical contract files declaring the gated surface (pipeline routes, SSE events, BullMQ jobs), a coverage manifest the dev tool maintains, a `pnpm dev-tool:check` script that diffs them, and CI wiring so every subsequent PR that adds a backend pipeline surface without dev-tool coverage fails red.

Phase 0 itself is intentionally minimal. The real value is the gate: the moment MYT-49 or MYT-50 lands new pipeline routes/events/jobs, the gate forces the engineer to extend the dev tool in the same PR.

## 2. Decisions made during brainstorming

| # | Decision | Why |
|---|---|---|
| D1 | Dev tool is **local-only**. No env switcher, no staging mode. | Internet-exposed staging API + synthetic-identity bypass would be a credentialless RCE on auth. The 6-layer bypass-plugin defense exists for exactly this reason. Marginal value vs. existing `pnpm smoke:staging` doesn't justify a second auth attack surface. Hard rule documented in the wiki. |
| D2 | **No `@fastify/cors` plugin** added to the API. Dev tool talks to its own Vite dev server at `localhost:5273`; Vite proxies `/api/*` and `/health/*` to `localhost:3000` server-side. | The browser only ever sees `localhost:5273` — truly same-origin from its perspective. No CORS preflight, no `Access-Control-Allow-Origin` to maintain, no SSE/EventSource header-passing problem when MYT-50 ships streaming. The proxy is a 4-line vite.config.ts entry. The earlier `localhost:5173 ↔ localhost:3000` framing was wrong: different ports = different origins to the browser. The proxy approach makes the same-origin claim structurally true. |
| D3 | **Vite + vanilla TS + plain CSS**. No React, no Tailwind, no router. | "Doesn't need to survive into the production frontend" per spec §12.6. A reactive framework adds learning curve + maintenance for zero throwaway-tool benefit. Plain TS modules + functional components stay grep-friendly and trivially debuggable. |
| D4 | Build artifact: **never built**. Only `pnpm dev:dev-tool` runs Vite's dev server. | Local-only means no production deploy path. Removes "did the dev tool slip into a Docker image" from the worry list. Backend's `package.json` already has `"files": ["dist"]` so `pnpm deploy --prod` can't pick up `backend/dev-tool/`; `.dockerignore` adds `backend/dev-tool/` as belt-and-suspenders against a future `COPY backend/ /app/backend/` that bypasses pnpm's filter. |
| D5 | **Coverage manifest is JSON**, not a TS module. | Easier to diff in PRs, no execution. The runtime check via `pnpm dev-tool:check` is the gate; compile-time type safety wasn't worth the parsing complexity. Carries a `version` field so future schema evolution is grep-detectable. |
| D6 | **Check script lives at `backend/scripts/dev-tool-check.ts`** (backend workspace), runnable via `tsx`. | Backend workspace already has `tsx` as a dep, has the contract files in its own `src/contract/`, and is on the install path in CI. Putting the script in the dev-tool workspace would require cross-workspace relative imports (which `backend/tsconfig.json`'s `rootDir: "src"` rejects) AND a separate `pnpm install --filter @mythrun/dev-tool...` step in CI. Co-located with `coverage.json` at `backend/dev-tool/coverage.json` via `fs.readFile`. Root `pnpm dev-tool:check` invokes `pnpm --filter @mythrun/backend dev-tool:check`. |
| D7 | **CI wiring**: new dedicated workflow `.github/workflows/dev-tool-check.yml` triggered on `pull_request` AND `push: branches: [main]`. | Mirrors `wiki-check.yml`'s precedent (which also runs on both). The `deploy.yml` workflow only runs on push-to-main, not on pull requests, and its install filter (`--filter @mythrun/backend...`) excludes any workspace that isn't a backend dep — both wrong for the gate. A separate workflow file installs `@mythrun/backend` (which has the script + contracts), runs the check, and exits. Cheap; matches the wiki precedent. |
| D8 | **Pre-seeded `dev-user-*` rows in Postgres**: deferred. | Phase 0 only exercises `GET /health/ready` (public route). Authenticated routes show up in MYT-51 onward; pre-seeding handled at that point. Identity switcher in Phase 0 sets the header on every request but the value is inert for the smoke test. MYT-51's seed migration MUST use the exact list in `DEV_SUBS` — wired by the seed script importing the same constant from a shared location. |
| D9 | **`/health/ready` is NOT a pipeline route**, not in `PIPELINE_ROUTES`, not in `coverage.routes`. | It's a system-wide health endpoint outside the prep-pipeline surface. The dev tool exercises it as a smoke test but the ship gate scope is the prep pipeline only. The parent spec's example showing it in coverage was an oversight; not carried forward. |
| D10 | **Contract files don't structurally force route handlers to reference them at Phase 0.** | The §4.1 comment "type system enforces sync" was aspirational. At Phase 0 contracts are empty; nothing to enforce yet. MYT-50 (which lands the first real routes) adds either a `registerPipelineRoute(app, route, handler)` helper that takes `route: PipelineRoute`, or a Fastify `onRoute` hook that fails boot if a route matches a pipeline-path pattern but isn't in the contract. This is the actual enforcement; doc strings get weakened in §4.1 accordingly. |

## 3. File structure

```
backend/dev-tool/
├── package.json                 # @mythrun/dev-tool, private, "dev" + "typecheck" + "lint" scripts
├── vite.config.ts               # pinned: host 127.0.0.1, port 5273, strictPort, fs.strict, proxy /api + /health
├── tsconfig.json                # standalone (does NOT extend backend); module: ESNext, moduleResolution: Bundler
├── eslint.config.js             # re-exports root config with dev-tool ignores (mirrors docs/wiki/eslint.config.js)
├── index.html                   # single page, terse markup
├── src/
│   ├── main.ts                  # ~30 lines: mounts components into DOM
│   ├── identity.ts              # localStorage read/write + identitychanged event
│   ├── api-client.ts            # fetch wrapper; relative paths only (Vite proxy handles routing)
│   ├── vite-env.d.ts            # /// <reference types="vite/client" />  — typed CSS imports
│   ├── components/
│   │   ├── identity-switcher.ts # <select> bound to identity.ts
│   │   └── health-panel.ts      # smoke test card; calls /health/ready via proxy
│   └── styles.css               # plain CSS
├── coverage.json                # ship-gate coverage manifest (read by check script in backend workspace)
└── README.md                    # one-liner pointing at wiki page

backend/scripts/
└── dev-tool-check.ts            # NEW — ship-gate check script. Lives in backend workspace so it can
                                 # import contract files as same-workspace siblings and share tsx + tsconfig.

backend/src/contract/            # NEW — single source of truth
├── pipeline-routes.ts           # export const PIPELINE_ROUTES = [] as const
├── pipeline-events.ts           # export const PIPELINE_SSE_EVENTS = [] as const
└── pipeline-jobs.ts             # export const PIPELINE_BULLMQ_JOBS = [] as const

.github/workflows/
└── dev-tool-check.yml           # NEW — runs `pnpm dev-tool:check` on pull_request + push to main.

docs/wiki/content/runtime/
└── dev-tool.html                # wiki page covering tool + ship gate

# Mutations to existing files:
# - pnpm-workspace.yaml: add `backend/dev-tool` to the workspace list
# - package.json (root): add `dev:dev-tool` + `dev-tool:check` scripts
# - backend/package.json: add `dev-tool:check` script (`tsx scripts/dev-tool-check.ts`)
# - .dockerignore: add `backend/dev-tool/` (belt-and-suspenders against the day a future
#   Dockerfile does COPY backend/ /app/backend/ without filtering)
# - docs/specs/2026-04-13-world-campaign-pipeline.md §12: amend to drop env-switcher + staging
#   references. THIS LANDS AS A SEPARATE PRIOR COMMIT in the same PR so blame attribution stays clean.
```

Each file is small (<100 lines for the dev tool TS modules, ~80 for the check script). Modules pull apart cleanly; components are functional (`function mountFoo(parent): { refresh, unmount }`); cross-component coordination via `window.dispatchEvent(new CustomEvent('mythrun.identitychanged'))`. As future pipeline features land, they add new files under `components/` rather than growing existing files.

## 4. Components

### 4.1 `backend/src/contract/pipeline-routes.ts`

```ts
// Declarative list of prep-pipeline HTTP routes. The ship-gate check
// reads this list to ensure every entry has corresponding dev-tool
// coverage (or an explicit exempt entry). The list seeds empty; routes
// accumulate as MYT-50 onward lands them.
//
// NOTE: at Phase 0, this list does NOT structurally force route
// handlers to import their entry from here. The enforcement layer
// (either a `registerPipelineRoute(app, route, handler)` helper that
// constrains `route: PipelineRoute`, or a Fastify `onRoute` hook that
// fails boot if a pipeline-pattern URL is registered without being in
// PIPELINE_ROUTES) lands in MYT-50 along with the first real routes.
// Phase 0 documents the convention; MYT-50 enforces it mechanically.
export const PIPELINE_ROUTES: readonly string[] = [] as const

export type PipelineRoute = (typeof PIPELINE_ROUTES)[number]
```

`pipeline-events.ts` and `pipeline-jobs.ts` follow the same shape with the same enforcement caveat. The `readonly string[]` type annotation (instead of bare `as const`) is intentional — it makes `PIPELINE_ROUTES.includes(someString)` accept a `string` argument without `as never` games (otherwise an empty `as const` array's `.includes()` type is `never`).

### 4.2 `backend/dev-tool/coverage.json`

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

Seeded empty (no pipeline routes/events/jobs exist yet). `/health/ready` is NOT in `routes` — it's a system-wide health endpoint, not a pipeline surface (see D9). The `exempt` sub-objects are keyed by entry → reason string; used sparingly when a contract entry genuinely doesn't need dev-tool UI (e.g., barrier jobs that fire transitively). Reasons must be ≥ 20 characters (enforced by check script) to prevent placeholder/empty-handwave exemptions. The `version` field allows future schema evolution to be grep-detectable.

### 4.3 `backend/scripts/dev-tool-check.ts`

Lives in the backend workspace (not dev-tool) so it can import contract files as same-workspace siblings and reuse backend's existing `tsx` dependency + tsconfig. Coverage manifest is read via `fs` from the dev-tool location.

```ts
#!/usr/bin/env tsx
// Ship gate. Every contract entry must be either in `coverage.<kind>`
// or in `coverage.exempt.<kind>` (with a reason ≥ 20 chars). Stale
// coverage entries — present in coverage but absent from contract —
// warn; stale exempt entries error (they're escape hatches that should
// be cleaned up explicitly when no longer needed).

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { PIPELINE_ROUTES } from '../src/contract/pipeline-routes.js'
import { PIPELINE_SSE_EVENTS } from '../src/contract/pipeline-events.js'
import { PIPELINE_BULLMQ_JOBS } from '../src/contract/pipeline-jobs.js'

const MIN_REASON_LENGTH = 20

type Kind = 'routes' | 'events' | 'jobs'

interface Coverage {
  readonly version: number
  readonly routes: readonly string[]
  readonly events: readonly string[]
  readonly jobs: readonly string[]
  readonly exempt: {
    readonly routes: Readonly<Record<string, string>>
    readonly events: Readonly<Record<string, string>>
    readonly jobs: Readonly<Record<string, string>>
  }
}

const here = dirname(fileURLToPath(import.meta.url))
const coveragePath = join(here, '..', 'dev-tool', 'coverage.json')
const raw = await readFile(coveragePath, 'utf8')
const coverage = JSON.parse(raw) as Coverage

if (coverage.version !== 1) {
  console.error(`error: coverage.json version ${String(coverage.version)} not understood by this script`)
  process.exit(1)
}

const contracts: ReadonlyArray<readonly [Kind, readonly string[]]> = [
  ['routes', PIPELINE_ROUTES],
  ['events', PIPELINE_SSE_EVENTS],
  ['jobs', PIPELINE_BULLMQ_JOBS],
]

let errors = 0
let warnings = 0

for (const [kind, contract] of contracts) {
  const coveredList: readonly string[] = coverage[kind]
  const exempt: Readonly<Record<string, string>> = coverage.exempt[kind]
  const covered = new Set(coveredList)
  const contractSet = new Set(contract)

  // Missing-coverage check
  for (const entry of contract) {
    if (covered.has(entry)) continue
    const reason = exempt[entry]
    if (reason !== undefined) {
      if (reason.trim().length < MIN_REASON_LENGTH) {
        console.error(
          `error: ${kind}/${entry} exempt reason is too short (< ${String(MIN_REASON_LENGTH)} chars). ` +
            `Write a real reason: who, why, and which Linear/MYT-* issue addresses the gap.`,
        )
        errors++
      }
      continue
    }
    console.error(
      `error: ${kind}/${entry} is in contract but neither in coverage nor exempt — ` +
        `add a dev-tool UI for it (and add the entry to backend/dev-tool/coverage.json), ` +
        `OR add it to coverage.exempt.${kind} with a reason.`,
    )
    errors++
  }

  // Stale-coverage warning (in coverage, not in contract)
  for (const entry of coveredList) {
    if (!contractSet.has(entry)) {
      console.warn(`warn:  ${kind}/${entry} is in coverage but no longer in contract — consider removing`)
      warnings++
    }
  }

  // Stale-exempt error (in exempt, not in contract) — escape hatches must be cleaned up explicitly
  for (const entry of Object.keys(exempt)) {
    if (!contractSet.has(entry)) {
      console.error(`error: ${kind}/${entry} is in exempt but no longer in contract — remove the exempt entry`)
      errors++
    }
  }
}

const summary = `routes:${String(coverage.routes.length)} events:${String(coverage.events.length)} jobs:${String(coverage.jobs.length)}`
console.log(`dev-tool:check — ${String(errors)} error(s), ${String(warnings)} warning(s) [${summary}]`)
process.exit(errors > 0 ? 1 : 0)
```

Runs in <100ms (pure file reads). Phase 0 contracts are empty → trivially passes. TypeScript-strict-clean: no `as never`, no unbound `noUncheckedIndexedAccess` access (every indexed read is bound to a typed local). Imports the three contract constants as same-workspace siblings (backend → backend); the path resolution works under backend's `tsconfig.json` without any rootDir gymnastics.

### 4.4 `backend/dev-tool/src/identity.ts`

```ts
// Read/write the active dev-sub identity in localStorage and emit a
// custom event on changes so other components can re-render.

const STORAGE_KEY = 'mythrun.devtool.devSub'
const EVENT = 'mythrun.identitychanged'

export const DEV_SUBS = ['dev-user-1', 'dev-user-2', 'dev-user-3', 'dev-user-4', 'dev-user-5'] as const
export type DevSub = (typeof DEV_SUBS)[number]

export function getCurrentDevSub(): DevSub {
  const stored = localStorage.getItem(STORAGE_KEY)
  if (stored && (DEV_SUBS as readonly string[]).includes(stored)) {
    return stored as DevSub
  }
  return 'dev-user-1'
}

export function setCurrentDevSub(sub: DevSub): void {
  localStorage.setItem(STORAGE_KEY, sub)
  window.dispatchEvent(new CustomEvent(EVENT, { detail: sub }))
}

export function onIdentityChanged(cb: (sub: DevSub) => void): () => void {
  const handler = (e: Event): void => cb((e as CustomEvent<DevSub>).detail)
  window.addEventListener(EVENT, handler)
  return () => { window.removeEventListener(EVENT, handler) }
}
```

### 4.5 `backend/dev-tool/src/api-client.ts`

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
  // Path guard: relative paths only. Prevents future bug where someone
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

### 4.6 `backend/dev-tool/src/components/identity-switcher.ts`

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
  for (const sub of DEV_SUBS) {
    const opt = document.createElement('option')
    opt.value = sub
    opt.textContent = sub
    if (sub === getCurrentDevSub()) opt.selected = true
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

### 4.7 `backend/dev-tool/src/components/health-panel.ts`

```ts
// Smoke test card. Auto-runs /health/ready on mount and on identity
// change. Shows status, body, latency.

import { apiCall } from '../api-client.js'
import { onIdentityChanged } from '../identity.js'

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
    const res = await apiCall('/health/ready')
    const lines = [
      `status:    ${String(res.status)}`,
      `ok:        ${String(res.ok)}`,
      `latency:   ${String(res.latencyMs)}ms`,
      `body:      ${res.body !== null ? JSON.stringify(res.body, null, 2) : '(empty)'}`,
    ]
    if (res.error) lines.push(`error:     ${res.error}`)
    result.textContent = lines.join('\n')
    card.classList.toggle('ok', res.ok)
    card.classList.toggle('err', !res.ok)
  }

  button.addEventListener('click', () => { void run() })
  // No identity-change subscription — /health/ready is public (auth='public'
  // in the public-route allowlist), so identity has no effect on the result.
  // Re-running on every identity switch would pollute server logs for no
  // signal. Future panels that DO depend on identity will subscribe to
  // onIdentityChanged in their own mountFoo().

  card.appendChild(title)
  card.appendChild(button)
  card.appendChild(result)
  parent.appendChild(card)

  void run()
}
```

### 4.8 `backend/dev-tool/src/main.ts`

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

### 4.9 `backend/dev-tool/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
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

### 4.10 `backend/dev-tool/src/styles.css`

Plain CSS, ~50 lines. Wiki-styled — system fonts, monospace headings, minimal padding, no shadow/glow effects. Two semantic colors: a muted green for `card.ok`, muted red for `card.err`. No hover states beyond browser defaults.

## 5. Configuration files

### 5.1 `backend/dev-tool/package.json`

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

`typecheck` and `lint` scripts mean root recursion (`pnpm -r typecheck` / `pnpm -r lint`) picks the workspace up. No `test` script at Phase 0 — there's nothing test-worthy here yet; when components grow, add `vitest` + a `test` script.

### 5.2 `backend/dev-tool/vite.config.ts`

```ts
import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  const backendEnv = loadEnv(mode, resolve(here, '..'), '')
  const backendPort = backendEnv.PORT ?? '3000'
  const backendTarget = `http://localhost:${backendPort}`

  return {
    server: {
      host: '127.0.0.1',           // loopback only — never expose to LAN
      port: 5273,                  // NOT 5173 (reserved for future production frontend)
      strictPort: true,            // fail rather than silently picking another port
      fs: { strict: true },        // refuse to serve files outside project root
      proxy: {
        '/api': backendTarget,
        '/health': backendTarget,
      },
    },
  }
})
```

The proxy is what makes "same-origin" structurally true: the browser sees only `http://127.0.0.1:5273`; Vite forwards `/api/*` and `/health/*` requests to the backend transparently. No CORS preflight, no `Access-Control-*` headers needed, no SSE-EventSource-can't-set-headers problem when MYT-50 streaming arrives.

**Backend port is configurable.** `loadEnv` reads `backend/.env.development` (without the `VITE_` prefix filter) and pulls `PORT`. Single source of truth — the engineer sets `PORT` once in their env file and both backend and Vite proxy honor it. Defaults to 3000 if missing. No hardcoded port in this config.

### 5.3 `backend/dev-tool/tsconfig.json`

Does NOT extend `backend/tsconfig.json` — that config sets `rootDir: "src"` + `module: "NodeNext"` which are wrong for a Vite-bundled SPA. Standalone config:

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

Matches the strictness level of `backend/tsconfig.json` but with Bundler-mode resolution suited to Vite.

### 5.4 `backend/dev-tool/eslint.config.js`

```js
import root from '../../eslint.config.js'

export default [
  ...root,
  { ignores: ['src/**/*.css', 'index.html', 'node_modules/**'] },
]
```

Mirrors the wiki workspace pattern (`docs/wiki/eslint.config.js`).

### 5.5 `backend/dev-tool/src/vite-env.d.ts`

```ts
/// <reference types="vite/client" />
```

One line. Lets TS recognize `import './styles.css'` and other Vite-provided imports.

### 5.6 Root `package.json` additions

```json
"dev:dev-tool":   "pnpm --filter @mythrun/dev-tool dev",
"dev-tool:check": "pnpm --filter @mythrun/backend dev-tool:check"
```

Note: `dev-tool:check` runs against the **backend** workspace, where the check script lives.

### 5.7 `backend/package.json` scripts addition

```json
"dev-tool:check": "tsx scripts/dev-tool-check.ts"
```

### 5.8 `pnpm-workspace.yaml`

Add `backend/dev-tool` to the workspace list.

### 5.9 `.dockerignore` addition

Add one line: `backend/dev-tool/`. Belt-and-suspenders against any future Dockerfile change that copies all of `backend/` without filtering.

## 6. CI wiring

New file `.github/workflows/dev-tool-check.yml`:

```yaml
name: Dev tool check

on:
  pull_request:
    paths:
      - 'backend/src/contract/**'
      - 'backend/dev-tool/**'
      - 'backend/scripts/dev-tool-check.ts'
      - 'backend/package.json'
      - '.github/workflows/dev-tool-check.yml'
  push:
    branches: [main]
    paths:
      - 'backend/src/contract/**'
      - 'backend/dev-tool/**'
      - 'backend/scripts/dev-tool-check.ts'
      - 'backend/package.json'

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v6
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - run: pnpm install --frozen-lockfile --filter @mythrun/backend...
      - run: pnpm dev-tool:check
```

This workflow is a **peer** of `wiki-check.yml` — both run on PR + push to main, both scope their install to the workspace they need. The check is NOT added to `deploy.yml` because deploy.yml only fires on push-to-main (not PRs) and its install filter (`--filter @mythrun/backend...`) is identical to what we need anyway — duplicating the step there adds no coverage and bloats the build job's running time.

The `paths:` filter prevents the gate from firing on PRs that don't touch the gated surface (avoiding spurious CI minutes on, e.g., a docs-only PR).

## 7. Wiki page (`docs/wiki/content/runtime/dev-tool.html`)

Structure:

1. **What it is** — Local-only engineering UI for the development backend. Runs via `pnpm dev:dev-tool` on `http://127.0.0.1:5273`. Not a prototype of the real frontend.
2. **What it isn't** — Not deployed anywhere. Not a staging surface. Not a production debug tool.
3. **Bring-up** — Three commands: `pnpm install`, `pnpm dev:dev-tool`, open `http://127.0.0.1:5273`. Vite proxies `/api/*` and `/health/*` to the local backend at `localhost:3000`.
4. **Identity switcher** — Header dropdown. Selection persists in `localStorage` (key: `mythrun.devtool.devSub`). Every API call carries `x-mythrun-dev-sub`. Future multi-player flows: switch identities between requests to act as different players. The current Phase 0 smoke test exercises `/health/ready`, which is a public route — identity has no observable effect; that's expected.
5. **Ship gate (`pnpm dev-tool:check`)** — Reads three contract files in `backend/src/contract/` + `backend/dev-tool/coverage.json`. Errors if a contract entry is missing from coverage (or from exempt with a real reason). Stale coverage entries warn; stale exempt entries error. Runs in CI on every PR + push to main via `.github/workflows/dev-tool-check.yml`. Adding a pipeline route → add to `pipeline-routes.ts` AND add the matching dev-tool UI component AND extend `coverage.json` in the same PR.
6. **Exempt list** — Sparingly used. Each entry needs a reason ≥ 20 characters explaining who/why and ideally pointing at the Linear issue that will address the gap. Reviewed in PR.
7. **Hard rules (security + maintenance)**:
   - **Local-only by design.** No env switcher. No staging mode. No CORS plugin. If you need to validate something against deployed staging, expand `pnpm smoke:staging`. The dev tool exists to iterate on the local backend; it does not exist to debug staging.
   - **All HTTP calls go through `api-client.ts`'s `apiCall`.** No bare `fetch`. No absolute URLs.
   - **Use `.textContent`, never `.innerHTML`.** Defense against any stored-XSS-shaped response surface appearing in future panels.
   - **No secrets in `localStorage`.** The dev-sub key is the only allowed entry. Tokens, JWTs, or Anthropic keys do NOT belong here. If a future need for a token arises, it goes in-memory or `sessionStorage` at minimum.

## 8. Done-when checklist

- [ ] `backend/dev-tool/` populated per §3 file structure (package.json, vite.config.ts, tsconfig.json, eslint.config.js, index.html, src/{main.ts, identity.ts, api-client.ts, vite-env.d.ts, components/, styles.css}, coverage.json, README.md)
- [ ] `backend/src/contract/{pipeline-routes,pipeline-events,pipeline-jobs}.ts` created with empty arrays typed `readonly string[]`
- [ ] `backend/scripts/dev-tool-check.ts` created per §4.3
- [ ] `coverage.json` seeded with `version: 1`, empty arrays, empty exempt
- [ ] `.github/workflows/dev-tool-check.yml` created per §6
- [ ] `pnpm-workspace.yaml` includes `backend/dev-tool`
- [ ] Root `package.json` carries `dev:dev-tool` + `dev-tool:check` scripts; `backend/package.json` carries `dev-tool:check`
- [ ] `.dockerignore` includes `backend/dev-tool/`
- [ ] `pnpm install` regenerates `pnpm-lock.yaml`; lockfile committed in the same PR (otherwise `--frozen-lockfile` in CI red-lights immediately)
- [ ] `pnpm dev:dev-tool` launches Vite on `127.0.0.1:5273`, page renders, smoke test calls `/health/ready` via the proxy and returns 200 with the local backend running
- [ ] Identity switcher dropdown reflects `DEV_SUBS` (5 entries), persists across reload
- [ ] `pnpm dev-tool:check` runs green locally and in CI
- [ ] `pnpm typecheck` and `pnpm lint` both pick up the dev-tool workspace (verify by introducing a temp type error / lint violation and confirming the failure)
- [ ] Wiki page `docs/wiki/content/runtime/dev-tool.html` lands per §7; `pnpm wiki:check` green
- [ ] Spec amendment to `docs/specs/2026-04-13-world-campaign-pipeline.md` §12 (drop env-switcher + staging-deploy references) lands as a **separate prior commit** in this PR, with its own commit message attributing the design change. Keeps `git blame` on §12.3 attributing the change to a deliberate decision, not to MYT-47 implementation.
- [ ] All quality gates green in the worktree: `pnpm typecheck && pnpm lint && pnpm test && pnpm wiki:check && pnpm dev-tool:check`
- [ ] Merge worktree → main → push per CLAUDE.md merge-back flow

## 9. Out of scope (explicit non-goals for this issue)

- **Env switcher / staging mode** (dropped per D1)
- **`@fastify/cors` plugin** (D2 — Vite proxy makes it unnecessary)
- **KMS-signed token auth scheme** (dropped with D1; revisit if staging-validation use case ever surfaces)
- **Pre-seeded `dev-user-*` rows in Postgres** (deferred; Phase 0 only hits public `/health/ready`). MYT-51's seed migration MUST seed exactly the identities in `DEV_SUBS` — sharing the constant or running a check against it is MYT-51's responsibility.
- **`registerPipelineRoute` helper or `onRoute` enforcement hook** (deferred to MYT-50, which lands the first real routes; that issue makes the gate mechanically catch "route registered without contract entry" instead of relying on convention). At Phase 0 the contracts are empty; there's no route to enforce.
- **Production-exclusion logic** (dev tool isn't included in any production path; `.dockerignore` exclusion is belt-and-suspenders)
- **Pipeline routes/events/jobs themselves** (those land in MYT-50 onward; contracts and coverage stay empty in this issue)
- **SVG graph rendering, world-create UI, character-create UI, etc.** (all future issues; each lands its own component file)
- **Per-kind coverage files** (`coverage-routes.json` etc.) — single `coverage.json` is fine until the surface gets large enough to cause merge-conflict friction; revisit at 20+ entries.
- **Content-Security-Policy header on the dev tool's HTML** — `textContent`-only rule in §7 covers the practical concern; CSP is a future hardening if the page grows.

## 10. Estimate

1 working day. Breakdown (revised after blind review):
- Spec amendment to parent §12 (separate prior commit): 30 minutes
- Vite scaffold (package.json, vite.config.ts with proxy, tsconfig.json, eslint.config.js, vite-env.d.ts, pnpm-workspace.yaml, .dockerignore, lockfile regen): 1.5 hours
- Identity + api-client + components + main + styles: 2 hours
- Contract files + coverage.json + check.ts (in backend/scripts/): 1 hour
- CI workflow file (.github/workflows/dev-tool-check.yml): 30 minutes
- Wiki page: 1 hour
- Verification (all `*:check` green, dev tool boots, smoke renders 200): 1 hour
- Slack/review buffer: 30 minutes

8 hours of focused single-thread work. The implementation is sequential (check script depends on contract files; main depends on identity + api-client) — parallel implementer-subagents wouldn't help, so no subagent-driven-development pattern here. Estimate risk lives in the Vite/tsconfig dance (first time setting up a workspace in this repo with Bundler-mode resolution); if that takes longer than expected, the buffer absorbs it.
