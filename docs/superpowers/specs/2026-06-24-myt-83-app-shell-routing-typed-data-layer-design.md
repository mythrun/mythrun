# MYT-83 — App Shell, Routing & Typed Data Layer — Design

> **Status:** Design approved in brainstorm 2026-06-24. Source of truth for the implementation plan.
> **Linear:** MYT-83 (Frontend milestone, Phase 1 "Plumbing", due 2026-06-25). Blocks MYT-84 (auth), MYT-85 (realtime), MYT-86 (landing). Depends on MYT-82 (mythrunUI).

## Goal

The application skeleton every flow hangs on: a React-Router shell (authenticated/public split + the quiet brand frame + a dithered 404), a typed REST data layer over the real backend, and the **portability structure** (R1/R5) that keeps the whole client portable to true-native later. The load-bearing constraint: **all of the data/state/transport layer is built into `@mythrun/client-core`, not `web/src`**, so there is never a later extraction refactor.

## Done when

1. Routes resolve; the route tree hosts stubs for every flow screen.
2. A protected route redirects to `/auth/signin` when unauthenticated.
3. A typed client call renders **real backend data** behind a loading state (the home hub fetching `campaigns/mine` against the running dev backend), proven by a wire-level smoke.
4. `tsc`, the frontend lint rails (incl. the new R1/R5 lints), `lint:css`, `story-coverage`, the tiered coverage gate, `build-storybook`, and the web build all pass.

---

## Decisions taken in the brainstorm

1. **Typed contract → a shared `@mythrun/contract` package** (not hand-written types, not codegen). Zod schemas are the single source; the backend imports them for validation, `client-core` derives types via `z.infer` and validates responses. `tsc` links both sides. Chosen for durability — a silent shape drift on these contracts (especially the realtime frames) is a nasty production bug.
2. **Move a thin slice now, not the whole API.** MYT-83 stands up the package, moves the already-isolated realtime event unions, and extracts REST schemas only for the endpoints the home-hub smoke needs. Each flow ticket extracts its own endpoints on the established pattern. **The pattern is enforced by construction** (see §6) so later flows can't drift from it.

---

## 1. Package architecture

Four packages; the "client brain" sits in the middle and is imported verbatim by the future native app.

```
@mythrun/contract   (NEW — types/Zod only)
    Zod schemas = the ONE contract.   backend ─┐     ┌─ client-core   (both import it; tsc links both sides)
                                                ▼     ▼

@mythrun/client-core   (the platform-agnostic "client brain" — DOM-FREE)
    contract/   component prop contracts          (existing, MYT-82)
    tokens/     palette generator                 (existing, MYT-82)
    domain/     domain types (z.infer from @mythrun/contract)
    api/        typed REST client + React-Query hooks (over universal fetch; validates with contract Zod)
    stores/     view-state (Zustand: auth/session presence) — DOM-free
    platform/   capability INTERFACES (SecureStorage now; more added as flows need them)
    i18n/       the catalog (keys + typed-keys) — relocated here per R1
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
- `@mythrun/contract` depends on nothing internal (Zod only). Consumed by `@mythrun/backend` and `@mythrun/client-core`.
- `client-core` adds `zustand` and `@tanstack/react-query` as deps; `react` stays a peerDep (from MYT-82); **`@tanstack/react-query` is a peerDep provided by the app** so there is exactly one query-client instance and one React-Query module (no dual-instance context mismatch).
- Resolution: the contract package must typecheck from **both** the backend (NodeNext) and the frontend (Bundler). The package-setup task resolves this concretely — preferred path is shipping built `.d.ts` + `.js` via an `exports` map; if source-consumption works for both `tsc` configs, no build step. This is a task acceptance criterion, not left to chance.

---

## 2. The shared `@mythrun/contract` package

- One Zod schema per endpoint's request and response. The backend re-points its (currently inline, per-route) validation to import these, so the schema *itself* is the single source.
- **MYT-83's slice:**
  - The realtime event unions move over wholesale — `session-events.ts` (`ClientFrame`/`ServerFrame`) and `pipeline-events.ts` (`PipelineEvent`/`ProseEvent`) — they already live isolated in `backend/src/contract/`, so this is a cheap move that sets up MYT-85. The backend's `backend/src/contract/` re-exports from the package (no behavior change; the drift-tested route list stays put).
  - REST schemas for exactly the endpoints the smoke needs: `GET /api/users/me` (the session user) and `GET /api/campaigns/mine` (the home hub). Extracted from their route files into the package; the routes import them back.
- Frontend types come from `z.infer`. No types are hand-declared for a covered endpoint.

---

## 3. The typed data layer

Data path:

```
@mythrun/contract (Zod)  →  client-core/api (defineEndpoint + hooks)  →  React Query  →  thin screen
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

  The returned function builds the URL, attaches auth headers (§7), calls universal `fetch`, then **parses and validates the response against `response`** — a backend drift fails loudly in dev rather than corrupting state. `request`/`response` are required and typed as Zod schemas, so an endpoint *cannot* be defined without contract schemas. That is the conformance lever (§6).

- **Transport.** REST uses universal `fetch` directly (R1 permits `fetch`; it exists on web and native alike). No transport interface is needed for REST — the platform-divergent streaming transports (SSE/WS) are MYT-85's concern.

- **Hooks.** Thin React-Query hooks (`useMe`, `useMyCampaigns`) wrap the endpoint functions and live in `client-core/api` (they're React, not DOM → R1-clean; native reuses them). They read a configured client from a `client-core` React context.

- **Wiring.** `web/app` constructs the configured API client (base URL + the injected `SecureStorage` web impl + the auth-mode config) and provides it via the context, alongside the `QueryClientProvider` and its `QueryClient` instance.

- **Loading/error conventions.** Screens render data behind `<Suspense>` with React-Query's suspense mode; a route-level error boundary catches fetch/render failures. The home hub demonstrates the full loading → data path; other screens are stubs.

---

## 4. Routing & the shell

- **The split (React Router).** A root with two branches:
  - **Public:** `/` (landing), `/auth/*` (sign-in, OAuth callback), `/join/:code` (invite), `/campaigns/:id/recap` (shareable recap).
  - **Authed:** under a `<RequireAuth>` boundary that redirects to `/auth/signin` when there is no session. Children: `/home`, `/campaigns/new`, `/campaigns/:id/character/new`, `/campaigns/:id/play`, `/settings`.
- **Screens.** Every screen is a thin **stub** the flow tickets fill — except the **home hub**, wired end-to-end (`useMyCampaigns` → real backend → loading state) for the done-when smoke.
- **The quiet brand frame** (per brand `decisions.md`, "frame vs content"). Authed routes render inside a persistent, minimal frame — a quiet header (logo · display name · credits + quick-buy · settings) wrapping the content `<Outlet/>`. The frame recedes; content is the focus. The play route adds its collapsible sidebar later (MYT-92). Composed from mythrunUI only (R5).
- **404 + errors.** A **dithered 404** (the `Dither` component as a full-bleed treatment — its first product use) and a route-level error boundary for unexpected failures.
- **Providers** (`web/app`). The stack — `QueryClientProvider`, the API-client context, `I18nextProvider`, the auth/session provider — wraps the router. The **`platform/web` impls are constructed here** (SecureStorage → localStorage) and injected into `client-core`, so the brain never touches a web global itself.

---

## 5. Platform interfaces (R1) — scoped by YAGNI

- **Defined now:** `SecureStorage` — the token store.

  ```ts
  // client-core/platform/secure-storage.ts  (sketch)
  interface SecureStorage { get(k): Promise<string|null>; set(k, v): Promise<void>; remove(k): Promise<void> }
  ```

  Web impl `web/platform/web/secure-storage.ts` over `localStorage` (the web baseline for a JWT absent an httpOnly cookie; the *name* signals intent — the later native impl uses Keychain/Keystore). This one interface + its impl **establishes the `platform/web` convention** the issue asks us to decide.
- **Deferred (added by the ticket that first needs them):** `StreamingFetch` (SSE) and the WS transport → MYT-85; `Share`, `Push`, `DeepLink`, `Clipboard`, `Locale` → their flow tickets. We do not define interfaces with no consumer.

---

## 6. Enforcement — R1/R5, and conformance by construction

This is the answer to "make sure future flows conform to the standard we set now": conformance is **structural**, not a convention a flow could quietly skip.

- **Contract conformance by construction.** The only way to make a backend call is `defineEndpoint`, whose `request`/`response` are typed as Zod schemas imported from `@mythrun/contract`. A flow adding an endpoint physically must add that endpoint's schema to the contract package first — there is no path around the primitive's type signature. No flow can hand-write a one-off type and skip the contract.
- **`no-restricted-globals` (R1).** Bans `document, window, localStorage, sessionStorage, location, navigator, EventSource` in `client-core` **and** in `web` outside `platform/web/**`. `fetch`/`WebSocket` stay allowed (universal). Platform access flows only through interfaces. Ships with +/- wiring tests (a banned global fails; a `platform/web` use passes).
- **Feature import boundary (R5, deferred from MYT-82).** Route/feature dirs may import only `@mythrun/client-core`, `@mythrun/ui`, and i18n — not `react-dom`/Radix/CVA/etc., not each other's internals, not deep `@mythrun/ui/src/*`. Implemented by extending the existing `no-restricted-imports` rail (and/or `eslint-plugin-boundaries`) keyed off the `routes/` structure MYT-83 creates.
- **Carried over from MYT-82:** `no-ad-hoc-ui`, `no-ad-hoc-color`, `api-purity`, `no-untranslated-jsx-text` / i18n — all still apply. Net: a flow *cannot* put data logic in `web`, type outside the contract, drop in raw UI, hardcode a color, or ship an untranslated string.

---

## 7. Auth — for now (MYT-84 fills the real thing)

- The API client attaches auth via an injected `getAuthHeaders()`:
  - **dev** (`AUTH_MODE=bypass`): `x-mythrun-dev-sub: <sub>` (header-based bypass the dev backend accepts).
  - **prod:** `Authorization: Bearer <token>` read from `SecureStorage`.
  - Selection is a build/runtime config flag, not request-time logic.
- The **session store** (`client-core/stores`, Zustand) holds session presence (`authenticated | unauthenticated | unknown`) and drives `<RequireAuth>`. MYT-83 seeds the dev path so the smoke runs **and** an unauthenticated state is reachable to prove the redirect. MYT-84 adds the OAuth acquisition that writes the real token to `SecureStorage` and flips the store.
- **Boundary:** MYT-83 does not implement OAuth, token refresh, or the Cognito Hosted-UI flow — only carrying/attaching a token and gating on its presence.

---

## 8. The i18n catalog relocation

Move the catalog (`locales/en/common.json` + the typed-keys augmentation) from `web/src/i18n` into `client-core/i18n` (R1: the catalog lives in the brain). The `i18next` runtime config + `<I18nextProvider>` stay in `web` (the web binding). **Care:** the synchronous init is load-bearing — keep it synchronous, do not introduce an async backend without a `<Suspense>` boundary. Low-risk move (JSON + types), but it touches the working i18n setup, so it is its own task with the typed-keys guard kept green.

---

## 9. Testing & coverage

- **Unit tests** for the data layer (the endpoint primitive, the stores, `getAuthHeaders`, the SecureStorage web impl) with **MSW** (network-layer mocking — realistic; MSW gets added to the web/client-core toolchain). The endpoint primitive's response-validation path is tested (a malformed response throws).
- **The real-backend smoke** (the done-when): the home hub rendering real `campaigns/mine` through the dev bypass against the running backend, asserted at the wire level (the request fires with the dev-sub header; real rows render). Per project rule, this is driven directly (the app against the real backend), not mocked.
- **Coverage.** The new logic dirs (`client-core/api/**`, `client-core/stores/**`, `client-core/platform/**`, and any `web` data hooks) join the tiered coverage gate's `include` (the gate already anticipates `api/**`, `transport/**`, etc.). Presentational route stubs and the shell stay rendered-but-not-%-gated.

---

## 10. Out of scope (explicit)

- OAuth / Cognito token acquisition + refresh → **MYT-84**.
- WS session client + SSE status streaming (the realtime *logic*; the contracts move now) → **MYT-85**.
- Full content of any flow screen — MYT-83 ships **stubs** only (landing, campaign-create, character-create, play, settings, billing).
- Extracting the full ~50-endpoint REST surface — only the smoke's slice now; flows extend.
- Combat renderer interface (R4) → Combat L2.

---

## 11. File structure (new/changed)

```
frontend/contract/                         NEW @mythrun/contract package (package.json, tsconfig, exports)
  src/
    rest/users.ts, rest/campaigns.ts       moved/extracted REST schemas (the slice)
    events/session-events.ts               moved from backend/src/contract
    events/pipeline-events.ts              moved from backend/src/contract
    index.ts
frontend/client-core/src/
  domain/                                  z.infer domain types
  api/endpoint.ts, api/client-context.tsx, api/users.ts, api/campaigns.ts, api/hooks.ts
  stores/session.ts                        Zustand session store
  platform/secure-storage.ts               interface
  i18n/                                     relocated catalog + typed-keys
  eslint-rules / eslint.config.js          + no-restricted-globals (client-core scope)
frontend/src/                              (@mythrun/web)
  app/                                     shell, providers, RequireAuth, the quiet frame, error boundary, 404
  routes/                                  stubs + the wired home hub
  platform/web/secure-storage.ts           localStorage impl
  app.tsx, main.tsx                        replace the placeholder; mount the router
  eslint.config.js                         + feature import boundary + no-restricted-globals (web outside platform/web)
backend/src/contract/                      re-export the moved event unions from @mythrun/contract
backend/src/routes/users.ts, campaigns.ts  import the slice schemas from @mythrun/contract
```

---

## 12. Risks & mitigations

- **Contract resolution across NodeNext + Bundler** — the one real setup risk. Mitigation: it's the first task, with "both `tsc` configs green against the package" as the acceptance bar; fall back to a built `.d.ts`/`.js` `exports` map if source-consumption resists NodeNext.
- **Moving the realtime contracts** could ripple to backend consumers. Mitigation: keep `backend/src/contract/` as a re-export shim so import sites don't churn; the drift-tested route list (`backend-routes.ts`) is untouched.
- **i18n relocation** touching load-bearing synchronous init. Mitigation: isolated task, keep init synchronous, keep the typed-keys guard green.
- **Single React-Query instance** — peerDep discipline (the app provides `@tanstack/react-query`) avoids dual-instance context bugs.
```
