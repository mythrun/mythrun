# MYT-83 — App Shell, Routing & Typed Data Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Mythrun web app skeleton — a shared `@mythrun/contract` package, a DOM-free `@mythrun/client-core` data layer (typed REST client + stores + platform interfaces + the i18n catalog), and a React-Router shell in `@mythrun/web` — proving a real backend call renders behind a loading state.

**Architecture:** Four packages, one-way deps `@mythrun/contract → client-core → ui → web`, with `contract` also consumed by `backend`. The "client brain" (api client, React-Query hooks, Zustand stores, platform *interfaces*, i18n catalog) lives in `client-core` (DOM-free); `web` holds only the router shell, thin screens, and the web *implementations* of those interfaces under `platform/web/**`. Conformance is structural: the only way to call the backend is `defineEndpoint`, whose `request`/`response` are Zod schemas from `@mythrun/contract`, and a lint forbids `react-query`/`fetch` inside `routes/`.

**Tech Stack:** TypeScript (strict), Zod 4, React 19, React Router, TanStack Query (peer-provided single instance), Zustand, i18next, Vitest + MSW + Testing Library, ESLint flat-config local rules.

## Global Constraints

- **Spec is source of truth:** `docs/superpowers/specs/2026-06-24-myt-83-app-shell-routing-typed-data-layer-design.md`. Every task's requirements implicitly include it.
- **TDD:** a failing test defines "done" before implementation, for every logic task.
- **No default exports** (root `no-restricted-syntax` bans `ExportDefaultDeclaration`); named exports only. Config files that must default-export are added to the relevant `ignores`.
- **No `any`, no non-null assertions, no unexplained type assertions** (strict + `strictTypeChecked`). `exactOptionalPropertyTypes: true` everywhere — optional props are conditionally spread, never passed as explicit `undefined`.
- **Functions < 50 lines, modules < 400 lines** (`max-lines-per-function` 100 warn, `max-lines` 400 warn).
- **No hardcoded UI strings** — every visible string is an i18n key; prose values are `"[placeholder for <purpose>]"`; only generic chrome (`"back"`) gets a real value.
- **No ad-hoc UI** — `routes/`/feature code composes `@mythrun/ui` only; **no ad-hoc color** — tokens only.
- **R1 (DOM-free brain):** `client-core` and `web` outside `platform/web/**` may not reference `document, window, localStorage, sessionStorage, location, navigator, EventSource` (`fetch`/`WebSocket` allowed). The web entry `src/main.tsx` is the one carve-out.
- **R5 (thin screens):** `routes/**` import only `@mythrun/client-core`, `@mythrun/ui`, and i18n — never `@tanstack/react-query`, `fetch`, Radix/CVA/`clsx`/`tailwind-merge`/`pixelarticons`, or deep `@mythrun/ui/src/*`.
- **Wire shape ≠ domain type:** backend `Date` fields serialize to ISO strings; contract response schemas model `z.string().datetime()`, never `z.date()`.
- **Zod version:** `^4.4.3` (match `backend`) — one validator, no fork.
- **Coverage:** new logic dirs (`client-core/src/api/**`, `src/stores/**`, `src/platform/**`) join the client-core tiered coverage gate at **100%** lines/branches/functions/statements. Presentational `.tsx` route/shell files are rendered-but-not-%-gated.
- **Subagent rules:** all implementer subagents are Opus; implementers do NOT `git add`/`commit`/`push` — the controller stages + commits each task serially after spec-compliance + code-quality review (Conventional Commits + `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`). HOLD all pushes until the full ticket is verified.

---

## File Structure (decomposition lock-in)

```
NEW PACKAGE — frontend/contract/  (@mythrun/contract — a BUILT package: tsc emits dist/*.js + *.d.ts)
  package.json              name, zod dep, build script, exports map → dist
  tsconfig.json             NodeNext-compatible emit (module NodeNext, declaration, outDir dist, rootDir src)
  eslint.config.js          minimal (Zod-only; NO api-purity scope)
  src/
    index.ts                barrel: re-export ./rest + ./events
    rest/users.ts           MeResponseSchema (public projection, ISO dates)
    rest/campaigns.ts       CampaignSummarySchema + MyCampaignsResponseSchema
    events/session-events.ts   (moved from backend/src/contract — TS unions, NOT Zod)
    events/pipeline-events.ts  (moved from backend/src/contract)
    __tests__/contract.test.ts

frontend/client-core/   (+ deps: zustand, @tanstack/react-query [peer+dev], i18next; +dev: jsdom, @testing-library/react)
  src/
    api/errors.ts           HttpError / ContractValidationError / NetworkError
    api/endpoint.ts         defineEndpoint primitive
    api/auth.ts             getAuthHeaders (dev x-mythrun-dev-sub | prod Bearer)
    api/client-context.tsx  ApiClientProvider + useApiConfig
    api/users.ts            getMe endpoint + useMe hook
    api/campaigns.ts        getMyCampaigns endpoint + useMyCampaigns hook
    stores/session.ts       Zustand 3-state session store
    platform/secure-storage.ts   SecureStorage interface
    i18n/                    catalog + resources/defaultNS + typed-keys augmentation (moved from web)
    __tests__/ + colocated *.test.ts(x)
  eslint.config.js          + no-restricted-globals (client-core scope)
  vitest.config.ts          + environment jsdom; coverage include += api/stores/platform

frontend/  (@mythrun/web; + deps: react-router-dom; +dev: msw)
  vite.config.ts            + resolve.dedupe(['react','react-dom','@tanstack/react-query'])
  src/
    main.tsx                mount the router (document use lint-exempt)
    app.tsx                 the shell composition (providers + router)
    app/providers.tsx       QueryClientProvider + ApiClientProvider + I18nextProvider + SessionProvider
    app/router.tsx          route tree (public/authed split)
    app/require-auth.tsx     RequireAuth (3-state gate)
    app/app-frame.tsx        the quiet brand frame (header + Outlet)
    app/not-found.tsx        dithered 404
    app/error-boundary.tsx   route error boundary (typed-error branching)
    routes/home.tsx          the WIRED home hub (useMyCampaigns)
    routes/*.tsx             stubs (landing, auth, join, recap, campaign-new, character-new, play, settings)
    platform/web/secure-storage.ts   localStorage impl
    i18n/config.ts           keep init + provider only (import resources from client-core)
    smoke/home-hub.smoke.ts  the real-backend wire smoke
  eslint.config.js          + no-restricted-globals (web outside platform/web + main.tsx carve-out) + routes/ boundary

backend/
  Dockerfile                COPY frontend/contract + build it before backend
  src/contract/session-events.ts, pipeline-events.ts   → re-export shims from @mythrun/contract
  src/routes/users.ts, campaigns.ts   type handler returns against the contract schemas

pnpm-workspace.yaml         + frontend/contract
```

---

## Dependency order (waves → beads)

```
W0a contract package scaffold  ─┬─→ W0b move event unions ──→ W0d Dockerfile + container smoke
                                └─→ W0c REST slice schemas ──┘
W0a ─→ W1a client-core deps+lint ─→ W1b errors+platform ─→ W1c defineEndpoint ─→ W1d session store ─→ W1e slice hooks(+MSW) ─→ W1f coverage wiring
W1a ─→ W2a i18n relocation
W1e, W2a ─→ W3a web deps+providers ─→ W3b platform/web impl + web globals lint ─→ W3c router+frame+404+RequireAuth ─→ W3d routes/ boundary lint ─→ W3e home hub + stubs
W3e ─→ W4a real-backend home-hub smoke
```

---

## Wave 0 — The `@mythrun/contract` package (the showstopper surface)

### Task W0a: Scaffold `@mythrun/contract` as a BUILT package

**Why first:** the backend (NodeNext, Docker `dist`) cannot consume raw `.ts`; both consumers must import a built package with an `exports` map. Everything downstream imports this.

**Files:**
- Create: `frontend/contract/package.json`, `frontend/contract/tsconfig.json`, `frontend/contract/eslint.config.js`, `frontend/contract/src/index.ts`, `frontend/contract/src/__tests__/contract.test.ts`
- Modify: `pnpm-workspace.yaml` (add `- 'frontend/contract'`)

**Interfaces:**
- Produces: package `@mythrun/contract` with `exports` `"."` → built `dist/index.js`+`.d.ts`; a `build` script (`tsc -p tsconfig.json`). Initially exports a trivial `export const CONTRACT_PACKAGE = 'mythrun-contract' as const` so the wiring is testable before content lands.

- [ ] **Step 1 — Write the failing wiring test.** `frontend/contract/src/__tests__/contract.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { CONTRACT_PACKAGE } from '../index.ts'

describe('@mythrun/contract', () => {
  it('exposes a stable package marker', () => {
    expect(CONTRACT_PACKAGE).toBe('mythrun-contract')
  })
})
```
- [ ] **Step 2 — Run it, watch it fail** (`pnpm --filter @mythrun/contract test` — fails: package/script not defined).
- [ ] **Step 3 — `frontend/contract/package.json`** (BUILT package; Zod pinned to backend's; emits dist):
```json
{
  "name": "@mythrun/contract",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
    "./rest": { "types": "./dist/rest/index.d.ts", "default": "./dist/rest/index.js" },
    "./events": { "types": "./dist/events/index.d.ts", "default": "./dist/events/index.js" }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "lint": "eslint . --no-error-on-unmatched-pattern",
    "test": "vitest run",
    "test:coverage": "vitest run --coverage"
  },
  "dependencies": { "zod": "^4.4.3" },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^3.0.0", "@vitest/coverage-v8": "^3.0.0", "eslint": "^9.0.0", "typescript-eslint": "^8.15.0" }
}
```
- [ ] **Step 4 — `frontend/contract/tsconfig.json`** (NodeNext **emit** — distinct from the frontend's noEmit/Bundler configs, because the backend consumes the built output):
```json
{
  "compilerOptions": {
    "module": "NodeNext", "moduleResolution": "NodeNext",
    "target": "ES2023", "lib": ["ES2023"],
    "declaration": true, "outDir": "dist", "rootDir": "src",
    "strict": true, "exactOptionalPropertyTypes": true, "noUncheckedIndexedAccess": true,
    "isolatedModules": true, "skipLibCheck": true, "verbatimModuleSyntax": true
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "src/**/__tests__/**"]
}
```
> NodeNext requires **extensioned relative imports inside this package** — `from './rest/index.js'` (not `.ts`), even though the source is `.ts`. This is the opposite of the Bundler packages; the implementer must use `.js` specifiers here.
- [ ] **Step 5 — `frontend/contract/src/index.ts`:** `export const CONTRACT_PACKAGE = 'mythrun-contract' as const`.
- [ ] **Step 6 — `frontend/contract/eslint.config.js`:** spread root config; no `mythrun-api`/`mythrun-ui` plugins; `ignores: ['dist/**','vitest.config.ts']`. (Minimal — this package has no UI/contract-prop concerns.)
- [ ] **Step 7 — Add `- 'frontend/contract'` to `pnpm-workspace.yaml`; run `pnpm install`.**
- [ ] **Step 8 — `pnpm --filter @mythrun/contract build` then `test`** — dist emitted, test passes.
- [ ] **Step 9 — Cross-consumer smoke:** add `import { CONTRACT_PACKAGE } from '@mythrun/contract'` to a scratch in BOTH a backend test and a client-core test (added properly in later tasks); for now verify `pnpm --filter @mythrun/contract build` produces `dist/index.js` + `dist/index.d.ts`. Commit.

> **Local-dev / CI ordering note (record in the task):** because consumers import the built `dist`, `pnpm --filter @mythrun/contract build` must run **before** any consumer's typecheck/test/dev/build. Wire it: add a repo-root `build:contract` convenience and call it in the pre-push gate ahead of the frontend+backend gates, and document `pnpm --filter @mythrun/contract build` as a one-time/`--watch` step before `pnpm dev`. (The pre-push hook edit is part of W0d's verification.)

---

### Task W0b: Move the realtime event unions into the contract package

**Files:**
- Create: `frontend/contract/src/events/session-events.ts`, `frontend/contract/src/events/pipeline-events.ts`, `frontend/contract/src/events/index.ts`
- Modify: `frontend/contract/src/index.ts` (re-export `./events`); `backend/src/contract/session-events.ts` + `backend/src/contract/pipeline-events.ts` → **re-export shims**
- Test: `frontend/contract/src/__tests__/events.test.ts`

**Interfaces:**
- Produces: `@mythrun/contract/events` re-exporting `ClientFrame, ServerFrame, ParticipantSummary, CLIENT_FRAME_TYPES, SERVER_FRAME_TYPES, classifyClientFrame` and `PipelineEvent, ProseEvent, PipelineSseEvent, PROSE_SSE_EVENTS, PIPELINE_SSE_EVENTS, PipelinePhase, PipelineStageDiagnostic` (verbatim copies — both source files have ZERO internal imports, verified).
- Consumes: nothing.

- [ ] **Step 1 — Failing test** `events.test.ts`: assert `CLIENT_FRAME_TYPES.includes('player_message')`, `classifyClientFrame('player_message') === true`, and `PROSE_SSE_EVENTS[0] === 'prep-delta'` via `import { ... } from '../events/index.js'` (NodeNext `.js` specifier — the repo canon for this package; vitest resolves `.js`→`.ts`).
- [ ] **Step 2 — Run, watch fail.**
- [ ] **Step 3 — Copy the two files verbatim** into `frontend/contract/src/events/` (they're self-contained). Add `events/index.ts` re-exporting both with `.js` specifiers (NodeNext). Re-export `./events/index.js` from `src/index.ts`.
- [ ] **Step 4 — Build + test pass.**
- [ ] **Step 5 — Replace `backend/src/contract/session-events.ts` with a shim:** `export * from '@mythrun/contract/events'` (keep the file so the ~6 production + tests importing `../contract/session-events.js` don't churn). Same for `pipeline-events.ts`. Confirm `backend-routes.ts` is untouched (it imports neither — verified).
- [ ] **Step 6 — Add `@mythrun/contract` to `backend/package.json` dependencies** (`"@mythrun/contract": "workspace:*"`); `pnpm install`.
- [ ] **Step 7 — `pnpm --filter @mythrun/contract build` then `pnpm --filter @mythrun/backend typecheck` + the contract/event tests** (`backend/src/contract/__tests__/session-events.test.ts`, `pipeline-events.test.ts`). All green — the shim preserves every import site. Commit.

> The backend now consumes `@mythrun/contract` at **typecheck** time. Its **Docker/runtime** consumption is W0d.

---

### Task W0c: Author the REST slice schemas

**Files:**
- Create: `frontend/contract/src/rest/users.ts`, `frontend/contract/src/rest/campaigns.ts`, `frontend/contract/src/rest/index.ts`
- Modify: `frontend/contract/src/index.ts` (re-export `./rest`); `backend/src/routes/users.ts` + `backend/src/routes/campaigns.ts` (type the slice returns against the schemas)
- Test: `frontend/contract/src/__tests__/rest.test.ts`

**Interfaces:**
- Produces:
  - `MeResponseSchema` = `z.object({ user: z.object({ id: z.string(), username: z.string(), displayName: z.string(), freeTrialUsed: z.boolean(), createdAt: z.string().datetime() }) })` — **public projection**: omits `cognitoSub`, `stripeCustomerId`, `suspendedAt`, `updatedAt`. `type MeResponse = z.infer<typeof MeResponseSchema>`.
  - `CampaignSummarySchema` = `z.object({ id: z.string(), worldId: z.string(), name: z.string(), status: z.enum(['setup','active','archived','failed']), language: z.string(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() })` (omit `sourceWorldId`, `createdBy` — not needed by the hub; add later if a flow needs them). `MyCampaignsResponseSchema = z.object({ campaigns: z.array(CampaignSummarySchema) })`. `type MyCampaignsResponse = z.infer<...>`.
- Consumes: nothing (Zod only).

- [ ] **Step 1 — Failing test** `rest.test.ts`: `MeResponseSchema.parse({ user: { id:'u', username:'a', displayName:'A', freeTrialUsed:false, createdAt:'2026-01-01T00:00:00.000Z' } })` succeeds; parsing a `createdAt: new Date()` (a Date, not string) **throws** (proves wire-shape modeling); `MyCampaignsResponseSchema.parse({ campaigns: [] })` succeeds.
- [ ] **Step 2 — Run, watch fail.**
- [ ] **Step 3 — Write `rest/users.ts` + `rest/campaigns.ts`** with the schemas above; `rest/index.ts` re-exports both; `src/index.ts` re-exports `./rest/index.js`.
- [ ] **Step 4 — Build + test pass.**
- [ ] **Step 5 — Type the backend returns.** In `backend/src/routes/users.ts` `GET /api/users/me`, map the row to the public projection and type it: build `const body: MeResponse = { user: { id: user.id, username: user.username, displayName: user.displayName, freeTrialUsed: user.freeTrialUsed, createdAt: user.createdAt.toISOString() } }` then `reply.send(body)`. In `campaigns.ts` `GET /api/campaigns/mine`, map `campaigns` to `CampaignSummary[]` (`.toISOString()` the dates) typed as `MyCampaignsResponse`. Import the types from `@mythrun/contract/rest`.
- [ ] **Step 6 — `pnpm --filter @mythrun/contract build` + `pnpm --filter @mythrun/backend typecheck` + the route tests** (`routes/__tests__/users.*.test.ts`, `campaigns.*.test.ts`). The backend now emits the deliberate wire shape (no `cognitoSub`/`stripeCustomerId` leak). Update any route test asserting the old `{ user: <full row> }` shape to the projection. Commit.

---

### Task W0d: Dockerfile + container-boot smoke (the showstopper fix)

**Files:**
- Modify: `backend/Dockerfile`
- Modify: `.husky/pre-push` (build the contract before the gates)
- Test/verify: a local `docker build` + boot.

**Interfaces:** none (build/deploy plumbing).

- [ ] **Step 1 — Dockerfile builder edits.** Before `pnpm install`, copy the contract manifest; before `pnpm build`, copy + build the contract:
```dockerfile
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY backend/package.json ./backend/
COPY frontend/contract/package.json ./frontend/contract/
RUN corepack enable && pnpm install --frozen-lockfile --filter @mythrun/backend --filter @mythrun/contract
COPY backend/ ./backend/
COPY frontend/contract/ ./frontend/contract/
RUN pnpm --filter @mythrun/contract build
WORKDIR /app/backend
RUN pnpm build
RUN pnpm --filter @mythrun/backend deploy --prod /app/deploy
```
> `pnpm deploy --prod` resolves the workspace dep and copies the built `@mythrun/contract` (with its `dist/`) into `/app/deploy/node_modules`. Verify `dist/` is present in deploy (the contract's `files`/`exports` must include `dist`; add `"files": ["dist"]` to the contract package.json).
- [ ] **Step 2 — Add `"files": ["dist"]`** to `frontend/contract/package.json` so `pnpm deploy` packs the built output.
- [ ] **Step 3 — pre-push ordering.** In `.husky/pre-push`, before the backend gate (step 2) and the frontend gate, add: `echo "→ pre-push gate (0): build @mythrun/contract"` + `pnpm --filter @mythrun/contract build`. (Consumers' typecheck resolves the built `dist`.)
- [ ] **Step 4 — Container-boot smoke.** Run `docker build -f backend/Dockerfile -t mythrun-backend-smoke .` from repo root; then `docker run --rm mythrun-backend-smoke node -e "require('./dist/server.js')"` is NOT valid (server self-boots) — instead boot with the minimal env and assert the process imports without `ERR_MODULE_NOT_FOUND`: `docker run --rm --entrypoint node mythrun-backend-smoke -e "import('@mythrun/contract').then(m=>{if(!m.CONTRACT_PACKAGE)process.exit(1)})"`. Expected: exit 0 (the contract resolves inside the image). This is the acceptance bar that `tsc`-green can't provide.
- [ ] **Step 5 — Commit** (Dockerfile + .husky/pre-push + contract `files`).

---

## Wave 1 — `client-core` data layer

### Task W1a: client-core deps, jsdom env, and the `no-restricted-globals` lint

**Files:**
- Modify: `frontend/client-core/package.json` (deps), `frontend/client-core/vitest.config.ts` (jsdom + coverage include), `frontend/client-core/eslint.config.js` (no-restricted-globals)
- Test: `frontend/client-core/src/__tests__/globals-lint.wiring.test.ts` (or extend existing wiring tests)

**Interfaces:** Produces the toolchain the rest of Wave 1 needs.

- [ ] **Step 1 — Deps.** Add to `frontend/client-core/package.json`: `dependencies`: `@mythrun/contract: "workspace:*"`, `zustand: "^5.0.0"`; `peerDependencies`: `@tanstack/react-query: "^5.0.0"`; `devDependencies`: `@tanstack/react-query: "^5.0.0"` (standalone typecheck/test), `@testing-library/react: "^16.1.0"`, `jsdom: "^25.0.0"`, `msw: "^2.6.0"`. `pnpm install`.
- [ ] **Step 2 — vitest jsdom.** In `frontend/client-core/vitest.config.ts`: add `environment: 'jsdom'`; extend coverage `include` to `['src/tokens/scales.ts', 'src/api/**', 'src/stores/**', 'src/platform/**', 'eslint-rules/**/*.js']`. Keep `maxWorkers: 3` and the 100% thresholds.
- [ ] **Step 3 — Failing lint wiring test.** Mirror the existing `*.wiring.test.ts` pattern: a test that runs ESLint on a fixture string referencing `document` and asserts `no-restricted-globals` reports it. (Use the same harness the existing `api-purity.wiring.test.ts` uses.)
- [ ] **Step 4 — Run, watch fail.**
- [ ] **Step 5 — Add the rule** to `frontend/client-core/eslint.config.js`, a new flat-config object:
```js
{
  files: ['src/**/*.{ts,tsx}'],
  ignores: ['src/**/*.test.{ts,tsx}'],
  rules: {
    'no-restricted-globals': ['error',
      { name: 'document', message: 'DOM-free (R1): client-core may not touch the DOM. Reach platform capability through a platform/ interface.' },
      { name: 'window', message: '…' }, { name: 'localStorage', message: '…' }, { name: 'sessionStorage', message: '…' },
      { name: 'location', message: '…' }, { name: 'navigator', message: '…' }, { name: 'EventSource', message: '…' },
    ],
  },
},
```
- [ ] **Step 6 — Lint passes on current source** (client-core has no DOM refs today); the wiring test passes. Commit.

---

### Task W1b: Typed errors + the `SecureStorage` interface

**Files:** Create `frontend/client-core/src/api/errors.ts`, `frontend/client-core/src/platform/secure-storage.ts`; Tests colocated.

**Interfaces:**
- Produces: `class HttpError extends Error { readonly status: number }`, `class ContractValidationError extends Error { readonly cause: unknown }`, `class NetworkError extends Error`; type guards `isHttpError(e): e is HttpError` etc. `interface SecureStorage { get(key: string): Promise<string | null>; set(key: string, value: string): Promise<void>; remove(key: string): Promise<void> }`.

- [ ] **Step 1 — Failing test** for the error classes: `new HttpError(403, 'msg').status === 403`, `isHttpError(new HttpError(...))` true / `isHttpError(new Error())` false.
- [ ] **Step 2 — fail → Step 3 implement → Step 4 pass.** `errors.ts` with the three classes + guards (no `any`; `cause` typed `unknown`).
- [ ] **Step 5 — `secure-storage.ts`** the interface only (no impl — the web impl is W3b). A type-only file needs no runtime test; add a `secure-storage.test-d`-style compile assertion or skip (interface-only). Commit.

---

### Task W1c: `defineEndpoint` — the typed primitive

**Files:** Create `frontend/client-core/src/api/endpoint.ts`, `frontend/client-core/src/api/endpoint.test.ts`.

**Interfaces:**
- Consumes: `HttpError/ContractValidationError/NetworkError` (W1b); Zod schemas from `@mythrun/contract`.
- Produces:
```ts
interface ApiContext { baseUrl: string; getAuthHeaders: () => Promise<Record<string, string>> }
interface EndpointSpec<Res, In> {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  path: (input: In) => string
  request?: ZodType<unknown>   // from @mythrun/contract
  response: ZodType<Res>       // from @mythrun/contract
}
function defineEndpoint<Res, In = void>(spec: EndpointSpec<Res, In>): (input: In, ctx: ApiContext) => Promise<Res>
```

- [ ] **Step 1 — Failing tests** (MSW-backed; jsdom env): (a) a GET endpoint with a `z.object({ok: z.boolean()})` response resolves the parsed body; (b) a 403 response throws `HttpError` with `.status === 403`; (c) a response that fails the Zod schema throws `ContractValidationError`; (d) a `fetch` rejection throws `NetworkError`; (e) the request carries the headers from `ctx.getAuthHeaders()`.
```ts
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
// ... server.use(http.get('http://api.test/ok', () => HttpResponse.json({ ok: true }))) ...
const getOk = defineEndpoint({ method: 'GET', path: () => '/ok', response: z.object({ ok: z.boolean() }) })
await expect(getOk(undefined, ctx)).resolves.toEqual({ ok: true })
```
- [ ] **Step 2 — Run, watch fail.**
- [ ] **Step 3 — Implement `defineEndpoint`:** build `baseUrl + path(input)`, `headers = await getAuthHeaders()` (+ `Content-Type: application/json` when `request`); `fetch` (catch → `NetworkError`); `if (!res.ok) throw new HttpError(res.status, ...)`; `const json = await res.json()`; `const parsed = spec.response.safeParse(json); if (!parsed.success) throw new ContractValidationError(...); return parsed.data`. Keep the function < 50 lines (extract a `request()` helper if needed).
- [ ] **Step 4 — Tests pass; 100% branch coverage** (each throw arm is tested). Commit.

---

### Task W1d: The session store + `getAuthHeaders`

**Files:** Create `frontend/client-core/src/stores/session.ts`, `frontend/client-core/src/api/auth.ts`; tests colocated.

**Interfaces:**
- Produces:
  - `type SessionStatus = 'unauthenticated' | 'onboarding-required' | 'ready'`; a Zustand store `useSessionStore` with `{ status: SessionStatus, sub: string | null, setUnauthenticated(): void, setOnboardingRequired(sub: string): void, setReady(sub: string): void }`. Default `status: 'unauthenticated'`.
  - `getAuthHeaders(opts: { mode: 'bypass' | 'jwt'; devSub?: string; secureStorage: SecureStorage }): () => Promise<Record<string, string>>` — bypass → `{ 'x-mythrun-dev-sub': devSub }`; jwt → reads the token via `secureStorage.get('auth_token')` → `{ Authorization: 'Bearer ' + token }` (or `{}` if absent).

- [ ] **Step 1 — Failing tests:** the store starts `unauthenticated`; `setReady('s')` → `{status:'ready', sub:'s'}`; `getAuthHeaders({mode:'bypass', devSub:'dev-user-1', ...})()` resolves `{ 'x-mythrun-dev-sub': 'dev-user-1' }`; `getAuthHeaders({mode:'jwt', secureStorage})` with a stubbed storage returning `'tkn'` resolves `{ Authorization: 'Bearer tkn' }`. Use a fake `SecureStorage` (in-memory map) — not the web impl.
- [ ] **Step 2 → 4 — fail → implement → pass.** Zustand `create` (use `zustand/vanilla` + `zustand` React binding; the store itself is DOM-free). `auth.ts` conditionally spreads optional headers (no explicit `undefined`).
- [ ] **Step 5 — 100% coverage** (both auth modes, token-present/absent). Commit.

---

### Task W1e: The slice endpoints + hooks + the API client context

**Files:** Create `frontend/client-core/src/api/client-context.tsx`, `frontend/client-core/src/api/users.ts`, `frontend/client-core/src/api/campaigns.ts`; tests colocated (MSW + RTL + a `QueryClientProvider` test wrapper).

**Interfaces:**
- Consumes: `defineEndpoint` (W1c), the contract schemas (`MeResponseSchema`, `MyCampaignsResponseSchema`), `ApiContext`.
- Produces:
  - `ApiClientProvider` (React context carrying the resolved `ApiContext`) + `useApiContext()`.
  - `getMe = defineEndpoint({ method:'GET', path:()=> '/api/users/me', response: MeResponseSchema })`; `useMe()` = `useQuery({ queryKey:['me'], queryFn: () => getMe(undefined, ctx) })` (suspense).
  - `getMyCampaigns` + `useMyCampaigns()` (queryKey `['campaigns','mine']`).

- [ ] **Step 1 — Failing test:** render `useMyCampaigns` inside `<QueryClientProvider><ApiClientProvider value={ctx}>` with MSW returning `{ campaigns: [{...valid CampaignSummary...}] }`; assert the hook resolves the parsed array. A second test: MSW returns a malformed campaign (missing `name`) → the query surfaces a `ContractValidationError`.
- [ ] **Step 2 → 4 — fail → implement → pass.** The hooks read `ctx` from `useApiContext()`. Keep hooks thin (no logic beyond wiring `defineEndpoint` into `useQuery`).
- [ ] **Step 5 — 100% coverage** on `api/**`. Run `pnpm --filter @mythrun/client-core test:coverage` — green at 100% for `api/`, `stores/`, `platform/`. Commit.

---

## Wave 2 — i18n catalog relocation

### Task W2a: Split the i18n config — catalog + augmentation → client-core

**Files:**
- Create: `frontend/client-core/src/i18n/locales/en/common.json` (moved), `frontend/client-core/src/i18n/resources.ts`, `frontend/client-core/src/i18n/i18next.d.ts`
- Modify: `frontend/src/i18n/config.ts` (import `resources`/`defaultNS` from client-core; keep `init` + the `i18n` export), delete the web copies of the catalog + augmentation, keep `frontend/src/i18n/typed-keys.guard.ts` (re-point its import)
- Modify: `frontend/client-core/package.json` (+ `i18next: "^26.3.1"` dep), `frontend/client-core/package.json` exports (`"./i18n": "./src/i18n/resources.ts"` — source-consumed by the Bundler frontend; the contract package is the only NodeNext consumer, and the backend doesn't import i18n).

**Interfaces:**
- Produces: `@mythrun/client-core/i18n` exporting `resources` (`{ en: { common } } as const`) + `defaultNS = 'common'`. The `CustomTypeOptions` augmentation lives in client-core and imports the relocated `resources` (NOT web's config).
- Consumes: nothing.

> **Invariant:** keep i18n init **synchronous** in `web/src/i18n/config.ts` (no async backend without a `<Suspense>`). The typed-keys guard must stay green (`pnpm --filter @mythrun/web typecheck` must still reject an unknown key).

- [ ] **Step 1 — Failing test** in client-core: `import { resources, defaultNS } from '../i18n/resources.ts'`; assert `resources.en.common.back === 'Back'` and `defaultNS === 'common'`.
- [ ] **Step 2 → 3 — fail → move:** copy `common.json` to client-core; write `resources.ts` (`export const resources = { en: { common } } as const; export const defaultNS = 'common'`); write client-core `i18next.d.ts` augmentation importing from `./resources.ts`; add the `./i18n` export + `i18next` dep.
- [ ] **Step 4 — Re-point web:** `frontend/src/i18n/config.ts` imports `{ resources, defaultNS } from '@mythrun/client-core/i18n'`, keeps the `i18n.use(initReactI18next).init({...resources, defaultNS...})` + `export { i18n }`. Delete web's `locales/en/common.json` + `i18next.d.ts`. Re-point `typed-keys.guard.ts` (it imports `i18n` from `./config.ts` — unchanged).
- [ ] **Step 5 — Verify:** `pnpm --filter @mythrun/client-core test` (resources test) + `pnpm --filter @mythrun/web typecheck` (the augmentation still types keys — add a deliberate `@ts-expect-error` unknown-key probe to confirm) + `pnpm --filter @mythrun/web test`. Commit.

---

## Wave 3 — `@mythrun/web` shell

### Task W3a: web deps, Vite dedupe, and the providers

**Files:**
- Modify: `frontend/package.json` (+ `react-router-dom: "^7.0.0"`, `@tanstack/react-query: "^5.0.0"`; +dev `msw: "^2.6.0"`), `frontend/vite.config.ts` (dedupe)
- Create: `frontend/src/app/providers.tsx`
- Test: `frontend/src/app/providers.test.tsx`

**Interfaces:**
- Produces: `<AppProviders>` wrapping children with `QueryClientProvider` (a single module-level `QueryClient` with sane defaults: `{ queries: { retry: 1, refetchOnWindowFocus: false } }`), `ApiClientProvider` (resolved `ApiContext` from config: `baseUrl` from `import.meta.env`, `getAuthHeaders` from the session/auth wiring), `I18nextProvider`, and seeding the session store.
- Consumes: `ApiClientProvider`, `useSessionStore`, `getAuthHeaders` from client-core.

- [ ] **Step 1 — Vite dedupe:** `resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] }` in `vite.config.ts` (also mirror in `vitest.config.ts` if it overrides resolve).
- [ ] **Step 2 — Failing test:** render `<AppProviders><Probe/></AppProviders>` where `Probe` calls `useQueryClient()` and `useApiContext()`; assert both resolve (no throw). 
- [ ] **Step 3 → 4 — implement → pass.** Construct the web `SecureStorage` impl injection point (the impl lands in W3b; here accept it via a prop/param so the provider is testable with a fake).
- [ ] **Step 5 — Commit.**

---

### Task W3b: the `platform/web` SecureStorage impl + the web globals lint

**Files:**
- Create: `frontend/src/platform/web/secure-storage.ts`, test
- Modify: `frontend/eslint.config.js` (no-restricted-globals: web outside `platform/web/**` + `main.tsx` carve-out)

**Interfaces:**
- Produces: `createWebSecureStorage(): SecureStorage` over `localStorage` (async-wrapped). This is the FIRST `platform/web` impl — it establishes the convention.

- [ ] **Step 1 — Failing test** (jsdom): `createWebSecureStorage().set('k','v')` then `.get('k')` resolves `'v'`; `.remove('k')` then `.get('k')` resolves `null`.
- [ ] **Step 2 → 4 — implement (localStorage) → pass.**
- [ ] **Step 5 — Failing lint wiring:** a fixture referencing `localStorage` in `src/routes/x.ts` must error; the same in `src/platform/web/secure-storage.ts` must pass; `document.getElementById` in `src/main.tsx` must pass.
- [ ] **Step 6 — Add to `frontend/eslint.config.js`:**
```js
{ files: ['src/**/*.{ts,tsx}'], ignores: ['src/platform/web/**', 'src/main.tsx', 'src/**/*.test.{ts,tsx}'],
  rules: { 'no-restricted-globals': ['error', /* same 7 globals as client-core */ ] } },
```
- [ ] **Step 7 — Lint + tests pass. Commit.**

---

### Task W3c: the router, the quiet frame, RequireAuth (3-state), the dithered 404, the error boundary

**Files:** Create `frontend/src/app/router.tsx`, `app/app-frame.tsx`, `app/require-auth.tsx`, `app/not-found.tsx`, `app/error-boundary.tsx`; rewrite `frontend/src/app.tsx`; modify `frontend/src/main.tsx`; route **stubs** under `frontend/src/routes/`. Tests colocated.

**Interfaces:**
- Consumes: `useSessionStore` (W1d), the providers (W3a), `@mythrun/ui` components, the `Dither` component, i18n keys.
- Produces: `<AppRouter>` with the public/authed split below; `<RequireAuth>` reading `useSessionStore().status` — `unauthenticated` → `<Navigate to="/auth/signin" replace/>`; `onboarding-required` → `<Navigate to="/auth/onboard" replace/>` (stub route); `ready` → `<Outlet/>`.

Route tree (each non-home a thin i18n'd stub):
```
public:  /  /auth/signin  /auth/callback/:provider  /auth/onboard  /join/:code  /campaigns/:id/recap
authed (RequireAuth → AppFrame):  /home (WIRED)  /campaigns/new  /campaigns/:id/character/new  /campaigns/:id/play  /settings
*  → dithered 404
```

- [ ] **Step 1 — Failing tests:** (a) rendering the router at `/home` with session `unauthenticated` redirects to `/auth/signin` (assert the signin stub's testid renders); (b) at `/home` with session `ready`, the `AppFrame` header testid renders; (c) an unknown path renders the 404 (assert a `Dither` `[data-dither-texture]` is present). Use `createMemoryRouter` + `RouterProvider` in tests.
- [ ] **Step 2 — Run, watch fail.**
- [ ] **Step 3 — Implement** the frame (header composed from `@mythrun/ui` — logo/displayName/credits/settings placeholders, all i18n keys + `[placeholder for …]` values added to `common.json`), `RequireAuth`, `not-found.tsx` (full-bleed `Dither pairing="light-ink"` + an i18n'd message), `error-boundary.tsx` (a `routeError` element branching on `isHttpError`/`ContractValidationError`/`NetworkError` → distinct i18n'd copy; 401 triggers `useSessionStore.setUnauthenticated()`), and the route stubs (each returns a `<Heading>`/`<Text>` with `[placeholder for <screen>]`). Wire `main.tsx` to render `<AppProviders><AppRouter/></AppProviders>`.
- [ ] **Step 4 — Tests pass.** Add the new i18n keys; run `pnpm --filter @mythrun/web typecheck` (typed keys) + `lint` (no-ad-hoc-ui/i18n). Commit.

---

### Task W3d: the `routes/` feature import boundary (close the conformance bypass)

**Files:** Modify `frontend/eslint.config.js`; wiring test.

**Interfaces:** none — a lint.

- [ ] **Step 1 — Failing wiring test:** a fixture in `src/routes/x.tsx` importing `@tanstack/react-query` must error; importing `useMyCampaigns` from `@mythrun/client-core` must pass; using `fetch(...)` in `src/routes/x.tsx` must error; `fetch` in `src/app/providers.tsx` (non-routes) need not (it's allowed outside routes).
- [ ] **Step 2 — Add to `frontend/eslint.config.js`** a `files: ['src/routes/**/*.{ts,tsx}']` block: extend `no-restricted-imports` with `{ name: '@tanstack/react-query', message: 'Screens must not call useQuery directly — import a hook from @mythrun/client-core (R5/conformance).' }` and a `patterns` entry banning deep `@mythrun/client-core/src/*`; add `no-restricted-globals` for `fetch`, `XMLHttpRequest`, `WebSocket` in `routes/**` (these are allowed elsewhere, banned in screens).
- [ ] **Step 3 — Lint + wiring pass; confirm the existing route stubs + home hub still lint clean. Commit.**

---

### Task W3e: the wired home hub + finalize stubs

**Files:** `frontend/src/routes/home.tsx` (rewrite from stub to wired); test.

**Interfaces:** Consumes `useMyCampaigns` (W1e), `@mythrun/ui` (`Card`, `Heading`, `Text`, `Stack`, `Spinner`), i18n keys.

- [ ] **Step 1 — Failing test:** render `/home` (session `ready`) with MSW returning two campaigns; assert both campaign names render inside the frame, behind a `<Suspense>` fallback that showed first. A second test: MSW 500 → the error boundary's retry copy renders.
- [ ] **Step 2 → 4 — implement → pass.** The hub maps `useMyCampaigns().data.campaigns` to `@mythrun/ui` cards; `<Suspense fallback={<Spinner/>}>`; empty-state copy (`[placeholder for empty campaign hub]`). No `fetch`/`react-query` import (uses the client-core hook — satisfies W3d). Commit.

---

## Wave 4 — the real-backend smoke

### Task W4a: home-hub wire smoke against the real backend

**Files:** Create `frontend/src/smoke/home-hub.smoke.ts` (a node script, not a vitest test) + a `package.json` script `smoke:home-hub`.

**Interfaces:** none (a driven smoke).

- [ ] **Step 1 — Write the smoke** (mirrors `backend/dev-tool/scripts/verify.ts` bootstrap): against `BACKEND_URL=http://localhost:3030` with `x-mythrun-dev-sub: dev-user-1`:
  1. `POST /api/users/register` `{ username:'homehubsmoke', displayName:'Home Hub Smoke' }`, accept `200|201|409`.
  2. `GET /api/users/me` — assert 200 + the body parses against `MeResponseSchema` (imported from `@mythrun/contract/rest`) and contains NO `stripeCustomerId`/`cognitoSub` key.
  3. `GET /api/campaigns/mine` — assert 200 + parses against `MyCampaignsResponseSchema`.
  Exit non-zero with a clear message on any failure.
- [ ] **Step 2 — Drive it for real:** start the dev backend (`pnpm db:up`, `pnpm --filter @mythrun/backend dev` with `AUTH_MODE=bypass`), then `pnpm --filter @mythrun/web smoke:home-hub`. Expected output: `me OK (projection clean) · campaigns/mine OK (N rows)`. Fix any real wire mismatch found (this is where a date-codec or projection bug surfaces). 
- [ ] **Step 3 — Commit.** (The smoke is the done-when #3 proof; it is NOT part of the unit suite/coverage.)

---

## Final verification (controller, after all tasks)

Run, from repo root: `pnpm --filter @mythrun/contract build` → `pnpm -r typecheck` → `pnpm -r lint` (incl. `lint:css`) → `pnpm --filter @mythrun/client-core test:coverage` + `pnpm --filter @mythrun/web test:coverage` + `pnpm --filter @mythrun/ui test` → `pnpm --filter @mythrun/ui story-coverage` → `pnpm --filter @mythrun/web build` → `pnpm --filter @mythrun/ui build-storybook` → the backend gate (`typecheck`, `lint`, `test:coverage`) → the W0d container-boot smoke → the W4a real-backend home-hub smoke. Then dispatch the final whole-diff code review.

---

## Self-Review

**Spec coverage:** §1 packages → W0a/W1a/W3a; §2 contract (authored REST + moved events) → W0b/W0c; §3 data layer (defineEndpoint, typed errors, hooks, providers) → W1b/W1c/W1e/W3a; §4 routing/frame/404/error → W3c; §5 SecureStorage interface + platform/web → W1b/W3b; §6 conformance (defineEndpoint + no-restricted-globals + routes/ boundary) → W1c/W1a/W3b/W3d; §7 three-state auth + smoke-registers → W1d/W3c/W4a; §8 i18n relocation → W2a; §9 testing/coverage → W1a/W1e/W4a; §11 file structure → all; §12 showstopper (built package + Docker + container smoke) → W0a/W0d. No gaps.

**Placeholder scan:** no TBD/TODO; code shown for every load-bearing interface; the trivial stub bodies are described with exact content (`[placeholder for <screen>]`).

**Type consistency:** `ApiContext`/`getAuthHeaders`/`SessionStatus`/`defineEndpoint` signatures match across W1b–W1e and W3a/W3c; `MeResponse`/`MyCampaignsResponse`/`CampaignSummary` names match across W0c, W1e, W4a.
```
