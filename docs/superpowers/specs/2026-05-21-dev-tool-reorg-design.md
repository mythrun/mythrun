# Dev Tool Reorganization — Design

**Scope:** myth-mbdc. Rework the Mythrun dev tool's layout, navigation, information architecture, and palette. The 14-panel single-vertical-scroll layout has grown to the point where it is no longer usable for routine workflows; this design replaces it with an endpoint-per-panel sidebar shell, a persistent wire-log drawer, and a dark-mode palette aligned with the wiki.

**Out of scope:** new functionality, new routes, new test coverage beyond what the reorg requires. App-side changes are presentation-only; the verifier's per-panel discipline (`pnpm dev-tool:verify`) is preserved.

---

## 1. Motivation

Audit findings against the current layout (filed under myth-mbdc):

- **14 panels stacked in a single 900px-wide column.** Mounted unconditionally in `main.ts`; ordered arbitrarily. To get from "create a campaign" to "watch its pipeline" you scroll past 4 unrelated panels.
- **No active-campaign concept.** Each panel that needs a `campaignId` holds its own state and exposes its own Watch button. `my-campaigns` fans Watch out to other panels via window-level custom events. The watched id resets on page reload.
- **Status visibility buried.** Nothing summarizes what's currently happening across the system. The live-events panel is a flat log; you have to scroll past it AND past status to know if your worker is healthy.
- **Information hierarchy is loose at the panel level.** The character-creation panel hosts four unrelated buttons in an "Other views" section: Start character creation (a primary character-flow action), View entity hierarchy (a world read), View random tables (a world read), Archive campaign (a campaign-level action). The "Start character creation" button — which is the primary step that flips submitted-status concepts into processing — visually reads tertiary, leading to the exact confusion that prompted this brainstorm.
- **Light mode only, no brand alignment.** Tokens `--fg: #1a1a1a`, `--bg: #fafaf7`, white cards, generic system-ui sans + a fallback monospace. The wiki at `docs/wiki/site/styles.css` ships a coherent palette + IBM Plex Mono + Source Serif 4; the dev tool ignores it.
- **No filter / sort / persisted state.** Five-plus campaigns means scanning visually. Refreshing the page resets everything.
- **JSON dumps are verbose.** Every panel writes raw API response JSON to a `<pre>` at the bottom of the panel. Useful for debugging, visually overwhelming as the default state.

The fix is structural, not cosmetic. Goal: useful, on-brand, dark by default, navigable by endpoint, with a persistent wire view that mirrors what a network tab does for ordinary web work.

---

## 2. Overall shell

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  HEADER:  mythrun · dev tool                              acting as ▾       │
├─────────────────────────────────────────────────────────────────────────────┤
│  BANNER:  ▌ <Active campaign name>  <id>  stage X (n/9)  worker:ok          │
├──────────┬──────────────────────────────────────┬───────────────────────────┤
│          │                                      │                           │
│ SIDEBAR  │  MAIN PANE                           │  WIRE LOG DRAWER          │
│          │                                      │                           │
│ (HTTP    │  (active panel — split into ACTION   │  (persistent SSE event    │
│  routes  │   on left, FEEDBACK on right)        │   log, multi-campaign,    │
│  grouped │                                      │   collapsible)            │
│  by URL  │                                      │                           │
│  prefix) │                                      │                           │
│          │                                      │                           │
│          │                                      │                           │
└──────────┴──────────────────────────────────────┴───────────────────────────┘
```

Four persistent surfaces: header, banner, sidebar, drawer. One swappable surface: the main pane. Identity switcher stays in the header (top-right). Banner content updates on active-campaign change. Sidebar reflects the user's last selection (persisted). Drawer state (open/collapsed) is persisted.

Width:
- Sidebar fixed at 220px on viewports ≥1200px wide; 180px below that; collapsible to a 36px rail.
- Drawer fixed at 320px when open; 36px rail when collapsed.
- Main pane fills the remaining width. Two-pane split inside the main pane is 38% / 62% (action / feedback).
- No max-width on `main` (today's 900px clamp is gone — the dev tool earns its width).

---

## 3. Sidebar — endpoint × action leaves

The sidebar is the canonical nav. Each leaf is one HTTP method × route. Groups are URL-prefix groupings with small-caps headers; groups do NOT collapse (always visible). Selected leaf gets an ember-600 left border + paper-50 text.

**The leaf list below is illustrative, NOT exhaustive.** The single source of truth is `backend/src/contract/backend-routes.ts` (the `BACKEND_ROUTES` array the verifier already validates against). The implementer's first task is to enumerate that file, derive the panel list, and reconcile against the section assignment below. Examples of routes the illustrative list is known to omit or mis-name (caught by review): `GET /api/campaigns/mine` (not `GET /api/campaigns`), `GET /api/campaigns/:id/status/stream` (the actual SSE — listed below as `/events` in spirit), `DELETE /api/campaigns/:id`, `PATCH /api/campaigns/:id/name`, `POST /api/campaigns/:id/resume`, `POST /api/campaigns/:id/starting-situation`, `DELETE /api/campaigns/:id/invites/:code`, `GET /api/invites/:inviteCode/preview`, `GET /api/campaigns/:id/members`, `GET /api/dev/credits/me`, plus the full set of billing GETs (skus, subscription, balance, history).

Section assignments (panels each section holds; URL fragments are illustrative):

**CAMPAIGNS**
- `POST /api/campaigns` (long-running — feedback is the pipeline state for the just-created campaign)
- `GET /api/campaigns/mine` (list)
- `GET /api/campaigns/:id` (single)
- `POST /api/campaigns/:id/archive`
- `DELETE /api/campaigns/:id`
- `PATCH /api/campaigns/:id/name`
- `POST /api/campaigns/:id/resume`

**WORLD** (each requires an active campaign)
- `GET /api/campaigns/:id/status` (pipeline_runs)
- `GET /api/campaigns/:id/status/stream` (SSE — long-running consumer; the drawer also subscribes here per §6)
- `GET /api/campaigns/:id/world-snapshot`
- `GET /api/campaigns/:id/hierarchy`
- `GET /api/campaigns/:id/random-tables`

**CHARACTERS** (each requires an active campaign)
- `POST /api/campaigns/:id/start-character-creation` (long-running — owner-only kickoff)
- `POST /api/campaigns/:id/characters` (long-running — submit concept)
- `GET /api/campaigns/:id/characters` (roster)
- `GET /api/campaigns/:id/characters/:charId`
- `GET /api/campaigns/:id/starting-situations`
- `POST /api/campaigns/:id/starting-situation` (owner picks one)
- `GET /api/campaigns/:id/members`

**USERS & ACCESS**
- `GET /api/users/me`
- `POST /api/users/register` (embeds `GET /api/users/check-username` as a probe-helper in the left pane — pragmatic 1:1; see §5 for the embedding rule's verifier contract)
- `POST /api/campaigns/:id/invites`
- `GET /api/campaigns/:id/invites`
- `DELETE /api/campaigns/:id/invites/:code`
- `GET /api/invites/:code/preview` (public preview — no active campaign required; identity-less)
- `POST /api/invites/:code/accept`

**BILLING & CREDITS**
- Billing routes: enumerate against `backend/src/contract/backend-routes.ts` — at minimum: checkout, subscribe, cancel, plus the GETs for skus, subscription, balance, history.
- `POST /api/dev/credits/grant` (bypass:dev-1 only)
- `GET /api/dev/credits/me` (balance for the acting identity)
- `GET /api/dev/credits/ledger`

**SYSTEM**
- `GET /health`
- `GET /health/ready`
- `POST /api/sessions/:id/ws-ticket` (per-session gameplay surface; lives under SYSTEM because it's not user-management)

Approximate panel count after enumeration: ~25–30 leaves. The exact number depends on the full BACKEND_ROUTES walk.

**Group philosophy:** the URL prefix is the grouping authority. If a route lives under `/api/campaigns/:id/*`, it goes in either WORLD, CHARACTERS, USERS & ACCESS, or CAMPAIGNS depending on which feature it serves. Friendlier secondary labels ("Roster", "Hierarchy", "Snapshot") are encouraged next to the URL fragment — the URL is for the verifier, the label is for the operator's scent.

Routes EXCLUDED from the sidebar: webhooks (`POST /webhooks/stripe` etc.) — those aren't user-triggered; the dev tool would never POST to them. They surface only in the wire log if the backend itself receives one.

**Sidebar derivation mechanism:** hand-curated in a TypeScript module `shell/route-registry.ts` that imports `BACKEND_ROUTES` and asserts (at module load) that every entry in `BACKEND_ROUTES` either appears in the sidebar OR is in an explicit excluded-list (webhooks, etc.). Tests in `shell/__tests__/route-registry.test.ts` lock the invariant: any new route added to `BACKEND_ROUTES` without a sidebar home OR an excluded-list entry fails the test. This is the build-time enforcement that prevents "sidebar silently misses a new route."

---

## 4. Banner

Simplified from the earlier "live event tail" proposal. The wire-log drawer takes over the live-event tail responsibility; the banner is just the active-campaign context anchor.

Content (left to right):
- A short-form context bar showing: `▌ <campaign name>  <campaignId short form>  ·  stage X (n/9)  ·  worker:<status>`
- When no campaign is active: `(no active campaign — pick one in GET /api/campaigns or create one)`

Behavior:
- Updates on every `phase` or `stage-started` / `stage-completed` SSE event for the active campaign.
- `worker:<status>` polls `GET /health/ready` every 30s. Renders as `ok` / `degraded` / `down` in paper-50 / paper-300 / danger-500 respectively.
- Clicking the campaign name navigates the main pane to `GET /api/campaigns/:id` (the campaign detail panel).
- When the active campaign reaches a terminal phase (`world_ready` or `world_gen_failed`), the stage segment freezes at its final state; banner remains until the user clears or switches active campaign.

---

## 5. Main pane — the split-view panel

Every panel in the main pane uses the same skeleton:

```
┌──────────────────────────────────────────────────────────────────┐
│  <h1>  POST /api/campaigns                                       │
├────────────────────────────────┬─────────────────────────────────┤
│  ACTION (left, 38%)            │  FEEDBACK (right, 62%)          │
│                                │                                 │
│  - inputs / form               │  - response status + body       │
│  - submit / fetch button       │  - for long-running endpoints,  │
│  - any embedded read-helpers   │    a structured stream of       │
│    (e.g. check-username)       │    progress for the kicked-off  │
│                                │    resource                     │
│                                │  - "▸ raw json" disclosure at   │
│                                │    the bottom (collapsed by     │
│                                │    default)                     │
└────────────────────────────────┴─────────────────────────────────┘
```

**Per-panel discipline rules** (every panel respects these):

1. **One HTTP method × route per panel.** No multi-tasking panels. The character-creation panel's "Other views" anti-pattern is gone.
2. **`data-state="idle|loading|ready|error"` on the panel root.** Required by `pnpm dev-tool:verify`. Carry-over from today.
3. **Primary action visually primary.** The submit button is ember-600. The action area has a clear heading reading `Action` in small caps. Secondary affordances (filters, embedded helpers) are below.
4. **Feedback area is structured first, raw second.** For a list response, the rendered list is the default view; raw JSON is a disclosure at the bottom (`▸ raw json` toggle, collapsed by default). For a single-resource response, the rendered detail; raw JSON disclosure. For a long-running endpoint, the structured progress (stage bar + pipeline runs + relevant SSE events) is the right pane's content; raw JSON of the initial 201 response stays collapsed.
5. **Errors render in the feedback pane** with `data-state="error"` on the panel root and a danger-500 left border on the error block. The error block shows: HTTP status, error code, error message, and a `▸ raw response` disclosure.
6. **Empty states are explicit.** A panel with no campaign selected shows `(this endpoint requires an active campaign — pick one in GET /api/campaigns)` in the action pane. The verifier idle-state marker is set.

**Long-running endpoints (callout):** these panels (POST /api/campaigns, POST /start-character-creation, POST /characters) get a slightly richer feedback pane. After the initial response, the panel subscribes to the SSE channel for the kicked-off resource. The feedback pane shows: a stage progress strip, the live pipeline_runs table, and a SCOPED tail of SSE events (only those for the kicked-off resource). The unscoped global tail lives in the drawer.

**Read-helper embedding (the "pragmatic 1:1" decision):** thin GET endpoints whose only purpose is to validate input for a POST elsewhere can be embedded as a probe in the POST's action pane rather than appearing as their own sidebar leaf. The canonical case: `GET /api/users/check-username` is embedded inside `POST /api/users/register` (the username field auto-probes the GET as you type). This rule applies sparingly — fewer than 3 such embeddings; everything else gets its own sidebar leaf.

---

## 6. Wire log drawer

Right-side, persistent, collapsible. The dev tool's network-tab equivalent for SSE traffic.

**Subscription ownership (the single source of truth):** the drawer owns the `EventSource` objects. There is exactly one `EventSource` per subscribed campaign, held by the drawer module. Long-running panel feedback panes do NOT open their own SSE connections — they subscribe to an in-process event bus that the drawer publishes events to. This means: one socket per campaign, no doubled backend connection load, no per-user-stream-cap blow.

**Behavior:**
- Default state: open at 320px wide.
- Collapsed state: 36px rail showing event count + a `streams: M/N up` indicator (M open of N subscribed; partial-up states are visible). Click to expand.
- Open/collapsed state persisted to localStorage (`devtool.drawer.open`).
- **Multi-campaign aggregation.** The drawer holds one `EventSource` per subscribed campaign. Subscriptions are added when: (a) the user creates a campaign via `POST /api/campaigns` — auto-subscribes to the new id (the long-running panel's feedback pane reads from the bus; the drawer is the socket owner), (b) the user clicks `Watch` on a row in `GET /api/campaigns/mine`, (c) the active campaign changes via banner / detail navigation — auto-subscribes if not already. Unsubscribe via the campaign row's `×` in the drawer's campaign filter.
- Filters: a top toolbar with two dropdowns — campaign (`all` / per-id) and event type (`all` / `phase` / `stage-*` / `entity-added` / `edge-added` / others). Filters are local view-state; they don't unsubscribe.
- Buffer: last 500 events held in memory globally (across all subscriptions). Eviction is FIFO. No pin-awareness — a click-to-expand event is preserved in the DOM (the expanded row stays rendered) but if its underlying buffer entry evicts, refreshing the filter view will lose it. Worth flagging in implementation as a polish nit.
- Controls: ⏸ pause the live tail (events keep arriving and are buffered; the rendered list does NOT auto-scroll; the unread-since-pause count appears in the header), ↻ clear the buffer (also resets the unread count; does NOT exit pause state), ▸ export buffer to clipboard as JSON-lines. Pause state persists to localStorage (`devtool.drawer.paused`); pause survives reload but NOT identity switch (identity switch resumes the live tail).
- Row format: `<HH:MM:SS.mmm>  <type>  <summary>`. Compact one-or-two-line entry per event. Click a row to expand to the full event JSON inline.

**Identity-switch behavior:** when the acting identity changes (the existing `mythrun.identitychanged` event), the drawer closes every `EventSource` and re-opens against the new identity. **Events emitted during the close-reopen window are lost.** No `Last-Event-ID` resume protocol is implemented at this iteration — switching identity in the middle of a stream-heavy operation is a known edge case; if a future need arises, the existing SSE endpoint already supports `Last-Event-ID` per the spec (we'd just need to track the last seen offset per campaign). The buffer is NOT cleared on identity switch (events from before the switch remain visible until they age out).

**Page-reload re-subscription:** on page load, the drawer auto-resubscribes to ONLY the active campaign (per `devtool.activeCampaignId` in localStorage). Other previously-subscribed campaigns (held in `devtool.drawer.subscriptions`) are listed in the drawer's campaign-filter dropdown as "previously watched" with a re-watch action; they do NOT auto-open. This prevents the thundering-herd problem (N concurrent SSE opens at page load) and the orphan-subscription problem (a campaign that completed while the tab was closed returns immediate close frames).

**Per-subscription 403 handling:** if a re-subscription to a previously-watched campaign returns 403 (active identity isn't a member), the drawer shows the row in the campaign filter dropdown as dimmed with `(no access for current identity)` and offers a re-watch button that triggers a fresh subscription attempt.

**Relationship to per-panel feedback panes:** the drawer is the socket owner. Long-running panel feedback panes subscribe to the drawer's in-process event bus, filtered to the campaign the panel kicked off. The same SSE event renders in two places (the panel's right pane, scoped; the drawer's tail, global) without doubled network load.

---

## 7. Active campaign concept

A single global state, persisted to localStorage.

**Set when:**
- The user clicks a campaign row in `GET /api/campaigns` (the list view).
- A new campaign is created via `POST /api/campaigns` (auto-set after the 201 response).
- The user clicks the campaign name in the banner — no-op (banner shows current active).
- Explicitly switched via a `clear` action — banner reverts to "(no active campaign)".

**Affects:**
- The banner content (§4).
- Any sidebar leaf whose route includes `:campaignId` — these are pre-bound to the active id; if no active id, the leaf is dimmed and clicking it shows the empty-state message.
- The wire-log drawer's default filter (active campaign id pre-selected; can be widened to `all`).
- Persisted to `localStorage['devtool.activeCampaignId']`; restored on next page load.

**Identity-switcher interaction:** when the acting identity changes (the existing `mythrun.identitychanged` event), the active campaign is NOT cleared automatically — many dev workflows involve switching identity mid-campaign (testing membership, invites). But the wire-log drawer's per-campaign subscriptions close + re-open against the new identity, since the SSE endpoint uses the identity's permissions.

---

## 8. Palette + typography

**Source of truth: wiki tokens from `docs/wiki/site/styles.css`, inverted for dark default.**

```css
:root {
  /* Backgrounds — darkest is page; ramp up for chrome */
  --bg-page:     #231b12;   /* paper-900 */
  --bg-elevated: #1a130a;   /* one step darker than 900 (custom) */
  --bg-banner:   #3d3528;   /* paper-700 */

  /* Type — paper-50 emphasis, paper-300 default, paper-500 muted */
  --fg-emphasis: #f7f3e9;   /* paper-50 */
  --fg-default:  #c9c0ad;   /* paper-300 — chosen, NOT paper-200 */
  --fg-muted:    #877f72;   /* paper-500 */

  /* Borders — between the lighter paper hues */
  --border-strong: #625a4d; /* paper-600 */
  --border-soft:   #3d3528; /* paper-700 */

  /* Accents — ember for primary action, danger for failures */
  --accent:        #8a5a3c; /* ember-600 */
  --danger:        #b55a48; /* danger-500 */
  --ok:            #6a8a3c; /* not in wiki — derived sibling of ember in green */

  /* Type families — match wiki */
  --mono: 'IBM Plex Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  --serif: 'Source Serif 4', Georgia, serif;  /* not used in dev tool; defined for parity */
}
```

**Typography rules:**
- Body text + sidebar + drawer: `var(--mono)`, 11–12px.
- Panel titles (`<h1>`): mono, 14px, paper-50 (--fg-emphasis), 500 weight.
- Section labels in sidebar / drawer / action / feedback headers: mono, 10px, uppercase, letter-spaced 0.5px, paper-500 (--fg-muted).
- No serif anywhere in the dev tool (Source Serif 4 lives in the wiki; the dev tool is monospace through-and-through to match the inspector aesthetic).

**Light mode is not in scope** for this design. The wiki itself ships without a light/dark toggle; the dev tool follows suit by simply choosing dark. If a future need arises, the token block above is the obvious inversion point.

**Web font loading:** IBM Plex Mono is hosted on Google Fonts. The dev tool imports it via `<link>` in `index.html`. Fallback chain is `ui-monospace, SF Mono, Menlo, monospace` so the panel doesn't flash unstyled if the font fetch is slow.

---

## 9. Persistence

`localStorage` keys, all scoped under a `devtool.*` namespace so they're easy to find/clear:

| Key | Value | Purpose |
|---|---|---|
| `devtool.activeCampaignId` | UUID or empty | The active campaign id; restored on page load. |
| `devtool.drawer.open` | `'true'` / `'false'` | Wire log drawer expand/collapse state. |
| `devtool.sidebar.collapsed` | `'true'` / `'false'` | Sidebar rail mode. |
| `devtool.selectedPanel` | route descriptor | Last selected sidebar leaf. Restored on load if compatible (else default to `GET /api/campaigns`). |
| `devtool.drawer.subscriptions` | JSON array of campaign ids | Campaigns the drawer is currently subscribed to. Restored on load. |
| `devtool.drawer.paused` | `'true'` / `'false'` | Whether the live tail is paused. |

Per-panel input drafts (e.g., the in-flight concept text in `POST /api/campaigns`) are NOT persisted — too easy to leak across identity switches. Drafts vanish on reload.

Identity sub itself: NOT persisted by this design. The existing identity-switcher's behavior is unchanged.

---

## 10. Mount lifecycle contract (NEW — replaces the hand-wavy "idempotent" wording)

Every panel exports both `mount(parent)` and `unmount()`:

```typescript
export interface PanelHandle {
  unmount(): void  // tears down DOM + removes window listeners + closes any in-process bus subscriptions
}
export function mount<PanelName>(parent: HTMLElement): PanelHandle
```

Rules:
- **Sidebar-selection switch.** When the user clicks a different sidebar leaf, the shell calls `unmount()` on the currently mounted panel, then `mount()` on the new leaf. The DOM of the previously mounted panel is removed.
- **Re-selecting the same leaf is a no-op.** The shell short-circuits — no unmount/remount cycle, no listener churn.
- **Window listeners** added inside `mount()` MUST be removed inside `unmount()`. This is the most important contract — today's panels wire `window.addEventListener('mythrun.closewatch', ...)` etc. without removing them; under lazy mount that pattern accumulates listeners on re-mount. The new `unmount()` discipline closes the leak.
- **In-process bus subscriptions** added inside `mount()` (drawer event bus subscriptions for long-running panel feedback) MUST be released inside `unmount()`.
- **No module-level mutable state in panels.** State that needs to survive an unmount/remount cycle (rare — typically the operator wants a clean slate) lives in the shell's `active-campaign.ts` or in localStorage, not in panel closures.

## 11. What's preserved

- **`apiCall` helper.** Unchanged.
- **Identity switcher.** Header location preserved. The window-event clear-on-switch pattern (`mythrun.closewatch` / `mythrun.createpanel.clear` / `mythrun.detailspanel.clear` / `mythrun.ledgerpanel.clear`) is REPLACED by the unmount contract above plus a single shell-level `mythrun.identitychanged` listener that: (1) unmounts the currently active panel (which triggers its `unmount()` clean-up), (2) clears `devtool.activeCampaignId` IF the new identity has no membership in the previously-active campaign (the shell probes `GET /api/campaigns/:id/members` to check), (3) closes + re-opens the drawer's SSE connections against the new identity (per §6), (4) re-mounts the current sidebar leaf against the new identity. No panel-specific window events remain.
- **`data-state` markers.** Every panel sets `data-state="idle|loading|ready|error"` on its root. The verifier's per-panel mount path (`scripts/verify.ts` mounts each panel directly into a fresh JSDOM `<div>`, bypassing the shell) is unchanged. The shell-level state (which leaf is selected) is NOT covered by the verifier — that's the JSDOM unit test in §13's shell-module test, not the verifier's job.
- **`verify-registry.ts`.** Each new panel registers exactly as today. Helpers under `components/_shared/` are NOT panels and DON'T register; they're excluded from the panel-scan rule.
- **`backend-routes.ts` as the contract source of truth.** Sidebar leaves are derived per §3's enforcement mechanism (the `route-registry.ts` invariant test).
- **The dev-tool-verifier subagent + marker protocol.** Unchanged. See migration note in §13 for how this interacts with multi-commit work.
- **`pnpm dev-tool:check` manifest** (`coverage.json`). Routes/events/jobs counts are unchanged — the spec touches presentation only. A billing-routes enumeration that splits a single panel into multiple does NOT change the route count in coverage.json (each route was already counted; only the panel-side mapping changes).

---

## 12. What's new in file layout

```
backend/dev-tool/src/
├── main.ts                         # rewritten — mounts the shell, not panels directly
├── shell/                          # NEW
│   ├── shell.ts                    # mounts header + banner + sidebar + drawer + main pane
│   ├── sidebar.ts                  # endpoint-leaf nav + group rendering
│   ├── banner.ts                   # active-campaign banner
│   ├── drawer.ts                   # wire-log drawer (multi-sub, filter, pause, export)
│   ├── active-campaign.ts          # global state + localStorage persistence
│   └── route-registry.ts           # the sidebar's source-of-truth — derives from backend-routes
├── components/
│   ├── (existing panel files, refactored to the new split-view skeleton)
│   ├── _shared/                    # NEW — split-view helpers, JSON disclosure, error block
│   │   ├── panel-skeleton.ts       # builds the action/feedback two-pane DOM
│   │   ├── json-disclosure.ts      # collapsed raw-json viewer
│   │   ├── error-block.ts          # the danger-500 error renderer
│   │   └── progress-strip.ts       # stage progress UI shared between long-running panels
│   └── ...
├── styles.css                      # rewritten against the dark palette + IBM Plex Mono
└── identity.ts                     # unchanged
```

Panels themselves stay where they are (one file per endpoint-panel, in `components/`). The shell is the new layer that gives them structure.

---

## 13. Migration / rollout

**Single squashed commit on push, not multi-commit incremental.** The current shell can't peacefully coexist with the new shell — they share the same `main` element and same panel mount functions. Multi-commit work in feature branches is fine for development, but the **push to main is a single squashed commit** so the dev-tool-verifier marker (which hashes `git ls-tree HEAD -r backend/dev-tool`) is computed once at the end against a fully-coherent tree state. Per-commit verifier runs during development don't need to pass; the final push does.

The PR scope is large but well-bounded:
1. New shell module (~6 files in `shell/`, decomposed: `shell.ts` is just the composition root mounting header + banner + sidebar + drawer + active panel; `identity-bridge.ts` holds the `mythrun.identitychanged` listener and the unmount-and-remount logic; `banner.ts`, `sidebar.ts`, `drawer.ts`, `active-campaign.ts`, `route-registry.ts` as listed below).
2. Rewritten `main.ts`.
3. Rewritten `styles.css`.
4. New `_shared/` helpers for the per-panel skeleton.
5. Existing 14 panel files refactored to use the skeleton + slimmed-down responsibilities (panel mergers / splits per §3), AND retrofitted with `unmount()` per the lifecycle contract in §10.
6. New panels for the rehomed buttons (entity hierarchy, random tables, archive — each becomes its own endpoint panel).
7. New panels for the routes the audit caught as missing (per §3's "known to omit" list).
8. Updated `verify-registry.ts` for the new panel set.
9. New `shell/__tests__/route-registry.test.ts` locking the BACKEND_ROUTES coverage invariant.

Order of work within the branch: shell-first (so the harness exists), then refactor panels in groups (CAMPAIGNS group first, then WORLD, etc.). Squash before push so the marker check fires on a coherent tree.

**Backward compatibility:** none. The dev tool has no external consumers; URL paths to specific panels were never bookmarkable. Identity-switcher and `apiCall` are stable APIs.

---

## 14. Testing

- **`pnpm dev-tool:verify`** must pass on every sidebar leaf. Same `data-state` markers as today. Every endpoint × action panel must be mountable from the shell, reach `data-state="ready"` (or its panel-specific idle equivalent), and surface its error state on `data-state="error"`.
- **JSDOM unit tests** for each `_shared/` helper (panel-skeleton, json-disclosure, error-block, progress-strip). Mock-driven, fast.
- **JSDOM test for the shell module** — given a registered set of panels and a route descriptor, the shell mounts the correct panel, applies the right `data-state`, and the sidebar selection highlights correctly.
- **Active-campaign behavior test** — set via mock click on a campaign row, verify the banner updates and `localStorage` persists; reload (simulate via new shell instance), verify the active campaign is restored.
- **Drawer subscription test** — subscribe to two campaigns, verify both event streams appear, verify filter scopes to one, verify pause stops auto-scroll without dropping incoming events.
- **Real-LLM E2E smoke** — per the existing dev-tool-verifier discipline, the verifier subagent runs `pnpm smoke:phantom-reconciliation` (or equivalent) against a fresh world-gen to confirm the wire flows end-to-end through the new shell.

---

## 15. What this design intentionally doesn't do

- **No light mode toggle.** Dark default, no toggle. If we need light, it lands later.
- **No URL routing.** The dev tool is single-page; the selected panel is held in localStorage but not in the URL. No back-button support; no bookmarkable panel URLs. Dev tools don't need this.
- **No multi-user co-presence.** The active campaign and identity are per-browser; no shared session state.
- **No DB-side persistence of the wire log.** In-memory, 500-event buffer. Forensic logs go to `backend/logs/` via myth-lmz6.
- **No JSON-schema-driven panel generation.** The endpoint × action panels are hand-authored. We're not building a generic API explorer; we're building tool surfaces that match the way an operator thinks about each route.
- **No per-panel-flag system.** If a panel needs to be hidden for a particular identity (e.g., `POST /api/dev/credits/grant` is bypass:dev-1 only), the panel renders a permission-error empty state when fetched; the sidebar doesn't conditionally hide it.

---

## 16. Open questions

None at design time. All structural decisions enumerated above came out of the brainstorm and are anchored in mockups the user reviewed in the visual-companion session.
