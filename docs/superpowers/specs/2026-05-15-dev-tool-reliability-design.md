# Dev-tool reliability system — design

> **Bead:** `myth-e5mn`
> **Status:** brainstormed 2026-05-15, awaiting plan + implementation.

## Why this exists

Three concrete dev-tool bugs shipped in a row (`/api/campaigns/mine` returns 403 because the dev-tool's default sub isn't an onboarded user; credit-ledger panel stuck on `"unknown — issue a grant to query"`; identity-switcher dropdown content drifted from expected). Each bug reached the user's hands because:

- **Vitest component tests mock the API**, so contract drift between the dev tool and the real backend is invisible to them.
- **`pnpm dev-tool:check`** is a manifest check (does every route in `coverage.json` have a listed panel?), not a runtime check (does the panel work?).
- **The author's eyeball before saying "go test"** is unreliable under session pressure. Memory rules like `feedback_dev_tool_e2e_smoke_required` are prose the agent can silently skip.

The user's framing: "I need you to design some kind of reliability system that GUARANTEES that the dev tool is working when you push changes to it. 'I'll just remember and do better' is not an acceptable option."

The system must be mechanical, not advisory. It must catch broken-data and contract-drift bugs, not CSS/browser quirks (those are the residual human-test surface). It must mirror the wiki-authoring pattern: a dedicated subagent dispatched at the appropriate moment, with full edit + fix authority, that owns end-to-end correctness of its surface.

## Architecture overview

Five components, in dependency order:

1. **`backend/dev-tool/AUTHORING.md`** — the contract document the subagent reads.
2. **`backend/dev-tool/verify-registry.ts`** — per-panel test contract (expected marker, placeholder denylist).
3. **`backend/dev-tool/scripts/verify.ts`** — JSDOM harness that runs the per-panel checks.
4. **The dev-tool-verifier subagent** — Opus, full edit + fix authority, dispatched from `AUTHORING.md`.
5. **PostToolUse hook (reminder) + pre-push gate 6 (backstop)** — wired so the subagent is invoked at the right moment and red verifies block pushes.

The subagent owns components 1, 2, 3 — including ongoing maintenance of `verify-registry.ts` whenever it changes panels.

## Component 1: `backend/dev-tool/AUTHORING.md`

Analog of `docs/wiki/AUTHORING.md`. Sections:

- **What the dev tool is** — a local 127.0.0.1-only Vite SPA whose job is to be the test surface for every backend route. The dev tool is to the backend what the wiki is to the codebase: a complete mirror in a different shape.
- **The principles** (numbered, ~5–8):
  1. **Full backend route coverage.** Every route registered against the Fastify app must have a panel that can exercise it — read panels for GETs, action panels for POST/DELETE. If a backend route exists and isn't exercisable from the dev tool, that's a bug. *Implementation note: the existing `coverage.json` only enumerates pipeline routes (`pipelineRoute=true`). To enforce this principle the system needs a full-route source. See Component 6.*
  2. **No silent placeholders.** Every panel that fetches data declares an expected post-load DOM marker. Steady-state-on-mount panels (action-only panels like credit-ledger, event-driven panels like live-events) are explicitly classified as such in the registry — they declare an "idle marker" instead of a "loaded marker" — and the harness does NOT apply placeholder denylists to them.
  3. **Bring-up self-bootstraps.** The dev tool does not require the human to manually register the dev sub, grant credits, or pre-seed state. First-load against a clean DB produces a working tool.
  4. **Identity model is single source of truth.** `getCurrentDevSub()` returns one sub; every fetch and SSE call uses that sub via `x-mythrun-dev-sub`. No panel hardcodes a different sub.
  5. **Explicit error surface.** Backend errors render visibly with status + code via a structured DOM marker (e.g., `data-state="error"`), not silently absorbed into a placeholder. The harness distinguishes "loaded successfully" from "rendered an error banner" by separate selectors, not by substring matching.
  6. **Verifiability is shipped with the panel.** Every new panel ships its `verify-registry.ts` entry in the same commit; a panel without a registry entry is a build error.
  7. **Panel-pattern declaration is mandatory.** Each registry entry declares the panel's interaction pattern (`'fetch-on-mount'`, `'event-driven'`, `'action-only'`). The harness applies pattern-appropriate assertions — see Component 3.
- **Panel patterns** — three patterns, each with a `data-state` convention:
  - `fetch-on-mount`: panel fires a fetch from `mount()`; data renders into the DOM. Sets `data-state="loading" → "loaded" | "error"` on the root element. Examples: `my-campaigns`, `health`.
  - `event-driven`: panel binds to a window event (`mythrun.watchcampaign`, `mythrun.opendetails`); fetches only when the event fires. Sets `data-state="idle"` on initial mount; transitions when an event arrives. Examples: `status`, `live-events`, `campaign-details`.
  - `action-only`: panel renders an action surface (form, button) with no read fetch. Sets `data-state="ready"` on initial mount; transitions when an action completes. Examples: `credit-ledger`, `campaign-create`.
- **The verification model** — JSDOM mount + real fetch + pattern-appropriate assertions. Walked through with one concrete example per pattern.
- **Coverage inventory** — a table of every backend route and which dev-tool panel exercises it. Updated by the subagent on each run. Derived from `BACKEND_ROUTES` (Component 6), not hand-maintained.
- **The subagent's playbook** — step-by-step what to do when dispatched. (Coverage audit → mount each panel via verify script → fix bugs → re-iterate → report.)

## Component 2: `backend/dev-tool/verify-registry.ts`

A single TypeScript module declaring panel patterns + per-panel checks:

```ts
import { mountIdentitySwitcher } from './src/components/identity-switcher.js'
// …one import per panel

import type { BackendRoute } from '../src/contract/backend-routes.js'  // see Component 6

export type PanelPattern = 'fetch-on-mount' | 'event-driven' | 'action-only'

export interface PanelRegistration {
  /** Panel interaction pattern (Component 1 principle 7). The harness uses
   *  this to choose the right post-mount assertion shape. */
  readonly pattern: PanelPattern
  /** The panel's mount function. */
  readonly mount: (parent: HTMLElement) => void | Promise<void>
  /** For fetch-on-mount: CSS selector on the root indicating data-loaded
   *  state (e.g., `'[data-state="loaded"]'`).
   *  For event-driven and action-only: the idle-state selector
   *  (e.g., `'[data-state="idle"]'` / `'[data-state="ready"]'`). */
  readonly readySelector: string
  /** CSS selector indicating the panel rendered an error banner. The harness
   *  treats this as a distinct outcome from "loaded" — neither false-positive
   *  on empty-but-healthy nor false-negative on visibly-failed. */
  readonly errorSelector: string
  /** For fetch-on-mount panels: max ms to wait for `readySelector` to appear
   *  before reporting a timeout failure. Default 2000ms. The harness polls;
   *  it does not use a fixed sleep. */
  readonly readyTimeoutMs?: number
  /** Backend routes this panel exercises. Typed import from BACKEND_ROUTES
   *  (Component 6) prevents string drift between the registry and the
   *  contract source. */
  readonly exercises: readonly BackendRoute[]
}

export const PANEL_REGISTRY: Readonly<Record<string, PanelRegistration>> = {
  'identity-switcher': { /* … */ },
  'credit-ledger': { /* … */ },
  // …
}
```

Build-time invariants enforced by `verify-registry.test.ts`:

1. **Forward coverage**: every file under `backend/dev-tool/src/components/*.ts` (except `__tests__/`) that exports a `mount*` function has a corresponding entry in `PANEL_REGISTRY`. Missing entries fail the test.
2. **Reverse coverage**: every key in `PANEL_REGISTRY` points at a panel module imported by `backend/dev-tool/src/main.ts`. Orphan entries fail the test (catches dead-code panels that exist + are registered but never reach the UI).
3. **Route exhaustion**: `union(PANEL_REGISTRY.*.exercises) ⊇ BACKEND_ROUTES`. Every backend route the contract enumerates is exercised by at least one panel. Drift fails the test (catches "added a route, forgot the panel").

Helper modules under `backend/dev-tool/src/components/` that don't export a `mount*` function (utility libs, shared helpers) are exempt — the forward-coverage check is keyed on the presence of an exported `mount*` symbol, not on file existence.

## Component 3: `backend/dev-tool/scripts/verify.ts`

A standalone CLI executable as `pnpm dev-tool:verify`. Behavior:

1. **Sanity-check infra.** Hit `http://localhost:3030/health` and `http://127.0.0.1:5273/`. If either is unreachable, attempt auto-boot (best-effort `pnpm --filter @mythrun/backend dev:detached` + `pnpm --filter @mythrun/dev-tool dev:detached` in `tmp/` subprocess managed by the script with PID + log files); if auto-boot fails, print actionable boot-up commands and `exit 2`. The pre-push gate (Component 5) and the subagent both depend on this auto-boot behavior — neither should require a human to start servers manually.

2. **Identity bootstrap.** Register `dev-user-1` against `/api/users/register` (idempotent — 200 or 409 both pass) and grant world_gen + session credits via `/api/dev/credits/grant`. This makes the harness reliable across clean and dirty DB states and exercises principle 3.

3. **For each entry in `PANEL_REGISTRY`** (in registration order):
   a. Spin up a fresh JSDOM environment with `url: 'http://127.0.0.1:5273/'` so the panel module's relative-fetch resolution + `localStorage` / `performance` globals work. Install `globalThis.fetch` as a wrapper that prepends `http://localhost:3030` to any path starting with `/`.
   b. Set the dev tool's identity to whatever `getCurrentDevSub()` returns by default (today: `dev-user-1`).
   c. Capture `console.error` into a buffer (per-panel `errorAllowlist` in the registry — entries that match are filtered out).
   d. Call the panel's mount function with a fresh `<div>` as parent.
   e. **Poll** (every 50ms, up to `readyTimeoutMs` from the registry, default 2000ms) for one of two outcomes:
      - `parent.querySelector(readySelector)` is non-null → record `ready`
      - `parent.querySelector(errorSelector)` is non-null → record `error` (and capture the inner text for the report)
   f. Apply pattern-appropriate verdict:
      - **`fetch-on-mount`**: `ready` → ok; `error` → fail; timeout → fail (the panel never reached a terminal state).
      - **`event-driven`**: `ready` (idle marker present) → ok; absence of idle marker → fail (panel didn't initialize correctly); `error` → fail.
      - **`action-only`**: `ready` (action surface present) → ok; absence → fail; `error` → fail.
   g. Console-error check: `console.error` buffer is empty after filtering through `errorAllowlist`. Non-empty → fail with the unfiltered messages in the report.
   h. Emit one line per panel: `[panel:NAME] STATUS [— DETAILS]`.

4. **Exit code**: `0` if every panel passed; `1` if any failed; `2` for infra not-up.

A second pass after step 3 audits route coverage: for every route in `BACKEND_ROUTES` (Component 6), verify at least one panel in `PANEL_REGISTRY` lists it under `exercises`. Drift fails with `[coverage] route X not exercised by any panel`. This is enforced at runtime in addition to the build-time test (Component 2 invariant 3) so the script catches manifest-vs-implementation drift even if the test wasn't run.

The script is reusable in three contexts:
- The dev-tool-verifier subagent runs it
- The pre-push hook runs it (gate 6)
- The human runs it ad-hoc

**Dependencies**: adds `jsdom` to `backend/dev-tool/devDependencies` (not currently in any package.json — the existing live-events-panel test hand-rolls a fake DOM specifically to avoid the dep, but the verify harness needs a real-enough DOM that hand-rolling is no longer viable). Node has `fetch` native (Node ≥20).

## Component 4: The dev-tool-verifier subagent

Dispatched by the controller agent (me) when working on the dev tool, following the same pattern as the wiki-authoring subagent. Subagent prompt template lives at `backend/dev-tool/AUTHORING.md` end-of-file ("Subagent dispatch prompt" section), parameterized with the current task context.

The subagent's job, in order:

1. **Read `AUTHORING.md`** end to end.
2. **Coverage audit.** Compare `BACKEND_ROUTES` (Component 6) against `PANEL_REGISTRY[*].exercises`. Identify gaps: routes without panels, registry entries pointing at deleted panels (orphans), panel modules existing without registration. Fill the gaps autonomously — add a panel for an uncovered route, add a registry entry, remove a stale entry. If the gap is in `backend/src/contract/backend-routes.ts` (e.g., a route handler exists but the contract source missed it), the subagent does NOT fix that — it escalates in the final report. Backend contract source is the controller's responsibility.
3. **Run `pnpm dev-tool:verify`.** For each failing panel, investigate the failure: read the panel source, the route it calls, the route handler, the data path. Fix the bug — autonomously, with full edit authority over `backend/dev-tool/**`. Re-run verify. Iterate until green or stuck.
4. **Stuck detection.** A panel is "stuck" when two consecutive verify runs after an edit produce the same failing outcome (same readySelector/errorSelector verdict and same console.error pattern). On stuck: stop attempting fixes for that panel and escalate it in the final report. The user picks up the design decision; the subagent does not bash on it.
5. **Re-check scoped tests + typecheck + lint** before finishing — scoped to backend/dev-tool only (`pnpm --filter @mythrun/dev-tool test && typecheck && lint`), not the full backend coverage suite. Re-run `pnpm dev-tool:verify` one final time to confirm green-on-clean-tree.
6. **Update `AUTHORING.md` coverage inventory** if new routes/panels landed.
7. **Report back** in this exact shape — controller parses it for the final user-facing summary:
   ```
   ## Panels checked
   - <name>: ok | failed | unchanged
   ## Coverage changes
   - added panel: <name> for <route>
   - removed panel: <name> (route deleted upstream)
   ## Bugs fixed
   - <one bullet per fix, with file + summary>
   ## Escalated to controller
   - <one bullet per unresolved issue, with rationale>
   ```
   Do NOT commit — the controller stages + commits.

The subagent has authority to:
- Edit any file under `backend/dev-tool/**` (including `coverage.json`, `verify-registry.ts`, `AUTHORING.md`)
- Read any file in the repo
- Run `pnpm dev-tool:verify`, `pnpm dev-tool:check`, scoped `pnpm --filter @mythrun/dev-tool` commands

The subagent does NOT have authority to:
- Edit backend route handlers, services, repositories, or the auth surface (read-only; backend bugs surfaced by verify are reported back via the Escalated section, not silently fixed). This boundary exists because backend changes need wider review than a per-dispatch subagent should perform — same rationale as the wiki subagent not editing source code.
- Modify the contract manifest in `backend/src/contract/` (including `backend-routes.ts` — Component 6)
- Run `git add` / `git commit` / `git push`. The controller stages + commits all subagent output; this preserves the controller's serial-commit invariant from `feedback_parallel_agent_commits` even though this subagent runs alone (the invariant is structural — controller owns staging — and worth keeping uniform across all subagent types).

## Component 5: Hook + pre-push gate

**PostToolUse hook (`.claude/hooks/post-dev-tool-edit.sh`)**: registered in `.claude/settings.json` under PostToolUse with `"matcher": "Write"` (NOT `Edit|Write` — Edit fires per-iteration during a single bug-fix turn and would spam the agent with 3-10 identical reminders, matching the existing `post-spec-write.sh` precedent). The hook script reads `tool_input.file_path` and decides whether to emit. It fires only on path matches against this set:

- `backend/dev-tool/src/**` (any TS file)
- `backend/dev-tool/coverage.json`
- `backend/dev-tool/verify-registry.ts`
- `backend/dev-tool/AUTHORING.md`
- `backend/src/contract/backend-routes.ts` (the route enumeration source)
- `backend/src/contract/pipeline-routes.ts` (the existing pipeline-route source the dev tool consumes)

Note: edits to general `backend/src/routes/**` are NOT in the matcher. The relevant signal for "dev tool needs re-verification" is the contract surface (backend-routes.ts + pipeline-routes.ts) which is what the dev tool consumes — not every route handler edit. The contract source changes when a route is added/removed; routine handler edits don't.

The hook emits via `hookSpecificOutput.additionalContext`:

> "You edited the dev tool or a backend route contract source this turn. Before handing back, dispatch the dev-tool-verifier subagent with the prompt at `backend/dev-tool/AUTHORING.md` end-of-file. The verifier owns coverage + per-panel functional correctness — this is the standing dev-tool reliability rule."

(Citation is to the standing rule + AUTHORING.md, not to the bead — beads close, rules don't.)

**Pre-push gate 6 in `.husky/pre-push`**: when the diff being pushed touches `backend/dev-tool/**` or `backend/src/contract/{backend-routes,pipeline-routes}.ts`, run `pnpm dev-tool:verify`. The verify script auto-boots backend + dev-tool subprocesses (Component 3 step 1) so the gate works whether or not the dev environment is already up; the developer doesn't have to manually start servers before `git push`. On verify failure, the push is blocked with the failing panel report. On success, the gate exits and the push proceeds.

**Pre-push hook documentation**: the file header comments enumerate "1–6" in three places (top checklist, manual-run snippet, and each `echo "→ pre-push gate (N/6)"` line). The implementation plan must update all three together; missing any creates an inconsistency. Implementation step: add a single explicit "renumber to /6 in three places" task.

The gate runs in <60s on an already-running backend + dev-tool (8 panels × 200ms wait worst-case + JSDOM init + fetches ≈ 5–15s actual; auto-boot adds ~5s when needed). The verifier subagent uses the same harness for its own iteration loop, so subagent + push-time enforce identical bars.

## Component 6: `backend/src/contract/backend-routes.ts` — the full-route source

The existing `coverage.json` is scoped to pipeline routes (the 7 routes with `pipelineRoute=true` in `pipeline-routes.ts`). Principle 1 ("every backend route has a panel") requires a broader source: every route registered against the Fastify app, including non-pipeline routes (billing, invites, users, sessions, dev credits, health).

**New contract module**: `backend/src/contract/backend-routes.ts`. Exports a typed enumeration of every backend route:

```ts
export type BackendRoute =
  | { method: 'GET'; path: '/api/campaigns/mine'; ... }
  | { method: 'POST'; path: '/api/campaigns'; ... }
  // …one per registered route across all route modules
  ;

export const BACKEND_ROUTES: readonly BackendRoute[] = [...]
```

**Drift-prevention test**: `backend-routes.test.ts` boots the Fastify app, calls `app.printRoutes()` to enumerate every registered route, diffs against `BACKEND_ROUTES`. Drift fails the test — adding a new route handler without updating `BACKEND_ROUTES` immediately breaks CI, same way adding a typed error without updating the `PIPELINE_ERROR_CODES` array breaks the contract test.

**Relationship to `pipeline-routes.ts`**: pipeline-routes is a subset of backend-routes. The status surface (the existing `pnpm dev-tool:check`) keeps reading `pipeline-routes.ts`; the new verify harness reads `BACKEND_ROUTES`. Both stay in lockstep via the drift-prevention test.

**Authority**: the controller maintains `backend/src/contract/backend-routes.ts`. The dev-tool-verifier subagent reads it but cannot modify it (per Component 4 authority list). When a new backend route lands and the contract source is updated, the subagent's next dispatch detects the new entry in `BACKEND_ROUTES` and adds a panel for it.

This component is the resolution to the blind-review SHOWSTOPPER (Alpine-butterfly C1): principle 1 was previously unenforceable because `coverage.json` is structurally narrower than the route surface. `BACKEND_ROUTES` makes the principle structurally enforceable.

## How today's three bugs are caught by this system

| Bug | Pattern | Caught by | How |
|---|---|---|---|
| `/api/campaigns/mine` returns 403 for default sub | fetch-on-mount | verify → my-campaigns hits `errorSelector` instead of `readySelector` | The my-campaigns panel sets `data-state="error"` and renders an error banner when fetch fails. Verify polls, sees the error marker, reports it. Subagent investigates: the underlying cause is that `dev-user-1` isn't onboarded. Fix: implement principle 3 — the dev tool registers + grants credits to the default sub on first load (or the harness's identity-bootstrap step in Component 3 step 2 ensures this). Either fix makes the panel green. |
| Credit-ledger stuck on placeholder | action-only | Initially false-positive on this panel under naive design; this design's panel-pattern classification resolves it | The credit-ledger is action-only (no read fetch by design — see Component 1 principle 2). Its `readySelector` is `[data-state="ready"]` on the action surface (form + grant button), not a balance-loaded selector. The "stuck on placeholder" symptom the user reported was actually principle 5 violation: the panel rendered `(unknown — issue a grant to query)` as plain text instead of as a clearly-marked idle state. Fix: panel updates its mount to set `data-state="ready"` + use structured DOM for the idle copy. Verify then passes. |
| Identity-switcher dropdown content drift | event-driven (mount-time DOM build) | Build-time invariant in `verify-registry.test.ts` — option list shape is a registry-declared invariant | The identity-switcher does no async fetch — it builds the dropdown synchronously from a const array in `identity.ts`. The registry declares an `optionContract` (a static assertion on the rendered `<option>` count + values) that the harness verifies post-mount. Drift in the const array trips this. (The harness's pattern-aware mode treats this as a stricter equivalent of the readySelector check — `event-driven` panels with no async fetch get a build-time DOM assertion instead of a runtime poll.) |

## Scope honesty

**In scope for this design + first implementation:**
- `AUTHORING.md` and `verify-registry.ts` skeleton
- `dev-tool:verify` harness
- Subagent prompt template
- The hook + pre-push gate
- A first subagent run that fixes today's three bugs and brings existing panels into compliance

**Out of scope (iterative, subsequent sessions):**
- Adding panels for backend routes the dev tool doesn't yet expose (billing flows, sessions, invites, user management, etc.). The subagent does this incrementally as routes change; full coverage of the existing route surface is a multi-session expansion.
- Real-browser concerns (CSS, focus, keyboard). Residual human-test surface.
- Race conditions that only fire under real timing in production traffic. Not the dev tool's job to surface.

## Done criteria for this bead (myth-e5mn)

1. `backend/dev-tool/AUTHORING.md` exists and reads as a complete contract, including the panel-pattern taxonomy (Component 1 principle 7) and the subagent-dispatch-prompt section at the end of the file.
2. `backend/dev-tool/verify-registry.ts` exists and covers every current panel with explicit `pattern`, `readySelector`, `errorSelector`, and `exercises` fields.
3. `backend/dev-tool/verify-registry.test.ts` enforces the three build-time invariants (forward coverage, reverse coverage, route exhaustion) and passes.
4. `backend/dev-tool/scripts/verify.ts` is implemented; `pnpm dev-tool:verify` auto-boots services if needed, identity-bootstraps, runs the harness, and exits with the right code.
5. `backend/src/contract/backend-routes.ts` exists, enumerates every backend route, and has a drift-prevention test that boots Fastify and diffs against `app.printRoutes()`.
6. `jsdom` added to `backend/dev-tool/devDependencies`.
7. `.claude/hooks/post-dev-tool-edit.sh` is added to `.claude/settings.json` with matcher `Write` (not `Edit|Write`) and fires correctly on the path set in Component 5.
8. `.husky/pre-push` gate 6 is added (renumbered consistently in three places: top comment, manual-run snippet, gate echo); runs `dev-tool:verify` when relevant paths are touched.
9. A first verifier-subagent run passes against the current dev-tool tree — today's three bugs fixed; all existing panels reach `ok` status; coverage gaps for billing/invites/users/sessions routes either filled or explicitly escalated in the subagent's report.
10. `pnpm typecheck && pnpm lint && pnpm test:coverage && pnpm wiki:check && pnpm dev-tool:check && pnpm dev-tool:verify` all green.
11. Bead `myth-e5mn` closed.

## Open design decisions (resolved here, surfaced for the plan)

- **Subagent autonomy on fixes**: full within its authority list. Per the user's direction, the subagent has same trust as the wiki-authoring subagent. It edits, decides, and reports back what it couldn't resolve.
- **Test harness mechanism**: JSDOM, not Playwright. Real CSS / keyboard / focus is out of scope; the bug class we're targeting is broken-data / contract-drift. JSDOM added as a new dev dependency.
- **Trigger**: PostToolUse `Write` hook reminder + pre-push backstop. Not a Stop hook block — the wiki-authoring pattern is the precedent and it works. The hook matcher is on the contract surface (`backend/src/contract/**`) + dev-tool subtree, NOT on every backend route handler edit, because the dev tool consumes the contract not the handlers.
- **Pre-push auto-boot**: the verify script self-boots backend + dev-tool subprocesses when missing, so the gate doesn't require a manually-warm dev environment. The verify harness reuses the same boot path the subagent uses.
- **What the subagent maintains**: the entire dev-tool subtree under `backend/dev-tool/**` including `verify-registry.ts`, `AUTHORING.md`'s coverage inventory, and any new panel additions. Backend routes + contract source are off-limits — the subagent escalates drift in those, doesn't fix.
- **Full-route source vs pipeline-route source**: principle 1's "every backend route" is enforced via a new contract module `backend-routes.ts` (Component 6), not the existing pipeline-route-scoped `coverage.json`. The pipeline-route source stays for the status surface; the full-route source is consumed by the verify harness. Both kept in sync by a single Fastify-diff test.
