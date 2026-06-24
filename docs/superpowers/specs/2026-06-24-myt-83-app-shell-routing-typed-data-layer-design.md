# MYT-83 — App Shell, Routing & Typed Data Layer — Design

> **Status:** Design approved in brainstorm 2026-06-24; revised after blind review (round 1 "Bridges"). Source of truth for the implementation plan.
> **Linear:** MYT-83 (Frontend milestone, Phase 1 "Plumbing", due 2026-06-25). Blocks MYT-84 (auth), MYT-85 (realtime), MYT-86 (landing). Depends on MYT-82 (mythrunUI).

## Goal

The application skeleton every flow hangs on: a React-Router shell (authenticated/public split + the quiet brand frame + a dithered 404), a typed REST data layer over the real backend, and the **portability structure** (R1/R5) that keeps the whole client portable to true-native later. The load-bearing constraint: **all of the data/state/transport layer is built into `@mythrun/client-core`, not `web/src`**, so there is never a later extraction refactor.

## Done when

1. Routes resolve; the route tree hosts stubs for every flow screen.
2. A protected route redirects to `/auth/signin` when unauthenticated — proven by the session store starting in the `unauthenticated` state (no token), driving `<RequireAuth>` client-side independent of the backend.
3. A typed client call renders **real backend data** behind a loading state: the home hub fetching `campaigns/mine` against the running dev backend, **after the smoke registers/onboards the dev user** (see §7) so the call returns real rows rather than a 403. Proven by a wire-level smoke.
4. The `@mythrun/contract` package builds and is consumed by **both** the backend (NodeNext, in its Docker image) and the frontend (Bundler); a **container-boot smoke** of the backend image passes (not just `tsc`).
5. `tsc`, the frontend lint rails (incl. the new R1/R5 lints), `lint:css`, `story-coverage`, the tiered coverage gate, `build-storybook`, and the web build all pass.

---

## Decisions taken in the brainstorm

1. **Typed contract → a shared `@mythrun/contract` package** (not hand-written types, not codegen). For the **REST** surface, Zod schemas are the single typed source: the backend types its handler return against the schema (compile-time link via `tsc`), and `client-core` derives types via `z.infer` **and validates responses at runtime** (so a drift fails loudly in dev). Chosen for durability — a silent shape drift is a nasty production bug.
2. **Move a thin slice now, not the whole API.** MYT-83 stands up the package, moves the already-isolated realtime event unions, and authors REST schemas only for the endpoints the home-hub smoke needs. Each flow ticket adds its own endpoints on the established pattern. **The pattern is enforced by construction** (see §6) so later flows can't drift from it.

> **Two kinds of artifact in `@mythrun/contract` — stated plainly.** (a) **REST schemas** are Zod (request + response), runtime-validated on the client. (b) The **realtime event unions** (`session-events`, `pipeline-events`) are *hand-written TypeScript discriminated unions + `readonly string[]` allowlists + `classify*` runtime helpers — not Zod* (verified: zero `z.` usage). They move as-is; the client gets *type* safety but **no runtime frame validation** from this move. Whether to add Zod frame validation is **MYT-85's** call. The "Zod single source / validate responses" guarantee therefore covers REST only — do not read it as covering the realtime path.

> **Naming caution.** `@mythrun/contract` (this new package — wire/Zod contracts) is a *different concept* from the existing `@mythrun/client-core`'s `src/contract/` (mythrunUI component **prop** contracts from MYT-82, gated by `api-purity`). They sit one import-path apart. The new package carries its **own** minimal ESLint config (Zod-only) — it must NOT inherit or collide with `client-core`'s `api-purity` path scope.

---

## 1. Package architecture

Four packages; the "client brain" sits in the middle and is imported verbatim by the future native app.

```
@mythrun/contract   (NEW — a BUILT package: emits .js + .d.ts via an exports map)
    REST Zod schemas + the (TS-only) realtime event unions.   backend ─┐   ┌─ client-core   (both import it; tsc links both)
                                                                        ▼   ▼

@mythrun/client-core   (the platform-agnostic "client brain" — DOM-FREE)
    contract/   component prop contracts          (existing, MYT-82)
    tokens/     palette generator                 (existing, MYT-82)
    domain/     domain types (z.infer from @mythrun/contract REST schemas)
    api/        typed REST client + React-Query hooks (over universal fetch; validates with contract Zod; throws typed errors)
    stores/     view-state (Zustand: a three-state session store) — DOM-free
    platform/   capability INTERFACES (SecureStorage now; more added as flows need them)
    i18n/       the catalog + resources/defaultNS + the typed-keys augmentation — relocated here per R1
        ▲
@mythrun/ui   (existing web design system, DOM + Tailwind)
        ▲
@mythrun/web   (the app — THIN)
    app/            React-Router shell + the quiet brand frame + global providers
    routes/         thin route screens (compose client-core + ui + i18n keys only — R5)
    platform/web/   web IMPLEMENTATIONS of client-core's interfaces (SecureStorage → localStorage)
```

**Principle:** everything that isn't a pixel lives in `client-core` — the API client, the React-Query hooks, the stores, the platform *interfaces*, the i18n catalog. `web` holds only the router shell, thin screens, and the web *implementations* of those interfaces under `platform/web/**`. The native port later re-fills `platform/web` → `platform/native` and swaps `@mythrun/ui` → `@mythrun/ui-native`; `client-core` + `@mythrun/contract` are untouched.

**Dependency facts.**
- `@mythrun/contract` depends on `zod` only (pin to **Zod 4**, matching `backend`'s `zod ^4.4.3`, so the validator never forks). Registered in `pnpm-workspace.yaml`. Consumed by `@mythrun/backend` and `@mythrun/client-core`. **It is a built package** — see §2 + §12 (the backend cannot consume `.ts` source; this is non-negotiable).
- `client-core` adds `zustand` (normal dep) and `@tanstack/react-query` as **both a peerDep** (loose range, the app provides the single instance) **and a devDep** (so `pnpm --filter @mythrun/client-core typecheck`/tests resolve it standalone) — mirroring how `react` is already wired. Pin react-query to one version at the workspace root.
- **Single React-Query instance** belt-and-suspenders: add `resolve.dedupe: ['react', 'react-dom', '@tanstack/react-query']` to the Vite (and Vitest) config. `.npmrc` sets `inject-workspace-packages=true` (hard-copies, not symlinks), which is exactly the config where a second context-bearing copy slips in; `dedupe` is the cheap insurance against the "No QueryClient set in context" class of bug.

---

## 2. The shared `@mythrun/contract` package

- **REST schemas — authored, not extracted.** The two smoke endpoints have **no response schema today** (`GET /api/users/me` and `GET /api/campaigns/mine` both `reply.send(raw repo row)`; the only existing Zod on those routes is request-body validation). So MYT-83 **authors** the response schemas:
  - They model the **over-the-wire shape**, not the in-memory domain type. `Campaign.createdAt/updatedAt` and `User.*At` are `Date` server-side but JSON-serialize to **ISO strings** — the response schema uses `z.string().datetime()` (or a shared `zDate` codec), never `z.date()`. (A naive row-mirror schema would reject real payloads and fail the smoke on a non-bug.)
  - `/me` is a **deliberate public projection**, not a mirror of the repo `User` row — it omits billing-internal fields (`stripeCustomerId`, `suspendedAt`). Defining the intended public shape is a task acceptance criterion.
  - The backend **types its handler return** against the schema (`satisfies`/typed return → compile-time single source via `tsc`). Runtime *outbound* validation on the backend is **out of scope** for MYT-83 (it would risk live 5xx on a mismatch); the client-side runtime validation (§3) is the drift catch.
- **Realtime unions — move as-is.** `session-events.ts` (`ClientFrame`/`ServerFrame` + allowlists) and `pipeline-events.ts` (`PipelineEvent`/`ProseEvent`) move wholesale — they're self-contained (zero internal imports, verified), so it's cheap and sets up MYT-85. `backend/src/contract/` keeps a **re-export shim** so the ~10 backend import sites and the drift-tested `backend-routes.ts` don't churn. These are TS, not Zod (see the boxed note above).
- Frontend REST types come from `z.infer`. No types are hand-declared for a covered REST endpoint.

---

## 3. The typed data layer

Data path:

```
@mythrun/contract (REST Zod)  →  client-core/api (defineEndpoint + hooks)  →  React Query  →  thin screen
```

- **The endpoint primitive.** Every backend call is built through one typed factory:

  ```ts
  // client-core/api/endpoint.ts  (sketch)
  defineEndpoint<Res, Req>({
    method, path,            // path is a typed builder: (params) => string
    request?: ZodType<Req>,  // from @mythrun/contract
    response: ZodType<Res>,  // from @mythrun/contract
  }): (input, ctx: ApiContext) => Promise<Res>
  ```

  The returned function builds the URL, attaches auth headers (§7), calls universal `fetch`, then **parses and validates the response against `response`**. `request`/`response` are required and typed as Zod schemas, so an endpoint *cannot* be defined without contract schemas — the conformance lever (§6).

- **Typed errors.** `defineEndpoint` throws **discriminated** error types so callers can branch instead of collapsing everything into one error screen:
  - `HttpError { status }` — a non-2xx response. `401`/`403` drive the session store + `<RequireAuth>` (§7), not the generic boundary.
  - `ContractValidationError` — the response failed Zod parse (a backend drift). Loud in dev.
  - `NetworkError` — fetch rejected.
  This typing is what makes the loading/error model usable as *the pattern every flow inherits*, not just the home-hub demo.

- **Transport.** REST uses universal `fetch` directly (R1 permits `fetch`; it exists on web and native alike). No transport interface for REST — the platform-divergent streaming transports (SSE/WS) are MYT-85's concern.

- **Hooks.** Thin React-Query hooks (`useMe`, `useMyCampaigns`) wrap the endpoint functions and live in `client-core/api` (React, not DOM → R1-clean; native reuses them). They read a configured client from a `client-core` React context. React-Query's `retry`/error config is set on the `QueryClient` so flows get sane retry by default; the route error boundary exposes a `reset()` retry affordance.

- **Wiring.** `web/app` constructs the configured API client (base URL + the injected `SecureStorage` web impl + the auth-mode config) and provides it via the context, alongside the `QueryClientProvider` and its `QueryClient` instance.

- **Loading/error conventions.** Screens render data behind `<Suspense>` with React-Query's suspense mode; a route-level error boundary catches fetch/render failures and branches on the typed errors above. The home hub demonstrates the full loading → data path; other screens are stubs.

---

## 4. Routing & the shell

- **The split (React Router).** A root with two branches:
  - **Public:** `/` (landing), `/auth/*` (sign-in, OAuth callback), `/join/:code` (invite), `/campaigns/:id/recap` (shareable recap — *param shape provisional*: the backend serves recap by `sessionId`; the stub URL must not calcify a campaign-id contract).
  - **Authed:** under a `<RequireAuth>` boundary (§7). Children: `/home`, `/campaigns/new`, `/campaigns/:id/character/new`, `/campaigns/:id/play`, `/settings`.
- **Screens.** Every screen is a thin **stub** the flow tickets fill — except the **home hub**, wired end-to-end (`useMyCampaigns` → real backend → loading state) for the done-when smoke.
- **The quiet brand frame** (per brand `decisions.md`, "frame vs content"). Authed routes render inside a persistent, minimal frame — a quiet header (logo · display name · credits + quick-buy · settings) wrapping the content `<Outlet/>`. The frame recedes; content is the focus. The play route adds its collapsible sidebar later (MYT-92). Composed from mythrunUI only (R5).
- **404 + errors.** A **dithered 404** (the `Dither` component as a full-bleed treatment — its first product use) and a route-level error boundary for unexpected failures.
- **Providers** (`web/app`). The stack — `QueryClientProvider`, the API-client context, `I18nextProvider`, the session provider — wraps the router. The **`platform/web` impls are constructed here** (SecureStorage → localStorage) and injected into `client-core`, so the brain never touches a web global itself.

---

## 5. Platform interfaces (R1) — scoped by YAGNI

- **Defined now:** `SecureStorage` — the token store.

  ```ts
  // client-core/platform/secure-storage.ts  (sketch)
  interface SecureStorage { get(k): Promise<string|null>; set(k, v): Promise<void>; remove(k): Promise<void> }
  ```

  Web impl `web/platform/web/secure-storage.ts` over `localStorage` (the web baseline for a JWT absent an httpOnly cookie; the *name* signals intent — the later native impl uses Keychain/Keystore). This one interface + its impl **establishes the `platform/web` convention** the issue asks us to decide.
- **Deferred (added by the ticket that first needs them):** `StreamingFetch` (SSE) + the WS transport → MYT-85; `Share`, `Push`, `DeepLink`, `Clipboard`, `Locale` → their flow tickets. We do not define interfaces with no consumer.

---

## 6. Enforcement — R1/R5, and conformance by construction

Conformance is **structural**, not a convention a flow could quietly skip.

- **Contract conformance by construction.** The only way to make a backend call is `defineEndpoint`, whose `request`/`response` are typed as Zod schemas from `@mythrun/contract`. A flow adding an endpoint physically must add that endpoint's schema to the contract package — no path around the primitive's type signature. **Plus the bypass is closed:** the R5 feature import boundary (below) bans `@tanstack/react-query` *and* `fetch` inside `routes/**`, so a screen can't sidestep `defineEndpoint` by calling `useQuery`/`fetch` directly. Screens import hooks from `client-core` only. (The type signature alone doesn't forbid a raw call in a screen — the import boundary is what makes it structural.)
- **`no-restricted-globals` (R1).** Bans `document, window, localStorage, sessionStorage, location, navigator, EventSource` in `client-core` **and** in `web` outside `platform/web/**`. `fetch`/`WebSocket` stay allowed (universal). **Carve-out:** the app entry `frontend/src/main.tsx` (its `document.getElementById('root')` mount) is exempt, the same way the existing configs exempt `vite.config.ts`/`vitest.config.ts` — the entry is the one unavoidable web-only DOM touch and the native entry is entirely different. Ships with +/- wiring tests (a banned global fails; a `platform/web` use and the entry pass).
- **Feature import boundary (R5, deferred from MYT-82).** Route/feature dirs may import only `@mythrun/client-core`, `@mythrun/ui`, and i18n — not `react-dom`/Radix/CVA/`@tanstack/react-query`/`fetch`, not each other's internals, not deep `@mythrun/ui/src/*`. Extends the existing `no-restricted-imports` rail keyed off the `routes/` structure MYT-83 creates.
- **Carried over from MYT-82:** `no-ad-hoc-ui`, `no-ad-hoc-color`, `api-purity`, `no-untranslated-jsx-text` / i18n — all still apply.

---

## 7. Auth — a three-state model now (MYT-84 fills acquisition)

The backend distinguishes **two** rejections the client must tell apart: `401 unauthenticated` (no/invalid token) and `403 username_required` (authenticated but no `users` row yet — the onboarding gate, enforced by `requireOnboarded` on `campaigns/mine`). A two-state auth model would force a MYT-84 retrofit of the boundary the whole app hangs on, so MYT-83 bakes in the right shape now:

- **Session store** (`client-core/stores`, Zustand) holds **three states**: `unauthenticated | onboarding-required | ready`. `<RequireAuth>` redirects `unauthenticated` → `/auth/signin`; `onboarding-required` → the onboarding flow (the *route/flow* is MYT-84's; for MYT-83 it may be a stub, but the **state** exists so MYT-84 doesn't retrofit). `ready` renders.
- **Auth headers** via an injected `getAuthHeaders()`: **dev** (`AUTH_MODE=bypass`) sends `x-mythrun-dev-sub: <sub>`; **prod** sends `Authorization: Bearer <token>` from `SecureStorage`. Selection is a build/runtime config flag, not request-time logic. (Verified against `bypass-plugin.ts` / `jwt-plugin.ts`.)
- **The smoke onboards first.** The dev bypass sets `request.user.sub` but creates **no** `users` row, so `campaigns/mine` 403s until the user registers (mirrors the existing `prep-pipeline.ts` smoke). The done-when #3 smoke therefore: `POST /api/users/register` the dev user → then `GET /api/campaigns/mine` renders real rows. Without this it hits the 403 onboarding gate, not data.
- **Done-when #2 (redirect)** is proven client-side: the store starts `unauthenticated` (no token), so `<RequireAuth>` redirects regardless of the always-authenticated dev bypass backend.
- **Boundary:** MYT-83 does not implement OAuth, token refresh, the Cognito Hosted-UI flow, or the onboarding *screen* — only carrying/attaching a token, the three-state gate, and the smoke's register precondition. MYT-84 adds acquisition + the onboarding flow.

---

## 8. The i18n catalog relocation (a small refactor, not a file move)

Today `frontend/src/i18n/config.ts` does **both** the catalog import (`resources = { en: { common } }`) and the runtime init (`i18n.use(initReactI18next).init(...)`), and `i18next.d.ts` augments `declare module 'i18next'` by importing `resources`/`defaultNS` from `config.ts`. So this is a **split**, not a move:

- **To `client-core/i18n`:** the catalog JSON, a pure `resources`/`defaultNS` module, and the `CustomTypeOptions` typed-keys augmentation (which imports the relocated `resources`, **not** web's `config.ts`). `client-core` gains `i18next` as a dependency.
- **Stays in `web`:** `initReactI18next`, the `i18n.init()` call, and `<I18nextProvider>` (the web binding).
- **Invariants:** keep the init **synchronous** (no async backend without a `<Suspense>` boundary — load-bearing, documented in `config.ts`); keep the typed-keys guard (`typed-keys.guard.ts`) green across the new boundary. Its own task, because it touches the working i18n setup.

---

## 9. Testing & coverage

- **Unit tests** for the data layer (the endpoint primitive incl. the response-validation throw, the typed errors, the stores, `getAuthHeaders`, the SecureStorage web impl) with **MSW** (network-layer mocking; added to the toolchain). The api hooks/context live in `client-core`, whose Vitest env defaults to **`node`** — so `client-core` gains `environment: 'jsdom'` (or per-file `@vitest-environment jsdom`) + `@testing-library/react` for those tests, with the `maxWorkers: 3` RAM guard kept in lockstep and the api-purity lint's test-file carve-outs honored.
- **The real-backend smoke** (done-when #3): register the dev user, then the home hub rendering real `campaigns/mine` through the dev bypass, asserted at the wire level. Driven directly (the app against the real backend), not mocked.
- **Coverage.** Add the new logic dirs (`client-core/api/**`, `client-core/stores/**`, `client-core/platform/**`, any `web` data hooks) to the tiered coverage gate's `include` — **verify** the current gate config rather than assuming it already lists them. Presentational route stubs and the shell stay rendered-but-not-%-gated.

---

## 10. Out of scope (explicit)

- OAuth / Cognito token acquisition + refresh, and the onboarding *screen* → **MYT-84**.
- WS session client + SSE status streaming (the realtime *logic* + any runtime frame validation; the contracts move now) → **MYT-85**.
- Full content of any flow screen — MYT-83 ships **stubs** only (landing, campaign-create, character-create, play, settings, billing).
- Extracting the full ~50-endpoint REST surface — only the smoke's slice now; flows extend.
- Backend *outbound* response validation — MYT-83 only types the handler return against the schema.
- Combat renderer interface (R4) → Combat L2.

---

## 11. File structure (new/changed)

```
pnpm-workspace.yaml                        + register frontend/contract
.npmrc / frontend/vite.config.ts           + resolve.dedupe for react/react-dom/@tanstack/react-query
frontend/contract/                         NEW @mythrun/contract (package.json, tsconfig BUILD-emitting .js+.d.ts, exports map, own eslint config, zod dep)
  src/
    rest/users.ts, rest/campaigns.ts       AUTHORED wire-response schemas (ISO-string dates; /me public projection)
    events/session-events.ts               moved from backend/src/contract (TS unions, not Zod)
    events/pipeline-events.ts              moved from backend/src/contract
    index.ts
frontend/client-core/                      + zustand (dep), @tanstack/react-query (peer+dev), i18next (dep), jsdom + @testing-library/react (dev)
  src/
    domain/                                z.infer domain types (REST)
    api/endpoint.ts, api/errors.ts, api/client-context.tsx, api/users.ts, api/campaigns.ts, api/hooks.ts
    stores/session.ts                      Zustand three-state session store
    platform/secure-storage.ts             interface
    i18n/                                   relocated catalog + resources/defaultNS + typed-keys augmentation
  eslint.config.js                         + no-restricted-globals (client-core scope)
  vitest.config.ts                         + jsdom env for api tests
frontend/src/                              (@mythrun/web)
  app/                                     shell, providers, RequireAuth (3-state), the quiet frame, error boundary (typed-error branching), dithered 404
  routes/                                  stubs + the wired home hub
  platform/web/secure-storage.ts           localStorage impl
  app.tsx, main.tsx                        replace the placeholder; mount the router (main.tsx document use is lint-exempt)
  i18n/config.ts                           keep init + provider only; import resources from client-core
  eslint.config.js                         + feature import boundary (incl. react-query/fetch ban in routes/) + no-restricted-globals (web outside platform/web)
backend/Dockerfile                         COPY frontend/contract/ (manifest before install, source before build); build @mythrun/contract before backend
backend/src/contract/                      re-export the moved event unions from @mythrun/contract (shim)
backend/src/routes/users.ts, campaigns.ts  type handler returns against the @mythrun/contract response schemas
```

---

## 12. Risks & mitigations

- **(SHOWSTOPPER, fixed) The backend can't consume a source-`.ts` contract package — Docker/deploy crash.** The backend takes its first cross-package runtime dep here. NodeNext cannot import `.ts` across a package boundary, and the runtime (`node dist/server.js`, `pnpm deploy --prod`) has no `.js` for a source-only package; the `Dockerfile` never copies `frontend/contract/`. A `tsc`-green build would still ship a container that crashes on import. **Resolution (non-negotiable):** `@mythrun/contract` is a **built** package (tsc-emitted `.js` + `.d.ts` via an `exports` map); the `Dockerfile` copies `frontend/contract/` (manifest before `--frozen-lockfile` install, source before build) and builds the package **before** the backend; `pnpm deploy --prod` carries the built package. The package-setup task's acceptance bar includes a **container-boot smoke** (`docker build` + boot the backend image), not just "both tsc configs green." (`client-core`/Bundler may consume source or built; the backend forces built.)
- **`exactOptionalPropertyTypes` differs** between `backend` and `client-core` tsconfigs — schema-derived optional fields can typecheck differently on the two sides. Validate the package typechecks under both.
- **Moving the realtime contracts** could ripple to backend consumers. Mitigation: keep `backend/src/contract/` as a re-export shim; the drift-tested route list (`backend-routes.ts`) doesn't import them and is untouched.
- **i18n relocation** is a refactor with an inverted dependency (the typed-keys augmentation imports from `config.ts`). Mitigation: §8's split (augmentation imports the relocated `resources`, not `config.ts`); keep init synchronous and the guard green.
- **Single React-Query instance** under `inject-workspace-packages=true` — peerDep discipline **plus** Vite `resolve.dedupe` (§1).
- **Wire vs domain shape** (`Date` → ISO string) — response schemas model the wire (string) shape, not the repo `Date` type (§2).
```
