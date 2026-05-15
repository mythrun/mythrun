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
| POST /api/users/register | (exempt — exercised by harness bootstrap + main.ts self-bootstrap) | — |
| GET /api/users/check-username | users | fetch-on-mount |
| GET /api/users/me | users | fetch-on-mount |
| POST /api/campaigns | campaign-create | action-only |
| GET /api/campaigns/mine | my-campaigns | fetch-on-mount |
| GET /api/campaigns/:campaignId | campaign-details | event-driven |
| DELETE /api/campaigns/:campaignId | campaign-details | event-driven |
| POST /api/campaigns/:campaignId/resume | campaign-details | event-driven |
| GET /api/campaigns/:campaignId/status | status | event-driven |
| GET /api/campaigns/:campaignId/status/stream | status, live-events | event-driven |
| POST /api/sessions/:id/ws-ticket | session-ticket | action-only |
| POST /api/campaigns/:campaignId/invites | invites | action-only |
| GET /api/campaigns/:campaignId/invites | invites | action-only |
| DELETE /api/campaigns/:campaignId/invites/:inviteCode | invites | action-only |
| GET /api/invites/:inviteCode/preview | invites | action-only |
| POST /api/invites/:inviteCode/accept | invites | action-only |
| GET /api/campaigns/:campaignId/members | invites | action-only |
| POST /api/dev/credits/grant | credit-ledger | action-only |
| GET /api/dev/credits/me | credit-ledger | action-only |
| POST /webhooks/stripe | (exempt — Stripe-signed consumer, no human UI possible) | — |
| GET /api/billing/skus | billing | action-only |
| GET /api/billing/balance | billing | action-only |
| GET /api/billing/subscription | billing | action-only |
| GET /api/billing/history | billing | action-only |
| POST /api/billing/checkout | billing | action-only |
| POST /api/billing/portal | billing | action-only |
| POST /api/billing/upgrade-tier | billing | action-only |

Routes that intentionally have no UI panel live in `EXEMPT_ROUTES` in
`verify-registry.ts`. Adding to that list requires justification — the
default for any new backend route is to author a panel. The route
audit (build-time test + runtime `dev-tool:verify` pass) treats
`EXEMPT_ROUTES` union with `union(PANEL_REGISTRY.*.exercises)` as the
covered surface.

---

## The subagent dispatch prompt

(See end-of-file section: "Subagent dispatch prompt for dev-tool-verifier".)

---

## Maintenance lifecycle

- **New backend route lands.** Controller adds to `BACKEND_ROUTES`. Next dev-tool-verifier dispatch detects the uncovered route and adds a panel.
- **Backend route deleted.** Controller removes from `BACKEND_ROUTES`. Next dev-tool-verifier dispatch detects the orphan registry entry and removes the panel.
- **Panel behavior changes.** Controller (or whoever is editing the panel) re-runs the verifier; if it goes red, either fix the panel OR update the registry entry's assertions.
- **Identity / bootstrap regression.** The verifier's bootstrap step is the canary — if it starts failing, the dev sub registration or credit-grant route is broken.

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
