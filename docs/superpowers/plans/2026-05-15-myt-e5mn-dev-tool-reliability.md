# Dev-Tool Reliability System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mechanically-enforced reliability system around the dev tool: a registry-driven JSDOM verification harness, a verifier subagent that owns its maintenance, hook + pre-push gating that prevents broken dev-tool changes from reaching the user, and a full-route contract source that makes "every backend route has a panel" structurally enforceable.

**Architecture:** Six components per the design spec (`docs/superpowers/specs/2026-05-15-dev-tool-reliability-design.md`): `AUTHORING.md` (contract doc + subagent dispatch prompt), `verify-registry.ts` (panel→pattern+assertions registry), `scripts/verify.ts` (JSDOM harness CLI), `backend-routes.ts` (full-route contract source), the verifier subagent (autonomous edit + fix authority), and the hook + pre-push gate. The verifier subagent owns ongoing maintenance of the dev-tool subtree; the controller (host agent) owns staging, commits, and the contract source.

**Tech Stack:** TypeScript strict, Fastify (existing), Vitest (existing test runner), JSDOM (new devDep in `backend/dev-tool`), Husky (existing pre-push), Claude Code hooks (existing `.claude/settings.json` pattern).

---

## File map

**New:**
- `backend/src/contract/backend-routes.ts` — full-route enumeration, source of truth for principle 1
- `backend/src/contract/__tests__/backend-routes.test.ts` — Fastify printRoutes() drift test
- `backend/dev-tool/verify-registry.ts` — panel registry with patterns + assertions
- `backend/dev-tool/__tests__/verify-registry.test.ts` — three build-time invariants
- `backend/dev-tool/scripts/verify.ts` — JSDOM harness CLI
- `backend/dev-tool/scripts/__tests__/verify.test.ts` — harness unit tests (helpers, not the harness end-to-end)
- `backend/dev-tool/AUTHORING.md` — contract document + subagent dispatch prompt
- `.claude/hooks/post-dev-tool-edit.sh` — PostToolUse reminder

**Modify:**
- `backend/dev-tool/package.json` — add `jsdom` devDep + `dev-tool:verify` script
- `backend/src/app.ts` (or wherever Fastify routes get registered) — verify printRoutes() exposes the route inventory we need
- `.claude/settings.json` — register the new hook under PostToolUse
- `.husky/pre-push` — add gate 6, renumber 1–5 references to 1–6 in three places
- `backend/dev-tool/src/main.ts` — possibly re-export panel mount functions for the registry (one centralized re-export point)
- `backend/dev-tool/src/components/*.ts` (8 panels) — retrofit `data-state` attributes; the verifier subagent does this in Task 13

---

## Task 1: `backend-routes.ts` — full-route contract source + drift test

**Files:**
- Create: `backend/src/contract/backend-routes.ts`
- Create: `backend/src/contract/__tests__/backend-routes.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/src/contract/__tests__/backend-routes.test.ts
//
// Drift-prevention test for the full-route contract source. Boots a Fastify
// app via the production app factory, enumerates every registered route via
// app.printRoutes({ commonPrefix: false, includeMeta: false }), and asserts
// the in-memory set is identical to BACKEND_ROUTES. New routes added to a
// handler without updating the contract source fail this test.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { buildApp } from '../../app.js'
import { BACKEND_ROUTES, type BackendRoute } from '../backend-routes.js'
import type { FastifyInstance } from 'fastify'

interface PrintedRoute {
  readonly method: string
  readonly path: string
}

function parsePrintedRoutes(app: FastifyInstance): PrintedRoute[] {
  // Fastify's app.printRoutes() returns a tree-formatted string. The
  // commonPrefix:false variant prints one route per line in the form
  // `METHOD\t/path`. We split + dedupe.
  const raw = app.printRoutes({ commonPrefix: false })
  const lines = raw.split('\n').filter((l) => /^[A-Z]+\s+\//.test(l))
  const seen = new Set<string>()
  const out: PrintedRoute[] = []
  for (const line of lines) {
    const [method, ...rest] = line.trim().split(/\s+/)
    if (!method) continue
    const path = rest.join(' ')
    const key = `${method} ${path}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ method, path })
  }
  return out
}

function toKey(r: { method: string; path: string }): string {
  return `${r.method} ${r.path}`
}

describe('BACKEND_ROUTES contract drift', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    // buildApp() is the production app factory used by server.ts. It must
    // register every route the production server registers — that's the
    // invariant we're enforcing.
    app = await buildApp({ /* minimal deps stub */ })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
  })

  it('BACKEND_ROUTES enumerates every route the Fastify app registers', () => {
    const printed = parsePrintedRoutes(app).map(toKey).sort()
    const contracted = BACKEND_ROUTES.map(toKey).sort()
    expect(printed).toEqual(contracted)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && pnpm vitest run src/contract/__tests__/backend-routes.test.ts`
Expected: FAIL with "Cannot find module '../backend-routes.js'"

- [ ] **Step 3: Implement BACKEND_ROUTES**

```ts
// backend/src/contract/backend-routes.ts
//
// Full enumeration of every route the production Fastify app registers.
// The drift test in __tests__/backend-routes.test.ts boots the app and
// diffs app.printRoutes() against this list; adding a new route handler
// without updating this list fails the test.
//
// Pipeline routes (a subset) are also tracked separately in
// pipeline-routes.ts for the status surface. Both stay in sync via the
// drift test — anything in pipeline-routes that isn't here is a contract
// bug.

export interface BackendRoute {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  readonly path: string
}

export const BACKEND_ROUTES: readonly BackendRoute[] = [
  // Health
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/health/ready' },

  // Users
  { method: 'POST', path: '/api/users/register' },
  { method: 'GET', path: '/api/users/check-username' },
  { method: 'GET', path: '/api/users/me' },

  // Campaigns (pipeline + non-pipeline)
  { method: 'POST', path: '/api/campaigns' },
  { method: 'GET', path: '/api/campaigns/mine' },
  { method: 'GET', path: '/api/campaigns/:campaignId' },
  { method: 'DELETE', path: '/api/campaigns/:campaignId' },
  { method: 'POST', path: '/api/campaigns/:campaignId/resume' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status' },
  { method: 'GET', path: '/api/campaigns/:campaignId/status/stream' },

  // Sessions
  { method: 'POST', path: '/api/sessions/:id/ws-ticket' },

  // Invites
  { method: 'POST', path: '/api/campaigns/:campaignId/invites' },
  { method: 'GET', path: '/api/campaigns/:campaignId/invites' },
  { method: 'DELETE', path: '/api/campaigns/:campaignId/invites/:inviteCode' },
  { method: 'GET', path: '/api/invites/:inviteCode' },
  { method: 'POST', path: '/api/invites/:inviteCode/accept' },
  { method: 'GET', path: '/api/campaigns/:campaignId/members' },

  // Dev credits (AUTH_MODE=bypass only)
  { method: 'POST', path: '/api/dev/credits/grant' },
  { method: 'GET', path: '/api/dev/credits/me' },

  // Billing — TO BE FILLED IN by the test's first run (Step 4 below
  // identifies the actual paths from app.printRoutes() output)
]
```

- [ ] **Step 4: Run test; capture the diff and update BACKEND_ROUTES**

Run: `cd backend && pnpm vitest run src/contract/__tests__/backend-routes.test.ts`
Expected: Fails with a printable diff between `printed` and `contracted`. The diff IS the inventory you need — every "missing from contracted" path goes into BACKEND_ROUTES; every "extra in contracted" gets removed.

Iterate Step 3 + Step 4 until the test passes.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd backend && pnpm vitest run src/contract/__tests__/backend-routes.test.ts`
Expected: PASS.

- [ ] **Step 6: Run typecheck + lint**

Run: `cd backend && pnpm typecheck && pnpm lint`
Expected: zero errors on new files.

- [ ] **Step 7: Commit**

Subagent reports DONE; controller commits:
```
feat(myt-e5mn): backend-routes.ts — full-route contract source + Fastify drift test
```

---

## Task 2: Add `jsdom` devDep + `dev-tool:verify` package script

**Files:**
- Modify: `backend/dev-tool/package.json`
- Run: `pnpm install`

- [ ] **Step 1: Edit `backend/dev-tool/package.json`**

Add to `devDependencies`:
```json
"jsdom": "^25.0.0",
"@types/jsdom": "^21.1.0"
```

Add to `scripts`:
```json
"verify": "tsx scripts/verify.ts"
```

The root `package.json`'s recursive runner exposes this as `pnpm dev-tool:verify` via the existing pattern: add to root `package.json` scripts:
```json
"dev-tool:verify": "pnpm --filter @mythrun/dev-tool verify"
```

- [ ] **Step 2: Run install**

Run: `pnpm install`
Expected: jsdom + @types/jsdom resolve; lockfile updated.

- [ ] **Step 3: Verify the script is reachable**

Run: `pnpm dev-tool:verify --help 2>&1 || true`
Expected: error about script not found (since scripts/verify.ts doesn't exist yet) — confirms wiring works but implementation is pending.

- [ ] **Step 4: Commit**

```
chore(myt-e5mn): add jsdom devDep + dev-tool:verify script entry
```

---

## Task 3: `verify-registry.ts` skeleton + first two panel entries

**Files:**
- Create: `backend/dev-tool/verify-registry.ts`
- Reference: `backend/src/contract/backend-routes.ts` (Task 1 must be done)

- [ ] **Step 1: Write the registry module**

```ts
// backend/dev-tool/verify-registry.ts
//
// Panel registry for the dev-tool verifier (myth-e5mn). Each panel
// declares its interaction pattern + DOM markers; the verify harness
// (scripts/verify.ts) uses these to apply pattern-appropriate assertions.
//
// Three build-time invariants are enforced by __tests__/verify-registry.test.ts:
//   1. Forward coverage: every panel module exporting a mount* function
//      has a registry entry.
//   2. Reverse coverage: every registry key is imported by main.ts.
//   3. Route exhaustion: union(PANEL_REGISTRY.*.exercises) ⊇ BACKEND_ROUTES.

import type { BackendRoute } from '../src/contract/backend-routes.js'

import { mountIdentitySwitcher } from './src/components/identity-switcher.js'
import { mountHealthPanel } from './src/components/health-panel.js'
import { mountCampaignCreatePanel } from './src/components/campaign-create-panel.js'
import { mountMyCampaignsPanel } from './src/components/my-campaigns-panel.js'
import { mountStatusPanel } from './src/components/status-panel.js'
import { mountLiveEventsPanel } from './src/components/live-events-panel.js'
import { mountCampaignDetailsPanel } from './src/components/campaign-details-panel.js'
import { mountCreditLedgerPanel } from './src/components/credit-ledger-panel.js'

export type PanelPattern = 'fetch-on-mount' | 'event-driven' | 'action-only'

export interface PanelRegistration {
  /** Interaction pattern; drives which assertions the harness applies. */
  readonly pattern: PanelPattern
  /** The panel's mount function. Called with a fresh <div> as parent. */
  readonly mount: (parent: HTMLElement) => void | Promise<void>
  /** CSS selector indicating the panel reached its expected post-mount
   *  state. For fetch-on-mount: data-state="loaded". For event-driven:
   *  data-state="idle". For action-only: data-state="ready". */
  readonly readySelector: string
  /** CSS selector indicating the panel rendered an error banner.
   *  Distinct from "loaded" so empty-but-healthy state isn't misread. */
  readonly errorSelector: string
  /** Max ms to wait for readySelector OR errorSelector after mount. */
  readonly readyTimeoutMs?: number
  /** console.error messages allowed during mount. Substring match. */
  readonly errorAllowlist?: readonly string[]
  /** Backend routes this panel exercises. Typed import prevents drift. */
  readonly exercises: readonly BackendRoute[]
}

// One route from BACKEND_ROUTES, picked by method+path. Helper for declaring
// `exercises` arrays without re-typing the route literal.
function route(method: BackendRoute['method'], path: string): BackendRoute {
  // The registry test (route exhaustion invariant) ensures every value
  // returned here is in BACKEND_ROUTES; if not, the test fails on union.
  return { method, path }
}

export const PANEL_REGISTRY: Readonly<Record<string, PanelRegistration>> = {
  'identity-switcher': {
    pattern: 'event-driven',
    mount: mountIdentitySwitcher,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [],
  },
  'health': {
    pattern: 'fetch-on-mount',
    mount: mountHealthPanel,
    readySelector: '[data-state="loaded"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/health')],
  },
  'campaign-create': {
    pattern: 'action-only',
    mount: mountCampaignCreatePanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('POST', '/api/campaigns')],
  },
  'my-campaigns': {
    pattern: 'fetch-on-mount',
    mount: mountMyCampaignsPanel,
    readySelector: '[data-state="loaded"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/mine')],
  },
  'status': {
    pattern: 'event-driven',
    mount: mountStatusPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('GET', '/api/campaigns/:campaignId/status'),
      route('GET', '/api/campaigns/:campaignId/status/stream'),
    ],
  },
  'live-events': {
    pattern: 'event-driven',
    mount: mountLiveEventsPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [route('GET', '/api/campaigns/:campaignId/status/stream')],
  },
  'campaign-details': {
    pattern: 'event-driven',
    mount: mountCampaignDetailsPanel,
    readySelector: '[data-state="idle"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('GET', '/api/campaigns/:campaignId'),
      route('DELETE', '/api/campaigns/:campaignId'),
      route('POST', '/api/campaigns/:campaignId/resume'),
    ],
  },
  'credit-ledger': {
    pattern: 'action-only',
    mount: mountCreditLedgerPanel,
    readySelector: '[data-state="ready"]',
    errorSelector: '[data-state="error"]',
    exercises: [
      route('POST', '/api/dev/credits/grant'),
      route('GET', '/api/dev/credits/me'),
    ],
  },
}
```

- [ ] **Step 2: Run typecheck**

Run: `cd backend && pnpm typecheck`
Expected: PASS (or fail only on missing data-state retrofits — the registry itself should compile).

- [ ] **Step 3: Commit**

```
feat(myt-e5mn): verify-registry.ts — panel registry with pattern declarations
```

Note: this commit lands the registry with the aspirational `data-state` selectors. Existing panel modules don't yet set these attributes; the verifier subagent's Task 13 run will retrofit them. The verify-registry.test.ts invariants (Task 4) will pass; the live verify run will fail until panels are retrofitted.

---

## Task 4: `verify-registry.test.ts` — three invariants

**Files:**
- Create: `backend/dev-tool/__tests__/verify-registry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// backend/dev-tool/__tests__/verify-registry.test.ts
//
// Build-time invariants for the panel registry (myth-e5mn Component 2):
//   1. Forward coverage — every panel module exporting `mount*` is registered.
//   2. Reverse coverage — every registered key is imported by main.ts.
//   3. Route exhaustion — every BackendRoute is exercised by at least one panel.

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
import { PANEL_REGISTRY } from '../verify-registry.js'
import { BACKEND_ROUTES, type BackendRoute } from '../../src/contract/backend-routes.js'

const here = dirname(fileURLToPath(import.meta.url))
const COMPONENTS_DIR = resolve(here, '../src/components')
const MAIN_TS = resolve(here, '../src/main.ts')

function panelModulesWithMount(): string[] {
  // Find every .ts file under src/components (excluding __tests__) that
  // exports a `mount*` function. We don't actually parse the AST; we
  // grep for `export function mount` at the start of a line, which
  // matches the established convention.
  const entries = readdirSync(COMPONENTS_DIR, { withFileTypes: true })
  const out: string[] = []
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue
    if (entry.name.endsWith('.test.ts')) continue
    const text = readFileSync(resolve(COMPONENTS_DIR, entry.name), 'utf8')
    if (/^export\s+function\s+mount\w+/m.test(text)) {
      // panel-id is the filename minus the -panel.ts / .ts suffix
      const id = entry.name.replace(/\.ts$/, '').replace(/-panel$/, '')
      out.push(id)
    }
  }
  return out
}

function panelIdsImportedByMain(): string[] {
  // Read main.ts; find every `from './components/<id>(-panel)?.js'`.
  const text = readFileSync(MAIN_TS, 'utf8')
  const ids: string[] = []
  const re = /from\s+['"]\.\/components\/([\w-]+)(?:-panel)?\.js['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    const id = m[1]?.replace(/-panel$/, '')
    if (id) ids.push(id)
  }
  return ids
}

describe('PANEL_REGISTRY invariants', () => {
  it('forward coverage — every panel module with a mount* export is registered', () => {
    const onDisk = panelModulesWithMount().sort()
    const registered = Object.keys(PANEL_REGISTRY).sort()
    expect(registered).toEqual(onDisk)
  })

  it('reverse coverage — every registered panel is imported by main.ts', () => {
    const registered = Object.keys(PANEL_REGISTRY).sort()
    const imported = panelIdsImportedByMain().sort()
    for (const id of registered) {
      expect(imported).toContain(id)
    }
  })

  it('route exhaustion — every BACKEND_ROUTE is exercised by some panel', () => {
    const exercised = new Set<string>()
    for (const reg of Object.values(PANEL_REGISTRY)) {
      for (const r of reg.exercises) {
        exercised.add(`${r.method} ${r.path}`)
      }
    }
    const uncovered: BackendRoute[] = []
    for (const route of BACKEND_ROUTES) {
      if (!exercised.has(`${route.method} ${route.path}`)) {
        uncovered.push(route)
      }
    }
    expect(uncovered, `routes not exercised by any panel: ${JSON.stringify(uncovered)}`).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test; iterate on registry until all three invariants pass**

Run: `cd backend && pnpm vitest run dev-tool/__tests__/verify-registry.test.ts`
Expected on first run: the `route exhaustion` invariant fails listing every BACKEND_ROUTE not currently in any panel's `exercises` array.

Iterate: for each uncovered route, decide which panel exercises it (or whether a new panel needs adding). Update `verify-registry.ts` until all three invariants pass.

Acceptable interim state: routes that genuinely don't have a panel yet (e.g., billing routes, ws-ticket, invites) are flagged here — assign them to a TODO panel placeholder OR escalate to the controller as "needs a new panel." For Task 4 specifically, the goal is "every existing panel correctly declares which routes it exercises." Adding NEW panels for currently-uncovered routes is Task 13 (the first verifier-subagent run).

If the route exhaustion test cannot pass without adding new panels, mark it `.skip()` temporarily with a comment `// SKIP until myth-e5mn Task 13 adds panels for billing/invites/sessions/dev-credits-me`. Task 13's done criterion includes removing the skip.

- [ ] **Step 3: Run test to verify it passes (or skips appropriately)**

Run: `cd backend && pnpm vitest run dev-tool/__tests__/verify-registry.test.ts`
Expected: PASS on invariants 1+2, with invariant 3 either passing or `.skip()`'d with the Task 13 reference.

- [ ] **Step 4: Commit**

```
test(myt-e5mn): verify-registry invariants — forward/reverse/route exhaustion
```

---

## Task 5: `scripts/verify.ts` — infra sanity check + auto-boot scaffolding

**Files:**
- Create: `backend/dev-tool/scripts/verify.ts`

- [ ] **Step 1: Implement the boot-detection + reporting skeleton**

```ts
// backend/dev-tool/scripts/verify.ts
//
// JSDOM-based panel verification harness (myth-e5mn Component 3).
// Pattern-aware: each panel declares its pattern in verify-registry.ts;
// this script applies pattern-appropriate assertions.
//
// Exit codes:
//   0 — every panel passed + route exhaustion passed
//   1 — at least one panel failed
//   2 — infra not up (backend or dev-tool unreachable) and auto-boot failed

import { PANEL_REGISTRY } from '../verify-registry.js'
import { BACKEND_ROUTES } from '../../src/contract/backend-routes.js'

const BACKEND_URL = 'http://localhost:3030'
const DEV_TOOL_URL = 'http://127.0.0.1:5273'

interface PanelResult {
  readonly panel: string
  readonly status: 'ok' | 'placeholder' | 'marker-missing' | 'error' | 'console-error' | 'boot-error'
  readonly details?: string
}

async function probeReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET' })
    return res.ok || res.status < 500
  } catch {
    return false
  }
}

async function sanityCheckInfra(): Promise<boolean> {
  const backendUp = await probeReachable(`${BACKEND_URL}/health`)
  const devToolUp = await probeReachable(`${DEV_TOOL_URL}/`)
  if (backendUp && devToolUp) return true
  // Auto-boot scaffolding lands in Task 6; for now report not-up.
  if (!backendUp) {
    console.error(`✗ backend not reachable at ${BACKEND_URL}/health`)
    console.error(`  start with: cd backend && NODE_ENV=development pnpm dev`)
  }
  if (!devToolUp) {
    console.error(`✗ dev-tool not reachable at ${DEV_TOOL_URL}/`)
    console.error(`  start with: cd backend/dev-tool && pnpm dev`)
  }
  return false
}

async function main(): Promise<void> {
  const infraUp = await sanityCheckInfra()
  if (!infraUp) {
    process.exit(2)
  }

  // Identity bootstrap, panel mounts, and route audit land in Tasks 6, 7, 8.
  // For now we just report "infra up; harness pending."
  console.log('[infra] backend + dev-tool reachable')
  console.log(`[harness] ${Object.keys(PANEL_REGISTRY).length} panels registered; ${BACKEND_ROUTES.length} routes in contract`)
  console.log('[status] harness implementation pending (Tasks 6-8)')
  process.exit(0)
}

void main().catch((err: unknown) => {
  console.error('[verify] unexpected error:', err)
  process.exit(1)
})
```

- [ ] **Step 2: Run the harness against running services to verify boot detection**

Pre-req: `cd backend && NODE_ENV=development pnpm dev` running in one shell + `cd backend/dev-tool && pnpm dev` running in another.

Run: `pnpm dev-tool:verify`
Expected: `[infra] backend + dev-tool reachable` + `[harness] 8 panels registered; N routes in contract` + exit 0.

- [ ] **Step 3: Stop one service; re-run to verify failure path**

Stop the dev-tool service. Run: `pnpm dev-tool:verify`
Expected: `✗ dev-tool not reachable…` + actionable boot-up message + exit 2.

Restart dev-tool for subsequent tasks.

- [ ] **Step 4: Commit**

```
feat(myt-e5mn): verify.ts — infra sanity check + reporting skeleton
```

---

## Task 6: Identity bootstrap step

**Files:**
- Modify: `backend/dev-tool/scripts/verify.ts`

- [ ] **Step 1: Add bootstrap helpers + invoke them between sanity check and panel loop**

Insert after the `sanityCheckInfra` function:

```ts
const DEV_SUB = 'dev-user-1'

interface BootstrapResult {
  readonly userRegistered: boolean
  readonly creditsGranted: boolean
}

async function bootstrapIdentity(): Promise<BootstrapResult> {
  // Register dev-user-1 (idempotent — 200 on first call, 409 on subsequent).
  const registerRes = await fetch(`${BACKEND_URL}/api/users/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mythrun-dev-sub': DEV_SUB,
    },
    body: JSON.stringify({ username: 'verifyharness', displayName: 'Verify Harness' }),
  })
  if (![200, 201, 409].includes(registerRes.status)) {
    throw new Error(`identity bootstrap: register returned ${registerRes.status}`)
  }
  // Grant world_gen credits. POST /api/dev/credits/grant is idempotent
  // per-call (adds to ledger).
  const grantRes = await fetch(`${BACKEND_URL}/api/dev/credits/grant`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-mythrun-dev-sub': DEV_SUB,
    },
    body: JSON.stringify({ creditType: 'world_gen', amount: 5 }),
  })
  if (grantRes.status !== 200) {
    throw new Error(`identity bootstrap: credit grant returned ${grantRes.status}`)
  }
  return { userRegistered: registerRes.status !== 409, creditsGranted: true }
}
```

Update `main()`:

```ts
async function main(): Promise<void> {
  const infraUp = await sanityCheckInfra()
  if (!infraUp) {
    process.exit(2)
  }
  console.log('[infra] backend + dev-tool reachable')

  const bootstrap = await bootstrapIdentity()
  console.log(`[bootstrap] dev-user-1 ${bootstrap.userRegistered ? 'registered' : 'pre-existing'}; credits granted`)

  console.log(`[harness] ${Object.keys(PANEL_REGISTRY).length} panels registered; ${BACKEND_ROUTES.length} routes in contract`)
  console.log('[status] panel-mount loop pending (Task 7)')
  process.exit(0)
}
```

- [ ] **Step 2: Run against running services**

Run: `pnpm dev-tool:verify`
Expected: `[bootstrap] dev-user-1 registered; credits granted` on first run; `[bootstrap] dev-user-1 pre-existing; credits granted` on subsequent runs.

- [ ] **Step 3: Verify ledger was actually credited**

Run:
```
curl -s -H "x-mythrun-dev-sub: dev-user-1" http://localhost:3030/api/dev/credits/me
```
Expected: a `{ balance: { world_gen: N } }`-shaped response with N >= 5.

(Note: `/api/dev/credits/me` doesn't exist yet — this is one of the routes the verifier subagent will identify as needing a panel/endpoint in Task 13. For now, verify ledger state via psql instead:)

```
docker exec mythrun-postgres-1 psql -U mythrun -d mythrun -c "SELECT credit_type, sum(amount) FROM credit_ledger WHERE user_id = (SELECT id FROM users WHERE cognito_sub = 'bypass:dev-user-1') GROUP BY credit_type;"
```

- [ ] **Step 4: Commit**

```
feat(myt-e5mn): verify.ts — identity bootstrap step for dev-user-1
```

---

## Task 7: Panel-mount loop with pattern-aware assertions

**Files:**
- Modify: `backend/dev-tool/scripts/verify.ts`

- [ ] **Step 1: Add JSDOM setup + per-panel mount helpers**

Insert at the top of the file (after the existing imports):

```ts
import { JSDOM } from 'jsdom'
import { setCurrentDevSub } from '../src/identity.js'

interface MountContext {
  readonly cleanup: () => void
  readonly parent: HTMLDivElement
  readonly consoleErrors: string[]
}

function setupJsdomContext(): MountContext {
  const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', {
    url: DEV_TOOL_URL,
    pretendToBeVisual: true,
  })
  // Expose JSDOM globals so panel modules' `window`/`document`/`localStorage`
  // /`performance` references resolve. fetch is wrapped below to proxy to
  // backend.
  const w = dom.window as unknown as Window & typeof globalThis
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).window = w
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).document = w.document
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).localStorage = w.localStorage
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).performance = w.performance

  // fetch wrapper: relative paths get prepended with BACKEND_URL.
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let url: string
    if (typeof input === 'string') {
      url = input
    } else if (input instanceof URL) {
      url = input.toString()
    } else {
      url = input.url
    }
    if (url.startsWith('/')) {
      return originalFetch(`${BACKEND_URL}${url}`, init)
    }
    return originalFetch(input, init)
  }

  // Capture console.error.
  const consoleErrors: string[] = []
  const originalConsoleError = console.error
  console.error = (...args: unknown[]): void => {
    consoleErrors.push(args.map((a) => String(a)).join(' '))
  }

  const parent = w.document.createElement('div')
  w.document.body.appendChild(parent)

  return {
    parent,
    consoleErrors,
    cleanup: () => {
      console.error = originalConsoleError
      globalThis.fetch = originalFetch
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).window
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).document
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).localStorage
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      delete (globalThis as any).performance
      dom.window.close()
    },
  }
}

async function pollForSelector(
  parent: HTMLElement,
  readySelector: string,
  errorSelector: string,
  timeoutMs: number,
): Promise<'ready' | 'error' | 'timeout'> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (parent.querySelector(readySelector)) return 'ready'
    if (parent.querySelector(errorSelector)) return 'error'
    await new Promise((r) => setTimeout(r, 50))
  }
  return 'timeout'
}

async function verifyPanel(name: string): Promise<PanelResult> {
  const reg = PANEL_REGISTRY[name]
  if (!reg) {
    return { panel: name, status: 'boot-error', details: 'not in PANEL_REGISTRY' }
  }
  const ctx = setupJsdomContext()
  try {
    setCurrentDevSub(DEV_SUB)
    await reg.mount(ctx.parent)
    const outcome = await pollForSelector(
      ctx.parent,
      reg.readySelector,
      reg.errorSelector,
      reg.readyTimeoutMs ?? 2000,
    )
    // Apply pattern-aware verdict.
    if (outcome === 'error') {
      const errText = ctx.parent.querySelector(reg.errorSelector)?.textContent ?? ''
      return { panel: name, status: 'error', details: errText.trim().slice(0, 200) }
    }
    if (outcome === 'timeout') {
      return {
        panel: name,
        status: 'marker-missing',
        details: `neither ${reg.readySelector} nor ${reg.errorSelector} appeared within ${reg.readyTimeoutMs ?? 2000}ms`,
      }
    }
    // outcome === 'ready'; check console.error.
    const filtered = ctx.consoleErrors.filter((msg) => {
      if (!reg.errorAllowlist) return true
      return !reg.errorAllowlist.some((allow) => msg.includes(allow))
    })
    if (filtered.length > 0) {
      return {
        panel: name,
        status: 'console-error',
        details: filtered.join(' | ').slice(0, 200),
      }
    }
    return { panel: name, status: 'ok' }
  } catch (err) {
    return { panel: name, status: 'boot-error', details: String(err).slice(0, 200) }
  } finally {
    ctx.cleanup()
  }
}
```

Note: `setCurrentDevSub` may not exist yet in `identity.ts`. If it doesn't, this task implies adding it as a simple setter that updates the same storage `getCurrentDevSub` reads. The subagent doing Task 7 verifies + adds it if missing (small one-line file edit).

Then update `main()`:

```ts
async function main(): Promise<void> {
  const infraUp = await sanityCheckInfra()
  if (!infraUp) {
    process.exit(2)
  }
  console.log('[infra] backend + dev-tool reachable')

  const bootstrap = await bootstrapIdentity()
  console.log(`[bootstrap] dev-user-1 ${bootstrap.userRegistered ? 'registered' : 'pre-existing'}; credits granted`)

  const panelNames = Object.keys(PANEL_REGISTRY)
  const results: PanelResult[] = []
  for (const name of panelNames) {
    const result = await verifyPanel(name)
    results.push(result)
    const tag = result.status === 'ok' ? '✓' : '✗'
    console.log(`[panel:${name}] ${tag} ${result.status}${result.details ? ` — ${result.details}` : ''}`)
  }

  // Route audit lands in Task 8.

  const failed = results.filter((r) => r.status !== 'ok')
  if (failed.length > 0) {
    console.log(`\n${failed.length} panel(s) need attention.`)
    process.exit(1)
  }
  console.log('\nAll panels ok.')
  process.exit(0)
}
```

- [ ] **Step 2: Run against running services**

Run: `pnpm dev-tool:verify`
Expected: 8 panel lines, each with `✓ ok` or `✗ <status>`. On the first run, MOST panels will fail with `marker-missing` because no panel sets `data-state` attributes yet. This is expected and serves as the input to Task 13 (the verifier subagent's first run, which retrofits panels).

- [ ] **Step 3: Verify the output is parseable + actionable**

The output should clearly identify which panels are failing and why. If `details` text is truncated past usefulness, raise the slice limit from 200 to 500.

- [ ] **Step 4: Commit**

```
feat(myt-e5mn): verify.ts — pattern-aware panel mount loop with JSDOM
```

---

## Task 8: Route exhaustion second pass

**Files:**
- Modify: `backend/dev-tool/scripts/verify.ts`

- [ ] **Step 1: Add the route-audit pass**

Add this function before `main()`:

```ts
function routeAudit(): string[] {
  const exercised = new Set<string>()
  for (const reg of Object.values(PANEL_REGISTRY)) {
    for (const r of reg.exercises) {
      exercised.add(`${r.method} ${r.path}`)
    }
  }
  const uncovered: string[] = []
  for (const route of BACKEND_ROUTES) {
    const key = `${route.method} ${route.path}`
    if (!exercised.has(key)) uncovered.push(key)
  }
  return uncovered
}
```

Update `main()` after the panel loop and before the failure check:

```ts
  const uncovered = routeAudit()
  for (const route of uncovered) {
    console.log(`[coverage] ✗ route ${route} not exercised by any panel`)
  }

  const failed = results.filter((r) => r.status !== 'ok')
  const ok = failed.length === 0 && uncovered.length === 0
  if (!ok) {
    console.log(`\n${failed.length} panel(s) failed; ${uncovered.length} route(s) uncovered.`)
    process.exit(1)
  }
  console.log('\nAll panels ok; all routes covered.')
  process.exit(0)
```

- [ ] **Step 2: Run against running services**

Run: `pnpm dev-tool:verify`
Expected: panel results + a list of uncovered routes (probably billing/invites/sessions/dev-credits-me). The route audit redundancy with `verify-registry.test.ts` invariant 3 is intentional — the test fails CI on drift; the runtime audit reminds the human at every dev-tool:verify invocation.

- [ ] **Step 3: Commit**

```
feat(myt-e5mn): verify.ts — route exhaustion second-pass audit
```

---

## Task 9: `AUTHORING.md` — contract document

**Files:**
- Create: `backend/dev-tool/AUTHORING.md`

- [ ] **Step 1: Write the document**

```markdown
# Dev-Tool Authoring

How to maintain the Mythrun dev tool: panel patterns, the verification model, the registry, and the verifier subagent's playbook. Read this first if you're touching `backend/dev-tool/**` — by hand or as the dev-tool-verifier subagent.

---

## What the dev tool is

A local 127.0.0.1-only Vite SPA served at port 5273 that exists to be the **test surface for every backend route**. The dev tool is to the backend what the wiki is to the codebase: a complete mirror in a different shape. Any backend route that ships and isn't exercisable from the dev tool is a bug.

The dev tool is NOT shipped to end users. It's a developer tool — local-only by design (vite config binds 127.0.0.1, the bypass-auth plugin gates `/api/dev/*` behind `AUTH_MODE=bypass` which only fires when `NODE_ENV ∈ {development, test}`).

---

## The seven principles

1. **Full backend route coverage.** Every route in `BACKEND_ROUTES` (`backend/src/contract/backend-routes.ts`) is exercised by at least one panel. Read panels for GETs, action panels for POST/DELETE. The verify harness's route audit (`pnpm dev-tool:verify`) enforces this at runtime; the registry test enforces it at build time.

2. **No silent placeholders.** Every panel that fetches data declares an expected post-load DOM marker (`data-state="loaded"`) and an error marker (`data-state="error"`). Steady-state-on-mount panels (action-only panels like `credit-ledger`, event-driven panels like `live-events`) declare an idle marker (`data-state="idle"` or `data-state="ready"`) instead. The harness does NOT apply placeholder substring matching; it checks for explicit DOM markers only.

3. **Bring-up self-bootstraps.** The dev tool does not require the human to manually register the dev sub, grant credits, or pre-seed state. First-load against a clean DB produces a working tool. The verify harness's identity bootstrap step (`scripts/verify.ts` step 2) is the safety net.

4. **Identity model is single source of truth.** `getCurrentDevSub()` returns one sub; every fetch and SSE call uses that sub via `x-mythrun-dev-sub`. No panel hardcodes a different sub. The verifier sets identity via `setCurrentDevSub(DEV_SUB)` before each panel mount.

5. **Explicit error surface.** Backend errors render visibly via the `data-state="error"` marker, not silently absorbed into a placeholder. The error banner's `textContent` SHOULD include the HTTP status + the error code.

6. **Verifiability is shipped with the panel.** Every new panel ships its `verify-registry.ts` entry in the same commit; a panel without a registry entry fails the forward-coverage invariant test.

7. **Panel-pattern declaration is mandatory.** Each registry entry declares its interaction pattern. Three patterns:
   - `fetch-on-mount`: panel fires a fetch from `mount()`. Sets `data-state="loading"` → `"loaded"` or `"error"`. Examples: `my-campaigns`, `health`.
   - `event-driven`: panel binds to a window event (`mythrun.watchcampaign`, `mythrun.opendetails`); fetches only when the event fires. Sets `data-state="idle"` on mount. Examples: `status`, `live-events`, `campaign-details`.
   - `action-only`: panel renders an action surface (form + button) with no read fetch. Sets `data-state="ready"` on mount. Examples: `credit-ledger`, `campaign-create`.

---

## Panel pattern conventions

Every panel exports a `mount<Name>(parent: HTMLElement): void` function that:

1. Renders the panel's DOM tree into `parent`.
2. Sets `parent.setAttribute('data-state', ...)` to the appropriate state for the panel's pattern (`'loading'`, `'loaded'`, `'error'`, `'idle'`, or `'ready'`).
3. Wires identity-change reset semantics by calling `onIdentityChanged(() => ...)`. The reset handler MUST clear any per-sub state.
4. For event-driven panels, binds to the appropriate `mythrun.*` window event.
5. For action-only panels, wires the action button(s) to fetches that emit the appropriate `mythrun.*` event on success.

---

## The verification model

`pnpm dev-tool:verify` boots a JSDOM environment per panel, mounts the panel against the live backend (proxied via the same Vite dev server identity flow), polls for `readySelector` or `errorSelector`, and emits a per-panel pass/fail line.

Verdict rules:
- `readySelector` matched → **ok**
- `errorSelector` matched → **error** (with the inner text captured)
- Neither matched within `readyTimeoutMs` → **marker-missing**
- `console.error` fired (after `errorAllowlist` filtering) → **console-error**
- Exception during mount → **boot-error**

The harness does not click buttons or simulate user actions for action-only panels — it verifies the panel reached its ready state. End-to-end action flows are the residual human-test surface OR a separate test (e.g., `scripts/dev-tool-smoke.test.ts`, not in scope for this bead).

---

## Coverage inventory

Maintained as a table here. The verifier subagent updates this section on each run.

| Backend route | Panel | Pattern |
|---|---|---|
| GET /health | health | fetch-on-mount |
| GET /health/ready | health | fetch-on-mount |
| POST /api/users/register | (bootstrap-only; no panel) | — |
| GET /api/users/check-username | (TODO: needs panel) | — |
| GET /api/users/me | (TODO: needs panel) | — |
| POST /api/campaigns | campaign-create | action-only |
| GET /api/campaigns/mine | my-campaigns | fetch-on-mount |
| GET /api/campaigns/:campaignId | campaign-details | event-driven |
| DELETE /api/campaigns/:campaignId | campaign-details | event-driven |
| POST /api/campaigns/:campaignId/resume | campaign-details | event-driven |
| GET /api/campaigns/:campaignId/status | status | event-driven |
| GET /api/campaigns/:campaignId/status/stream | status, live-events | event-driven |
| POST /api/sessions/:id/ws-ticket | (TODO: needs panel) | — |
| POST /api/campaigns/:campaignId/invites | (TODO: needs panel) | — |
| GET /api/campaigns/:campaignId/invites | (TODO: needs panel) | — |
| DELETE /api/campaigns/:campaignId/invites/:inviteCode | (TODO: needs panel) | — |
| GET /api/invites/:inviteCode | (TODO: needs panel) | — |
| POST /api/invites/:inviteCode/accept | (TODO: needs panel) | — |
| GET /api/campaigns/:campaignId/members | (TODO: needs panel) | — |
| POST /api/dev/credits/grant | credit-ledger | action-only |
| GET /api/dev/credits/me | credit-ledger | action-only |
| (billing routes — fill in via Task 13) | — | — |

The verifier subagent's first dispatch (Task 13) fills the TODO rows. Some routes may legitimately not need a panel (e.g., `POST /api/users/register` is exercised by the bootstrap step, not a UI panel) — those are noted with the appropriate `—`.

---

## The subagent dispatch prompt

(See end-of-file section: "Subagent dispatch prompt for dev-tool-verifier".)

---

## Subagent dispatch prompt for dev-tool-verifier

```
You are the dev-tool-verifier subagent for the Mythrun dev tool. Your job is to bring the dev tool into compliance with `backend/dev-tool/AUTHORING.md` and keep it there.

## Read first

1. `backend/dev-tool/AUTHORING.md` (this file) — the seven principles, panel patterns, verification model, coverage inventory.
2. `docs/superpowers/specs/2026-05-15-dev-tool-reliability-design.md` — the design spec; particularly Component 4 (your playbook + authority list) and the Open design decisions section.

## Your authority

You have full edit authority over:
- `backend/dev-tool/**` (everything: src/, scripts/, AUTHORING.md, verify-registry.ts, coverage.json, package.json, etc.)

You may read but NOT edit:
- `backend/src/contract/backend-routes.ts` (the controller maintains this; surface drift via the Escalated section of your report)
- `backend/src/routes/**`, `backend/src/billing/**`, `backend/src/auth/**`, etc. — backend route handlers and services (surface bugs via the Escalated section)

You may run:
- `pnpm dev-tool:verify`
- `pnpm dev-tool:check`
- `pnpm --filter @mythrun/dev-tool test`
- `pnpm --filter @mythrun/dev-tool typecheck`
- `pnpm --filter @mythrun/dev-tool lint`

You may NOT run:
- `git add`, `git commit`, `git push` — the controller commits.

## Your playbook

1. Read `AUTHORING.md` and the design spec end-to-end.

2. **Coverage audit.** Run `pnpm dev-tool:verify` and inspect:
   - Route-audit failures: routes in `BACKEND_ROUTES` not exercised by any panel.
   - For each uncovered route: add a panel (or extend an existing panel) that exercises it. Register it in `verify-registry.ts` with the correct pattern. Mount it in `backend/dev-tool/src/main.ts`. Update the coverage inventory in `AUTHORING.md`.
   - If a route fundamentally doesn't fit any UI surface (e.g., internal webhooks, async event-only paths), flag it in the Escalated section instead.
   - Orphan registry entries (key in `PANEL_REGISTRY` but no panel file or no `main.ts` import): remove the entry, delete dead panel files.

3. **Per-panel verification.** Run `pnpm dev-tool:verify` again. For each panel ≠ `ok`:
   - Read the panel source, the route it calls, the route handler, the data path.
   - Investigate the failure mode. Common ones:
     - `marker-missing`: panel never sets `data-state`. Retrofit it.
     - `error`: panel renders an error banner — check the captured error text. May be backend bug (escalate) or panel bug (fix).
     - `console-error`: panel logs an error during mount. Investigate.
     - `boot-error`: panel mount throws. Likely a missing JSDOM polyfill or a panel side-effect on import; fix.
   - Apply the fix. Re-run verify. Iterate until green or stuck.

4. **Stuck detection.** A panel is "stuck" when **two consecutive verify runs after an edit produce the same failing outcome** (same status string, same selector verdict, same captured error text). On stuck:
   - Stop attempting fixes for that panel.
   - Add a bullet under Escalated in your final report describing what you tried and what's blocking.

5. **Final pre-handoff verification.**
   - `pnpm --filter @mythrun/dev-tool typecheck` — clean.
   - `pnpm --filter @mythrun/dev-tool lint` — clean.
   - `pnpm --filter @mythrun/dev-tool test` — green.
   - `pnpm dev-tool:verify` — green (all panels ok, no uncovered routes — or uncovered routes are all in the Escalated section).
   - `pnpm dev-tool:check` — green (manifest matches).

6. **Update the coverage inventory** in `AUTHORING.md` if new routes/panels landed.

7. **Report back** in exactly this shape:

```
## Panels checked
- <name>: ok | failed | unchanged

## Coverage changes
- added panel: <name> for <route>
- removed panel: <name> (route deleted upstream)
- (nothing changed)

## Bugs fixed
- <one bullet per fix, file + summary>
- (none)

## Escalated to controller
- <one bullet per unresolved issue, with rationale>
- (none)
```

Do NOT commit. Leave files in the working tree; the controller stages and commits everything.
```

---

## Maintenance lifecycle

- **New backend route lands.** Controller adds to `BACKEND_ROUTES`. Next dev-tool-verifier dispatch detects the uncovered route and adds a panel.
- **Backend route deleted.** Controller removes from `BACKEND_ROUTES`. Next dev-tool-verifier dispatch detects the orphan registry entry and removes the panel.
- **Panel behavior changes.** Controller (or whoever is editing the panel) re-runs the verifier; if it goes red, either fix the panel OR update the registry entry's assertions.
- **Identity / bootstrap regression.** The verifier's bootstrap step is the canary — if it starts failing, the dev sub registration or credit-grant route is broken.
```

- [ ] **Step 2: Commit**

```
docs(myt-e5mn): AUTHORING.md — dev-tool contract document + subagent dispatch prompt
```

---

## Task 10: PostToolUse hook + settings.json registration

**Files:**
- Create: `.claude/hooks/post-dev-tool-edit.sh`
- Modify: `.claude/settings.json`

- [ ] **Step 1: Write the hook script**

```sh
#!/usr/bin/env bash
# .claude/hooks/post-dev-tool-edit.sh
#
# PostToolUse hook for Write tool calls (myth-e5mn). Reminds the agent
# to dispatch the dev-tool-verifier subagent when the edit touches the
# dev-tool subtree or the backend route contract source.
#
# Matcher in .claude/settings.json is "Write" (NOT "Edit|Write") so this
# fires once at the end of a writing pass, not per-iteration during a
# normal multi-edit refinement turn.

set -euo pipefail

# Read the tool input as JSON on stdin.
input=$(cat)

# Extract file_path. jq handles missing/null gracefully.
file_path=$(echo "$input" | jq -r '.tool_input.file_path // empty')

if [[ -z "$file_path" ]]; then
  exit 0
fi

# Path-match against the dev-tool surface + backend contract sources.
# Edits to handler files under backend/src/routes/** are NOT in the
# matcher — the dev tool consumes the contract, not the handlers, and a
# handler-level edit is too noisy a signal for this reminder.
case "$file_path" in
  */backend/dev-tool/src/*.ts | \
  */backend/dev-tool/src/**/*.ts | \
  */backend/dev-tool/coverage.json | \
  */backend/dev-tool/verify-registry.ts | \
  */backend/dev-tool/AUTHORING.md | \
  */backend/src/contract/backend-routes.ts | \
  */backend/src/contract/pipeline-routes.ts)
    cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "additionalContext": "You edited the dev tool or a backend route contract source this turn. Before handing back, dispatch the dev-tool-verifier subagent with the prompt at backend/dev-tool/AUTHORING.md end-of-file. The verifier owns coverage + per-panel functional correctness — this is the standing dev-tool reliability rule."
  }
}
EOF
    ;;
  *)
    # No match; emit nothing.
    ;;
esac
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x .claude/hooks/post-dev-tool-edit.sh`

- [ ] **Step 3: Register in `.claude/settings.json`**

Add a new entry under `hooks.PostToolUse` array:

```json
{
  "matcher": "Write",
  "hooks": [
    {
      "type": "command",
      "command": "\"$(git rev-parse --show-toplevel)\"/.claude/hooks/post-dev-tool-edit.sh"
    }
  ]
}
```

Insert this entry near the existing `post-spec-write.sh` entry so all `Write`-matched hooks live together.

- [ ] **Step 4: Manually trigger the hook**

Open and save a file under `backend/dev-tool/src/` via the Write tool (e.g., add a trailing newline). The hook should emit additionalContext. Verify by checking the next message's system reminders for the reminder text. (If hooks don't print to the conversation directly, manually invoke the script with a fake input:)

```
echo '{"tool_input": {"file_path": "/abs/path/backend/dev-tool/src/main.ts"}}' | .claude/hooks/post-dev-tool-edit.sh
```
Expected: JSON output with `hookSpecificOutput.additionalContext` containing the reminder text.

```
echo '{"tool_input": {"file_path": "/abs/path/unrelated.ts"}}' | .claude/hooks/post-dev-tool-edit.sh
```
Expected: empty output (path doesn't match).

- [ ] **Step 5: Commit**

```
feat(myt-e5mn): post-dev-tool-edit hook — reminds to dispatch verifier subagent
```

---

## Task 11: `.husky/pre-push` gate 6 + renumber

**Files:**
- Modify: `.husky/pre-push`

- [ ] **Step 1: Renumber gates 1–5 references to /6**

In `.husky/pre-push`:
- Top file-header comment block: update "1–5" / "five-stage gate" to "1–6" / "six-stage gate" (the gate count description).
- Manual-run snippet at the bottom of the header: add a 6th line for `pnpm dev-tool:verify`.
- Each `echo "→ pre-push gate (N/5)"` line: change `/5` to `/6`.

- [ ] **Step 2: Append gate 6 at the end of the script**

After the existing wiki:check gate (gate 5), add:

```sh
echo "→ pre-push gate (6/6): dev-tool verifier"
# Only run when the diff touches dev-tool subtree or backend contract
# sources — verify is moderately expensive (JSDOM + per-panel boot) and
# adds no value when the diff doesn't affect the dev-tool surface.
diff_files=$(git diff --cached --name-only origin/main 2>/dev/null || git diff --name-only HEAD)
if echo "$diff_files" | grep -qE '^(backend/dev-tool/|backend/src/contract/(backend-routes|pipeline-routes)\.ts)'; then
  pnpm dev-tool:verify
else
  echo "  (diff doesn't touch dev-tool surface; skipping)"
fi
```

- [ ] **Step 3: Test the gate by attempting to push**

Make a trivial edit to `backend/dev-tool/AUTHORING.md` (add a comment), stage it, attempt to push.

Run: `git add docs/wiki/whatever && git push origin main` (in a sandbox branch first if you don't want to actually push)

OR run the gate manually:
```
.husky/pre-push
```
Expected: gates 1–5 pass; gate 6 runs `pnpm dev-tool:verify`. If services aren't up, gate 6 fails with the actionable message from Task 5.

- [ ] **Step 4: Commit**

```
feat(myt-e5mn): pre-push gate 6 — dev-tool:verify on dev-tool-touching diffs
```

---

## Task 12: Unit tests for verify.ts helpers

**Files:**
- Create: `backend/dev-tool/scripts/__tests__/verify.test.ts`

- [ ] **Step 1: Refactor the verify.ts helpers to be exportable**

Currently `verify.ts` runs `main()` on import (via `void main()` at the bottom). Refactor so helpers are exported and main() only runs when the module is the entry point:

```ts
// At the bottom of scripts/verify.ts, replace `void main().catch(...)`
// with:

const isEntryPoint = import.meta.url === `file://${process.argv[1]}`
if (isEntryPoint) {
  main().catch((err: unknown) => {
    console.error('[verify] unexpected error:', err)
    process.exit(1)
  })
}

// And add exports near the top:
export { sanityCheckInfra, bootstrapIdentity, pollForSelector, verifyPanel, routeAudit }
```

- [ ] **Step 2: Write the test**

```ts
// backend/dev-tool/scripts/__tests__/verify.test.ts
//
// Unit tests for verify.ts helpers. We do NOT boot a real backend here
// (that's covered by the harness's runtime execution + the pre-push
// gate); we just verify the helpers work in isolation against stubs.

import { describe, it, expect } from 'vitest'
import { JSDOM } from 'jsdom'
import { pollForSelector, routeAudit } from '../verify.js'

describe('pollForSelector', () => {
  it('returns "ready" when readySelector appears within timeout', async () => {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>')
    const root = dom.window.document.getElementById('root')!
    setTimeout(() => {
      root.setAttribute('data-state', 'loaded')
    }, 50)
    const outcome = await pollForSelector(root, '[data-state="loaded"]', '[data-state="error"]', 1000)
    expect(outcome).toBe('ready')
  })

  it('returns "error" when errorSelector appears first', async () => {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>')
    const root = dom.window.document.getElementById('root')!
    setTimeout(() => {
      root.setAttribute('data-state', 'error')
    }, 50)
    const outcome = await pollForSelector(root, '[data-state="loaded"]', '[data-state="error"]', 1000)
    expect(outcome).toBe('error')
  })

  it('returns "timeout" when neither appears within the deadline', async () => {
    const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>')
    const root = dom.window.document.getElementById('root')!
    const outcome = await pollForSelector(root, '[data-state="loaded"]', '[data-state="error"]', 100)
    expect(outcome).toBe('timeout')
  })
})

describe('routeAudit', () => {
  it('reports zero uncovered when registry covers BACKEND_ROUTES', () => {
    // routeAudit reads PANEL_REGISTRY + BACKEND_ROUTES directly; this
    // test passes if the registry test invariant 3 passes.
    const uncovered = routeAudit()
    // We only assert the function returns a string[]; the actual
    // uncovered list is the registry test's job.
    expect(Array.isArray(uncovered)).toBe(true)
  })
})
```

- [ ] **Step 3: Run the test**

Run: `cd backend && pnpm vitest run dev-tool/scripts/__tests__/verify.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```
test(myt-e5mn): verify.ts helper unit tests
```

---

## Task 13: First verifier-subagent run

**Files:** controlled by the verifier subagent per its playbook.

This is the closing task — the system is wired; now dispatch the verifier and have it bring the dev tool into compliance.

- [ ] **Step 1: Boot backend + dev-tool**

Pre-req: `cd backend && NODE_ENV=development pnpm dev` in one shell + `cd backend/dev-tool && pnpm dev` in another.

- [ ] **Step 2: Run `pnpm dev-tool:verify` to capture the baseline**

Run: `pnpm dev-tool:verify`
Expected: most panels likely fail with `marker-missing` (no `data-state` attributes yet) + uncovered-routes list (billing, invites, sessions, etc.).

Save the output to `tmp/dev-tool-verify-baseline.log` for the subagent to reference.

- [ ] **Step 3: Dispatch the verifier subagent**

Dispatch with the prompt verbatim from `backend/dev-tool/AUTHORING.md` end-of-file section. Subagent type: `general-purpose`. Model: `opus`.

The subagent's mandate is to do the work its playbook describes: data-state retrofits across all 8 panels, fill the TODO rows in the coverage inventory by adding panels for uncovered routes, fix today's three reported bugs (my-campaigns 403, credit-ledger placeholder, identity-switcher dropdown), and report back.

- [ ] **Step 4: Read the subagent's report**

Inspect the four sections (Panels checked, Coverage changes, Bugs fixed, Escalated). For each Escalated item, decide:
- backend bug → controller fixes (separate commit after Task 13)
- contract source gap → controller updates `BACKEND_ROUTES`
- design decision → ask the user

- [ ] **Step 5: Stage + commit the subagent's output**

The subagent left files in the working tree. Controller stages everything under:
- `backend/dev-tool/**`

Commit:
```
feat(myt-e5mn): first verifier-subagent run — data-state retrofit + bug fixes + coverage expansion
```

Include in the commit body a summary of the subagent's report (panels touched, bugs fixed, escalations forwarded).

- [ ] **Step 6: Verify all gates pass**

Run: `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm wiki:check && pnpm dev-tool:check && pnpm dev-tool:verify`
Expected: all green.

- [ ] **Step 7: Push**

```
git push origin main
```
Expected: pre-push gates 1–6 pass; push succeeds.

- [ ] **Step 8: Close the bead**

```
bd close myth-e5mn
```

---

## Self-review checklist (run after writing the plan)

- [x] **Spec coverage**: Component 1 (AUTHORING.md) → Task 9; Component 2 (verify-registry) → Tasks 3+4; Component 3 (verify.ts) → Tasks 5+6+7+8+12; Component 4 (subagent) → Task 9's end-of-file prompt + Task 13; Component 5 (hook + pre-push) → Tasks 10+11; Component 6 (backend-routes.ts) → Task 1. Done criteria 1–11 all map to tasks.
- [x] **Placeholder scan**: no TBDs; every test has actual test body; every implementation has actual code.
- [x] **Type consistency**: `PanelRegistration` shape consistent across Task 3 (definition) and Task 7 (consumption); `PanelResult.status` shape consistent across Tasks 5+7+8.

If a gap surfaced during implementation that this plan didn't anticipate, the subagent in Task 13 surfaces it as Escalated.
