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

## Push-time enforcement: the `.dev-tool-verifier-ok` marker

`.claude/hooks/pre-push-dev-tool-verify.sh` blocks `git push` when the unpushed commits modify `backend/dev-tool/**` unless `tmp/.dev-tool-verifier-ok` contains the SHA-256 of the current `git ls-tree HEAD -r backend/dev-tool` output. The marker is the deterministic signal that the verifier subagent saw and approved this exact committed tree state. Any subsequent commit to `backend/dev-tool/**` shifts the hash and invalidates the marker.

**Controller marker protocol** — after a verifier dispatch reports success, do all three steps below in order, then push:

1. `git add` + `git commit` the subagent's working-tree edits (panels, registry, coverage inventory). The subagent does NOT commit per its authority list above.
2. Write the marker against the post-commit HEAD:
   ```bash
   mkdir -p tmp && git ls-tree HEAD -r backend/dev-tool | sha256sum | awk '{print $1}' > tmp/.dev-tool-verifier-ok
   ```
3. `git push`. The PreToolUse hook recomputes the hash and allows the push.

If the marker doesn't yet exist or is stale, the push is denied with the exact reason and a hash hint pointing at the current dev-tool tree. The fix is always: dispatch the verifier subagent (the prompt at the end of this file), then redo the controller protocol from step 1.

**The subagent does NOT write the marker itself.** The marker hashes HEAD, and HEAD doesn't include the subagent's edits until the controller commits them. A subagent-written marker would always be stale-by-one-commit and produce false denies.

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
   - **REAL-LLM E2E SMOKE — REQUIRED, NOT OPTIONAL.** This is THE step. Typecheck / lint / tests / JSDOM-verify all run against mocks or shallow DOM; none of them prove the wire works. You MUST drive at least the canonical world-gen flow end-to-end against the running stack at the WIRE LEVEL — `curl` for HTTP, `curl --no-buffer` (or `sse-cat`) for SSE, `docker compose exec postgres psql` for DB inspection. Browser automation does NOT count. Mocked tests do NOT count. JSDOM `pnpm dev-tool:verify` does NOT count. If you skip this step you have not done your job.

     **Canonical smoke flow:**
     1. Resolve the dev sub via the dev tool's identity bootstrap (the same mechanism `backend/dev-tool/src/main.ts` uses — read it; the header is `x-mythrun-dev-sub`).
     2. POST `/api/campaigns` with the body shape required by `CreateCampaignBodySchema` (see `backend/src/routes/campaigns.ts`): a discriminated `{world: {kind: 'new', source: {mode: 'freeform', concept: <≥20-char prompt>}}}`. As of myth-4lhr the name is NOT a body field — campaigns are inserted with a placeholder name and `concept_intake` auto-names from the LLM. Example concept: "a port city where wizards trade secrets for moonlight." Assert HTTP 201 + a campaign id + a world id in the response. If the response is not 201, inspect the body, root-cause the failure, fix or escalate. Do not proceed.
     3. Open the SSE stream at `/api/campaigns/:campaignId/status/stream`. Read events until a terminal phase event (`world_snapshot_ready`, `world_ready`, or `failed`) arrives within a 3-minute budget. Tee the stream to a log so you can inspect event ordering on failure.
     4. Query Postgres directly for:
        - `worlds.status` for the new world id — must be the terminal state matching the SSE event. Not `pending`, not `null`, not stuck mid-pipeline.
        - `pipeline_runs` entries for the new world id — every stage that fired should be `completed` or `failed` with a reason; no rows stuck `in_progress`.
        - `credit_ledger` debits for the dev sub — credit was actually charged for the work.
     5. Confirm no untrapped 5xx in the backend logs (`docker compose logs --tail=200` against whichever container runs the backend) and no PG-level errors logged.

     **Failure → root cause → fix → re-run.** Do NOT report success with a failing smoke. Failure modes this step catches that nothing else does:
     - Untyped 500 on `LlmAuthError` (the smoke surfaces the bare 500; mocked tests don't)
     - Schema-too-tight Zod validation killing a stage on real LLM output shape
     - BullMQ worker not registered or stuck on the queue
     - Credit ledger not debiting (revenue hole)
     - SSE event ordering bugs (events arrive out of expected order)
     - PG constraint surprises on real-world entity / fact / relationship shape
     - Anthropic API auth lapses (silent 401 the panel never surfaces)

     The smoke costs ~$1–2 of Anthropic per dispatch. That is the price of catching what MYT-51 shipped through — 756 passing tests and two never-driven bugs in production. Pay it every dispatch.

6. **Update the coverage inventory** in `AUTHORING.md` if new routes/panels landed.

7. **Report back** in exactly this shape:

```
## Panels checked
- <name>: ok | failed | unchanged

## Coverage changes
- added panel: <name> for <route>
- removed panel: <name> (route deleted upstream)
- (nothing changed)

## E2E smoke result (REQUIRED — must report, never omit)
- campaign id: <id>
- world id: <id>
- terminal phase reached: world_snapshot_ready | world_ready | failed | (timeout — never reached)
- HTTP status on POST /api/campaigns: <code>
- worlds.status post-smoke: <value>
- pipeline_runs post-smoke: <count completed> completed, <count failed> failed, <count in_progress> stuck
- credit_ledger debit recorded: yes | no | (not checked — explain)
- backend errors observed: <none, or list of 5xx / PG / worker errors>
- verdict: PASS | FAIL (any FAIL means do not report success — fix and re-run)

## Bugs fixed
- <one bullet per fix, file + summary>
- (none)

## Escalated to controller
- <one bullet per unresolved issue, with rationale>
- (none)
```

If the "E2E smoke result" section is missing or its verdict is FAIL, the controller WILL re-dispatch you. There is no way to ship dev-tool changes without a passing smoke. Do not waste a dispatch — run the smoke.

Do NOT commit. Leave files in the working tree; the controller stages and commits everything.
```
