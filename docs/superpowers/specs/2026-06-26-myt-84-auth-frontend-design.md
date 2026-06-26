# MYT-84 — Auth Frontend (OAuth → Cognito → JWT) — Design

**Goal:** Wire the real sign-in flow — Google/Discord OAuth via Cognito Hosted UI → an **in-memory access token + an httpOnly-cookie refresh** → protected-route enforcement → a one-input display-name onboarding → the Hub. Carries the small backend `session`/`refresh`/`logout` endpoints the token model needs. This lights up the authed app on the live staging site (MYT-96), where authed routes currently redirect to sign-in.

**Status:** approved in brainstorm (MYT-84); refined by a 4-lens blind review (security / backend / frontend / UX). Two user-facing decisions made with Miklos: the token model (in-memory access + httpOnly-cookie refresh) and the onboarding shape (one input — display name, derive the username). Google/Discord OAuth secrets are configured (Miklos).

---

## 1. Context — what exists, what MYT-84 fills

The auth **substrate is built and tested**; MYT-84 fills the frontend acquisition seam plus the backend session endpoints the cookie model needs.

**Built — do NOT rebuild:**
- **Backend JWT verification** (`backend/src/auth/jwt-plugin.ts`): verifies the Cognito **access** token (`tokenUse:'access'`, audience = the app `client_id`), trusts `payload.sub` as the immutable user id, requires `Authorization: Bearer <access token>`. `requireOnboarded` (`backend/src/auth/require-onboarded.ts`) → `403 {code:'username_required'}` on first login (no `users` row), `403 {code:'account_suspended'}` if suspended, else attaches `request.dbUser`.
- **User endpoints** (`backend/src/routes/users.ts`): `GET /api/users/me` (403 `username_required` first login); `POST /api/users/register` (`username` `/^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/` len 3–20, `displayName` 1–40, `jwt-no-db`, **5/min/sub**) — returns specific codes: `username_taken` (409, **carries a server `suggestion`**), `username_invalid:format` (400), `username_invalid:<profanity>` (400), `display_name_invalid` (400), `already_onboarded` (409, carries `currentUsername`), `already_onboarded_same` (200); `GET /api/users/check-username` (advisory, `jwt-no-db`, **10/min**).
- **The public-route allowlist** (`backend/src/auth/public-route-allowlist.ts`): `config.auth:'public'` early-returns out of BOTH `jwtPlugin.onRequest` and `requireOnboarded.preHandler` (the correct bypass for pre-login routes), but `PUBLIC_ROUTE_ALLOWLIST` is a **closed allowlist enforced at `app.ready()`** — a `public` route not in the set throws at boot. The new auth routes must be added there (§4). No global form-body parser is registered (`app.ts` imports no `@fastify/formbody`) — load-bearing for the login-CSRF defense (§5).
- **Cognito** (`infra/modules/auth/`): Hosted UI domain `mythrun-staging.auth.us-east-1.amazoncognito.com`; Google + Discord (generic OIDC) IdPs; app client = **public SPA + PKCE, authorization-code grant only**, scopes `openid email profile`, refresh-token rotation **enabled** (`retry_grace_period_seconds = 0`), token revocation **enabled**, access/id TTL 60m, refresh 30d. **Real OAuth secrets configured.**
- **Frontend seams**: `frontend/src/main.tsx` (`authMode:'jwt'|'bypass'`); the session store `client-core/src/stores/session.ts` (currently `unauthenticated`|`onboarding-required`|`ready`, holds `sub`, **no token** — MYT-84 adds a 4th `initializing` state, §3); `RequireAuth` (routes on status only, **synchronous** redirect on `unauthenticated`); the `signin`/`callback`/`onboard` route stubs; `getAuthHeaders` (jwt mode); the single transport seam `client-core/src/api/endpoint.ts` (`buildInit`→`send`; runs `spec.request.safeParse` locally before the network call, throws `HttpError(status, statusText)` on non-2xx **reading the body only on `res.ok`**); `getMe`/`useMe` **suspense** endpoint; QueryClient default `retry:1` (`providers.tsx`).

**Preconditions:**
- **GAP-A (in scope):** Cognito callback/logout URLs are localhost-only (`infra/environments/staging/main.tf:154-155`). Add **exactly** `https://staging.mythrun.com/auth/callback` (callback) + `https://staging.mythrun.com` (logout) — a TF change; the URL must match the router's bare `/auth/callback` (§3) for Cognito's exact-match `redirect_uri`. Without it OAuth only completes from `localhost:5173`.
- **GAP-D:** RESOLVED — real Google/Discord OAuth apps registered, secrets in Secrets Manager.
- **GAP-B (in scope):** the `POST /api/auth/{session,refresh,logout}` endpoints don't exist; built here (incl. `@fastify/cookie` dependency + the allowlist entries).
- **GAP-C (in scope):** no `RegisterRequest`/`CheckUsername` contract schemas or client-core endpoints; added here.
- **GAP-E (note):** Cognito rotation `retry_grace_period_seconds = 0` → a concurrent multi-tab refresh logs the second tab out (§5). Recommended: set a ~30–60s grace window (small TF change) — folded into this ticket's infra task.

---

## 2. Architecture — the flow (BFF pattern; the SPA never holds the refresh token)

```
APP BOOT (jwt mode)
0. Session store default = `initializing`. RequireAuth renders a neutral splash while initializing
   (it does NOT redirect). A bootstrap step runs the on-load refresh attempt (see RETURNING USER),
   then transitions the store to ready / onboarding-required / unauthenticated. Only after that does
   RequireAuth redirect. (Bypass mode still seeds `ready` directly, unchanged.)

SIGN-IN
1. Sign-in screen: "Continue with Google" / "Continue with Discord" (mythrunUI buttons, quiet register).
2. Click → SPA generates a CSPRNG PKCE code_verifier + an opaque CSPRNG `state` (carrying provider +
   a validated-local return-to), stores them in sessionStorage, → redirects to the Cognito Hosted UI with
   identity_provider=<Google|Discord>, code_challenge, the bare redirect_uri, scope, state.
3. Cognito → Google/Discord OAuth → redirects to /auth/callback?code=…&state=….
4. Callback screen: verify `state` matches sessionStorage (CSRF) + re-validate return-to is a local path,
   POST { code, codeVerifier } → backend POST /api/auth/session  (fetch credentials:'include').
5. Backend exchanges {code, codeVerifier, redirect_uri} at Cognito /oauth2/token  (redirect_uri derived
   server-side = `${frontendBaseUrl}/auth/callback`, exact match) →
     • refresh_token → cookie: HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=30d; host-only
       (no Domain)  (set by the API; JS never sees it)
     • returns { accessToken, expiresIn, name }   (name parsed from the id_token `name` claim → pre-fill)
6. SPA holds accessToken IN MEMORY (the token manager; the jwt getAuthHeaders reads it).
7. Session adapter calls GET /api/users/me →
     200                       → setReady(sub)             → return-to (default: Hub)
     403 username_required     → setOnboardingRequired(sub) → /auth/onboard  (carry pre-fill name + return-to)
     403 account_suspended     → setUnauthenticated         → suspended screen

ONBOARD (first sign-in only)
8. "What should we call you?" — ONE input (clamped to 40), pre-filled from `name`, ethereal fade-in.
9. Submit → derive a regex-valid username (§6) → probe check-username → POST /api/users/register
   { username, displayName } → setReady → return-to (the return-to survives the onboard detour, §7).

REFRESH:  defineEndpoint, on a 401 from a NON-auth call (or proactively before `expiresIn`), awaits the
          single-flight POST /api/auth/refresh (credentials:'include') → backend reads the cookie → Cognito
          refresh-grant → re-sets the ROTATED refresh cookie → new accessToken → rebuilds the request init
          (fresh Bearer) and retries ONCE. The auth endpoints themselves are exempt from this wrapper.
RETURNING USER:  the boot bootstrap calls POST /api/auth/refresh; success → fresh accessToken → /me → the
          SAME ready/onboarding-required mapping as step 7; failure (no/invalid cookie) → unauthenticated.
LOGOUT:  POST /api/auth/logout → backend revokes (Cognito) + clears the cookie (attributes mirror the set) →
          drop the in-memory token → setUnauthenticated → landing.
```

---

## 3. Decisions

- **Token model:** in-memory access token + httpOnly-cookie refresh (Auth spec §3/§6). The SPA never persists the refresh token (XSS-exfil resistant). *Rejected:* tokens in localStorage (the scaffold placeholder; spec-forbidden XSS risk).
- **BFF exchange:** the **backend** exchanges the authorization code (`POST /api/auth/session`) and sets the refresh cookie; the SPA hands over only `{code, codeVerifier}` and receives only the access token. The refresh token never enters JS. *Rejected:* SPA-side token exchange then POST-the-refresh-to-a-cookie endpoint (the refresh token transits JS).
- **`initializing` session state (NEW):** the jwt-mode default is a 4th `initializing` state; `RequireAuth` renders a neutral splash (not a redirect) while initializing; the boot bootstrap runs the on-load refresh and only then transitions. This is what makes "reload persists → straight to Hub" work without the synchronous `RequireAuth` redirect racing the async refresh. *Rejected:* awaiting the refresh in `main.tsx` before `createRoot` (blocks first paint on a network round-trip).
- **Onboarding:** ONE input (display name, pre-filled from the `id_token name` claim). The backend-required `username` is **derived frontend-side, regex-valid by construction** (§6) and never shown — a system handle. *Rejected:* two inputs (display name + chosen @handle) — diverges from UX §3's single gentle moment. (Note: `@username` surfaces in app chrome per Auth spec §4 once member-list/settings land — keeping it derived/hidden is a conscious MYT-84 decision; a change-handle surface is a future ticket.)
- **Callback route:** a **single bare `/auth/callback`** (matches Cognito's exact-match `redirect_uri`); the provider + return-to ride the OAuth `state`. The router's current `/auth/callback/:provider` collapses to `/auth/callback` — this router edit and the GAP-A TF callback URL are a **matched pair**. *Rejected:* registering per-provider callback URLs.
- **Cookie posture + the same-site / cross-origin distinction:** the SPA (`staging.mythrun.com`) → API (`staging-api.mythrun.com`) hop is **same-SITE** (same registrable domain `mythrun.com`) so a `SameSite=Lax` host-only cookie IS sent on credentialed requests — but it is **cross-ORIGIN** (different subdomain), so it needs BOTH the server CORS flip (`credentials:true`, single origin = `frontendBaseUrl`) AND the client setting `credentials:'include'` on the auth fetches. Cookie attrs: `HttpOnly; Secure; SameSite=Lax; Path=/api/auth; Max-Age=30d`; **host-only (no `Domain`)** — do not add `Domain=.mythrun.com` (would broaden to every sibling subdomain).

---

## 4. Components

### Frontend (`@mythrun/web` + `@mythrun/client-core`)
- **Sign-in screen** (`frontend/src/routes/signin.tsx`) — two mythrunUI buttons; each builds the Cognito authorize URL (via the OAuth helper) and navigates. Responsive + i18n.
- **OAuth/PKCE helper** (`client-core/src/auth/`) — `createPkce()` (CSPRNG code_verifier ≥128 bits + S256 code_challenge), `createState({provider, returnTo})` (CSPRNG opaque, sessionStorage-persisted, single-use), `isLocalPath(returnTo)` (leading single `/`, reject `//`, `/\`, any `scheme:` — open-redirect guard), `buildAuthorizeUrl(...)`, `parseCallback(search)` (validate state, extract code). Pure + unit-tested.
- **Callback handler** (`frontend/src/routes/callback.tsx`) — verify state + re-validate return-to → `POST /api/auth/session` → token manager stores the access token → run the session adapter → navigate. **Re-persists `returnTo`** (router location state or a dedicated key) so it survives an onboard detour (§7). Guarded against StrictMode double-invoke (a ref/module dedup — single-use code).
- **Onboard screen** (`frontend/src/routes/onboard.tsx`) — one input (clamped 40), pre-filled `name` (may be empty → graceful), ethereal fade-in; submit → derive username (§6) → `register` → `setReady` → return-to. i18n + mythrunUI + responsive.
- **Token manager** (`client-core/src/auth/token-manager.ts`) — holds the access token in a module-scoped variable (NOT storage); `getAccessToken()`, `setAccessToken(token, expiresIn)`, `clear()`; **one module-level `refreshPromise`** (single-flight: concurrent 401s share it; cleared on settle). The jwt `getAuthHeaders` reads `getAccessToken()` (drop `secureStorage`/`AUTH_TOKEN_KEY` from the jwt path).
- **`defineEndpoint` changes** (`client-core/src/api/endpoint.ts`) — (a) on non-2xx, read the error JSON body and attach its `code` to `HttpError` (`readonly code?: string`); (b) add opt-in `EndpointSpec` fields `credentials?: 'include'` (threaded into `buildInit`) and `skipAuthRetry?: boolean`; (c) the **refresh-on-401 retry lives here** (it observes the response, which `getAuthHeaders` cannot): on 401 from a non-`skipAuthRetry` call → await the single-flight refresh → if it succeeded, **re-run `buildInit`** (fresh Bearer) and `send` once more.
- **Session adapter** (`client-core/src/auth/session-adapter.ts`) — the `/me` → state mapping, applied IDENTICALLY on the callback path AND the on-load bootstrap: `200`→`setReady`; `403 && code==='username_required'`→`setOnboardingRequired`; `403 && code==='account_suspended'`→`setUnauthenticated`+suspended screen. `useMe` is NEVER the onboarding-discovery seam — the adapter settles the store before the Hub's `useMe` runs.
- **Session store + RequireAuth** — add the `initializing` state (§3); `RequireAuth` renders a splash while `initializing` (no redirect). The QueryClient gets a retry predicate that **skips `HttpError` 4xx** (so the auth retry is the only retry and a 4xx doesn't double-fire).
- **Logout action** — settings/header → `POST /api/auth/logout` (credentials:'include') → clear token → `setUnauthenticated` → landing.

### Backend (`@mythrun/backend`, co-designed in this ticket)
- **`@fastify/cookie`** added as a dependency and registered before the auth routes; the cookie helper uses `setCookie`/`clearCookie` with the §3 attributes (clear MUST mirror `Path=/api/auth` + Secure/SameSite, no Domain).
- **PUBLIC_ROUTE_ALLOWLIST** gains `POST /api/auth/session`, `POST /api/auth/refresh`, `POST /api/auth/logout` (the file's own contract requires a security-review note on the edit). Each carries a per-IP `config.rateLimit` (the plugin is registered global-off; opt in — ~10–20/min; default keyGenerator = `request.ip`, correct under `trustProxy:1`).
- `POST /api/auth/session` — **accepts `application/json` only (415 on other content types)**; body `{code, codeVerifier}`; exchange at Cognito `/oauth2/token` (`grant_type=authorization_code`, PKCE, **`redirect_uri` derived server-side** = `${frontendBaseUrl}/auth/callback`); parse the id_token for `name`; set the refresh cookie; return `{accessToken, expiresIn, name}`.
- `POST /api/auth/refresh` (reads the cookie) — Cognito `grant_type=refresh_token`; **re-set the ROTATED refresh token in the cookie** (rotation is enabled); return fresh `{accessToken, expiresIn}`. 401 + clear cookie if the refresh token is invalid/expired.
- `POST /api/auth/logout` — Cognito token revocation + clear the cookie; 204.
- `app.ts`: CORS `credentials:true` (single origin `frontendBaseUrl`; existing allowedHeaders/methods already cover the JSON POSTs). The Cognito token + revoke endpoints are derived from `COGNITO_HOSTED_UI_DOMAIN` (confirm it's a bare host → prepend `https://`).

### Contract (`@mythrun/contract`)
- `RegisterRequestSchema` (`{username, displayName}` mirroring the backend **structure only** — length + regex; profanity is server-only), `CheckUsernameResponseSchema`, `SessionResponseSchema` (`{accessToken, expiresIn, name}`), `RefreshResponseSchema`. Client-core endpoints: `register`, `checkUsername`, `createSession`, `refreshSession`, `logout` (the last three set `credentials:'include'` + `skipAuthRetry`). Because the contract validates structure locally before the network call, retry/error handling must span BOTH the local `ContractValidationError` and the remote `HttpError` — moot for `username` once §6 makes derivation valid-by-construction.

---

## 5. Security

- **PKCE** (public client, no secret) on every authorize → token exchange. **`state`** is the callback CSRF guard: CSPRNG (`crypto.getRandomValues`, ≥128 bits), sessionStorage-persisted, verified on callback, single-use. It carries provider + return-to — both routing-only, never trusted otherwise.
- **Open-redirect guard:** `returnTo` (seeded from a query param on `/signin` and `/join`) MUST be validated as a local relative path before ANY navigation — leading single `/`, reject `//`, `/\`, any `scheme:` — else fall back to the Hub. Unit-test `//evil.com`, `https://evil.com`, `javascript:`, `/\evil.com`, and a valid `/join/x`.
- **Login-CSRF / session-fixation on `POST /api/auth/session`:** `state` is verified client-side only, so the endpoint's defense rests on **CORS preflight + content-type**: it accepts `application/json` ONLY (asserts 415 otherwise) and the app registers **no form-body parser**, so a cross-origin `text/plain`/form POST cannot deliver a body and a JSON POST is preflight-blocked. Make this an explicit, tested invariant — and document that adding a global form-body parser later would break it.
- **Refresh token: httpOnly + host-only** — an XSS payload cannot read or exfiltrate it; host-only (no `Domain`) keeps it off sibling subdomains. **Access token: in-memory only** — not in localStorage/sessionStorage; lost on reload (recovered via the refresh cookie). The `id_token` is parsed backend-side for `name` only and never handed to JS.
- **Backend trusts the access token's `sub`** (immutable); never the Cognito `username` claim, for identity. `Authorization: Bearer` carries the **access** token (not id).
- **Rotation:** each refresh rotates the cookie (the rotated token is re-set); the prior token is invalidated. **GAP-E:** with `retry_grace_period_seconds = 0`, two tabs refreshing concurrently → the second is logged out; set a ~30–60s grace window (TF) to absorb the multi-tab race. **Logout** revokes at Cognito + clears the cookie; the already-issued access JWT stays valid until `exp` (≤60m) — accepted JWT tradeoff (not instant revocation), documented so it isn't mistaken for one.
- **CORS** `credentials:true`, single origin `frontendBaseUrl` (never `*`); the cookie is `Path=/api/auth` (sent only to the auth endpoints), `Secure`, `SameSite=Lax`. A true cross-site POST to `/refresh`/`/logout` is Lax-blocked; a compromised `*.mythrun.com` sibling is same-site (assumption: no untrusted content on a mythrun.com sibling), but CORS prevents reading the rotated token, bounding sibling impact to forced-logout/harmless-rotation.
- **Dev story:** local dev runs `bypass` mode (the `x-mythrun-dev-sub` header), seeds `ready` directly, and never touches the cookie/refresh path; the cookie model is jwt-mode (staging/prod) only.

---

## 6. Onboarding + username derivation

UX §3 is one input ("What should we call you?") — and the derived/hidden handle is *aligned* with it (UX §3 step 3 is literally a single display-name input), not a divergence. The backend still needs a `username` matching `/^[a-zA-Z0-9](?:[a-zA-Z0-9_]{1,18}[a-zA-Z0-9])?$/` (len 3–20, first/last char alphanumeric, no length-2). The frontend derives a **valid-by-construction** handle:

1. `slug = lowercase(displayName)`, strip to `[a-z0-9_]`, collapse underscore runs, **trim leading/trailing underscores**.
2. If `slug` is empty / all-underscore / `< 3` after trimming → `slug = "player_" + <short-random-alphanumeric>`. Else if `len < 3`, pad with random **alphanumeric** (never `_`).
3. Truncate to 20 **keeping the last char alphanumeric** (trim a trailing `_` left by truncation).
4. The result is regex-valid by construction; retry is then only ever needed for a genuine **collision**.

**Probe-then-register:** call `check-username` (10/min) to find a free candidate, then `register` (5/min) ONCE — never burn the register limit on a uniquify loop; cap candidate attempts ≤3; model the 429.

**Register error taxonomy** (don't treat all 4xx as "retry suffix"):
- `username_taken` (409) → retry using the server-provided `suggestion`.
- `display_name_invalid` (400) → surface inline on the display-name input (the user's only visible, fixable field) — never hide behind a retry.
- `username_invalid:format` / `:<profanity>` (400) → re-derive a fresh handle (rare once valid-by-construction; profanity can't be mirrored client-side).
- `already_onboarded` (409, has `currentUsername`) / `already_onboarded_same` (200) → the user IS onboarded → `setReady` → return-to (do not loop).
- All-retries-exhausted → a friendly i18n error (rare).

The contract mirrors username **structure** only; a local `ContractValidationError` and a remote `HttpError` are both possible and both handled.

---

## 7. Invite handoff

`/join/:code` is public (`GET /api/invites/:code/preview` is `auth:'public'`). An unauthenticated invitee: sees the join preview → "sign in to join" → the OAuth flow with `returnTo=/join/:code` in the `state` → callback. **The dominant case is a first-time invitee** (you invite people without accounts), who routes callback → `/auth/onboard` → register. Because `state` is single-use and consumed at the callback, the callback **re-persists `returnTo`** (router location state or a dedicated key) so it survives the onboard detour; `onboard` reads it on `setReady`. So `return-to` is preserved through **BOTH** the OAuth redirect AND the onboard detour → the invitee lands back at `/join/:code` → `accept` → into the campaign. (The accept + party-assembly UI is MYT-91; MYT-84 owns getting the authed+onboarded user back to the deep link.)

---

## 8. Done when / deferred

**Done when:** a real **Google** AND a real **Discord** sign-in each land on the Hub with a valid session; a page reload persists the session (the `initializing` splash → on-load refresh → straight to Hub, no sign-in bounce); protected routes gate (unauthenticated → sign-in, onboarding-required → onboard); logout returns to the landing page and clears the server cookie; the onboarding moment captures the display name (a regex-valid username derived, even for edge display names); a first-time invitee lands back at `/join/:code`. Verified on `staging.mythrun.com` (the authed app reachable behind the gate).

**Deferred (out of scope):** prod callback URLs / the prod-auth compose; the custom auth domain `auth.mythrun.com` (cosmetic — the SPA uses the cognito-managed Hosted UI domain); email/password (OAuth-only per UX §3); a user-facing handle-change surface; instant access-token revocation (denylist).

---

## 9. Constraints

- **Core auth/security infra — no shortcuts.** Refresh token httpOnly + host-only; access token in-memory; PKCE + CSPRNG `state` everywhere; `returnTo` validated local; the auth endpoints `application/json`-only + rate-limited + in the public allowlist; the backend verifies the access token + trusts `sub`.
- **The client sends `credentials:'include'`** on the auth fetches (the cross-origin half of the cookie model); the auth endpoints are exempt from the refresh-on-401 retry.
- **All UI in mythrunUI**, responsive (desktop + mweb), **i18n only** (no hardcoded strings; `[ph_*]` placeholders for prose, real values only for generic chrome). The sign-in/onboard screens pass the 375/1280 overflow gate.
- Backend data access through the repository layer; contract additions through `@mythrun/contract` (structure-only mirror); the Cognito token/revoke URLs derived from existing env (`COGNITO_HOSTED_UI_DOMAIN`), no new secret in git.

---

## 10. Testing

- **Unit (frontend):** the PKCE/state helper (CSPRNG, validation); `isLocalPath` (`//evil.com`, `https://evil.com`, `javascript:`, `/\evil.com`, valid `/join/x`); the token manager (in-memory hold + single-flight `refreshPromise` coalescing concurrent 401s + one retry + rebuild-init); `defineEndpoint` (error-body `code` on `HttpError`; `skipAuthRetry` exemption; 4xx-skip retry predicate); the session adapter (`/me` 200→ready, 403 username_required→onboarding, account_suspended→suspended, on BOTH callback and on-load); the username derivation edge matrix (`Bo`→valid, `_bob`/`bob_`→trimmed-valid, `___`→`player_*`, CJK/emoji→`player_*`, 40-char clamp); the `initializing`-state bootstrap (no `RequireAuth` bounce while initializing).
- **Backend integration:** `session`/`refresh`/`logout` against a mocked Cognito `/oauth2/token` — the code+`redirect_uri` exchange, the cookie set with full attrs + clear mirroring them, the ROTATED-refresh re-set, the 401-on-bad-refresh + cookie clear, **415 on non-JSON** (login-CSRF), the allowlist boot (app `ready()` doesn't throw), the per-IP rate limit, CORS credentials.
- **Frontend gates:** typecheck + lint + test + the Storybook overflow gate on the sign-in/onboard screens + a Miklos visual audit (HOLD the push for it).
- **E2E (the done-when):** a real **Google** AND a real **Discord** sign-in → the Hub, against staging Cognito (needs GAP-A's callback URL); assert **reload re-hydrates over the wire** (not a mock); verify the `name` pre-fill populates for both providers (Google emits `name` directly; confirm the Cognito mapping yields non-empty, else the moment gracefully no-ops); a first-time-invitee path lands at `/join/:code`. This is the real-credential smoke that proves the wire, not a mock.
```
