# Frontend Batch: Play, Invites, Billing — Design

**Date:** 2026-07-14 (rev 2, post blind-review round 1 — bread)
**Issues:** MYT-92 (play chat core), MYT-91 (invites & party), MYT-95 (billing screens) — wave 1; MYT-93 (dice & skill checks), MYT-94 (entity highlighting + knowledge sidebar) — wave 2.
**Mode:** Batch execution under the deferred-design-review regime (§7). Approved by Miklos 2026-07-14.
**Upstream authority:** UX Design spec §8, §9, §11, §12 governs flows/IA; `../../Design/mythrun-design/brand/brief.md` + `guidelines.md` govern register (and OVERRIDE the UX spec's §1/§13 visual language where they conflict — e.g. stepped motion over "smooth", per the standing brand-overrides-UX-visuals rule); this spec resolves what those leave open, pins the as-built backend contracts, and DECLARES every deviation from the UX spec.

---

## 1. Shared architecture (all five issues)

**Layering (rules R1–R5, unchanged).** `@mythrun/client-core` owns brains: view-models, reducers, endpoint slices, and the already-shipped realtime layer (`realtime/ws-session-client.ts`, `ws-ticket`, `sse-status-client`, `connection`). `@mythrun/ui` owns every new component, each with stories and tests, barrel-exported. Web routes compose; platform code stays thin. No ad-hoc UI anywhere.

**Copy.** Every new string is an i18n key with a `[ph:]` placeholder value (single shared `common.json` + `descriptions.ts` in lockstep). MYT-100 remains the one copy pass.

**Register.** Paper/1-bit, square, no circles, no status dots/chips. Two typefaces ONLY: `--font-body` (Source Serif 4) for narrative prose, `--font-ui` (IBM Plex Mono) for mechanical/chrome/data readouts — the serif-vs-mono split IS the narrative-vs-mechanical distinction; no third face is introduced anywhere in this batch. New iconography draws from the pixelarticons-pro-2 outline vocabulary (24-grid, `currentColor`); new glyphs (the d20 outline) are drawn in that grid style. Desktop AND ~375px mobile by construction; chat is full-bleed on mobile and the sidebar rides the existing drawer pattern.

**Knowledge boundary (hard rule).** Every player-facing read in this batch comes from existing known-tier projections: the campaign wiki view (`GET /api/campaigns/:id/wiki`), the world-snapshot view (member-readable, plot-safe since cb05867f), and session WS state. **No new backend read surface is added by MYT-94**; search is client-side over the already-filtered model. Anything that would need a new read goes back to design.

**Realtime.** In-session events ride the shipped WS session channel (ticket exchange → socket). Out-of-session liveness rides the shipped pipeline-status SSE. The client never invents state: reducers fold server events; reconnect resyncs from the server replay.

**Testing bar per issue.** TDD suites (client-core reducers/view-models + ui components + web routes), typecheck/lint/coverage at the repo's 100×4 bar, story coverage, and a real wire-level E2E smoke driven by the controller against the live dev stack (Playwright asserting observable end state, plus curl/psql where the flow writes). Storybook browser sweep stays CI-gated.

---

## 2. MYT-92 — Play session: chat core (wave 1, keystone)

**Backend contracts (shipped, verified against source).**
- `POST /api/sessions/:campaignId/start` — member-gated; debits ONE session credit **from the campaign OWNER** (`sessions.ts:290-324` — the owner pays, not the caller); returns **200** `{sessionId}` (not 201). Error arms the client must handle: **409 `session_already_active`** → join the running session (the 409 body carries NO sessionId — call `GET /api/sessions/:campaignId/active` to get it, then ticket+connect); **409 `prep_not_ready`** → the session-prep phase (below); **402 `{code:'insufficient_credits', available, required}`** → the MYT-95 purchase moment (owner/non-owner split per §4).
- **Prep phase.** Start is gated on session prep having completed. The shipped `GET /api/campaigns/:campaignId/prep-status` SSE (MYT-62) is the "DM is preparing tonight's session…" experience the UX spec §9/§13 describes as a 1–2 minute atmospheric wait. The play route drives it: on `prep_not_ready` (or on entering the play route before any session exists), subscribe the prep-status SSE and render the prep beat; offer Start when prep completes. `SessionStartBeat` covers BOTH the prep wait (SSE-driven) and the socket-connect boundary (short), as two labeled phases of one beat component.
- **WS protocol.** Ticket per (re)connect. The server frames are: `dm_message`, `player_message`, `text_delta` (streamed DM prose), `skill_check`, `dice_roll`, `ledger_update`, `mode_change`, `combat_started`, `combat_resolved`, `dm_thinking`, `typing_start/stop`, `turn_end`, `turn_error`, `session_end`, `player_joined`, plus `session_ready`/`session_reconnect` connect envelopes. (There is deliberately NO ST-stage-direction frame — enforced ignorance; nothing in this batch may add one.)
- **Backlog.** A FRESH connect gets `session_ready` with NO messages; history replays only via `session_reconnect` when the client connects with a `lastSeq`. The view-model therefore **seeds `lastSeq = 0` on first join** (full history replay) — this covers both the initial owner connect and the 409-join/mid-session-joiner case. Live `text_delta` frames carry no seq; the replayed turn arrives as seq-bearing rows on reconnect.

**Screen.** `campaigns/:id/play`. Desktop: chat column ~70% + collapsible sidebar ~30% (the sidebar SHELL ships in 92 with a placeholder panel, **collapsed by default until MYT-94's tabs land**; MYT-94 flips the default to open per UX §9). Mobile: chat full-bleed; the sidebar summons as the drawer. **Full-bleed mechanism:** a route-level layout breakout owned by 92 (the play route escapes AppFrame's padded content Box via an explicit frame variant/prop), NOT ad-hoc negative margins — pinned here because MYT-95 also edits AppFrame's header and the two worktrees must not both rewrite the frame (§7).

**Components (`@mythrun/ui`).**
- `MessageStream` — scroller with day/scene dividers, auto-follow with a "jump to now" affordance; auto-scroll uses INSTANT positioning under `prefers-reduced-motion` (no smooth-scroll vestibular trigger).
- `DmMessage` — Source Serif 4, paper tint, streams token-wise (append-only text node), settles on `turn_end`.
- `PlayerMessage` — **IBM Plex Mono** (`--font-ui`), distinct tint; the humans at the table are mechanical-register, the DM is narrative-register. No bubbles-and-avatars chat idiom.
- `SessionInput` — input + send + the prominent `@DM` summon. `@DM` uses the **explicit-text path**: it inserts the `@dm` token into the visible message (persisted + broadcast as a normal `player_message`, which the backend's explicit-trigger path recognizes) — the invisible `dm_invoke` frame is NOT used (the table should see the summon).
- `ThinkingIndicator` — "DM is thinking…" on `dm_thinking`; player typing on `typing_start/stop`. Clears on first `text_delta`, `turn_end`, or `turn_error` (pinned so a stuck indicator can't survive a reconnect).
- `SessionStartBeat` — the 1-bit loading-beat family; prep phase (SSE-driven, atmospheric) + connect phase; accelerates to completion; reduced-motion instant.

**Client-core (`session/` — new).** The play view-model over `ws-session-client`:
- **Transcript reducer** — models **ALL mechanical frames as first-class transcript items** (`skill_check`, `dice_roll`, `ledger_update`, `mode_change`, `combat_*`), even though 92 renders them minimally (a terse mono system line); MYT-93/94 extend the RENDERING, not the reducer shape. This is the wave-2 shared contract (§7).
- **turnId-keyed whole-turn replace** — live `text_delta` accumulations are replaced by the seq-bearing replay of the same `turnId` on reconnect (the transport deliberately delegates this; without it every live-at-drop turn double-renders).
- **Optimistic own-messages** — pending state reconciled by FIFO own-echo matching; on reconnect, pending messages reconcile against the `session_reconnect` replay (confirm-or-resend; the accepted residual risk of a duplicate on resend is annotated in code — the protocol has no client message id, and adding one is out of batch scope).
- **Connection state** — reconnect banner as a quiet system line; the shipped backoff machine drives it.
- **Start flow** — start → 200, or 409-active → `/active` lookup → join, or 409-prep → prep beat, or 402 → purchase moment.

**Session end.** `session_end` (server-emitted) → "Session complete" transition → the recap route. **Scope decision (declared):** the recap screen is TODAY a stub with no backend read (`sessions.summary` exists in the DB but no player-facing recap endpoint). 92's done-when is softened to: session end lands on the recap ROUTE (stub content acceptable). A minimal recap read + real recap screen is a named follow-up (filed as a bead at planning; the stub's campaignId-vs-sessionId param question resolves there). The UX-spec recap experience is NOT silently dropped — it is explicitly deferred.

**Done when.** A real multi-message session runs E2E on the dev stack: prep beat → start (owner's credit debited), streamed DM prose renders live, a second browser identity joining MID-SESSION sees the FULL backlog + live stream + typing, `@DM` visibly summons a response, reconnect mid-turn resyncs without double-rendering that turn, session end lands on the recap route. Wire smoke: WS frames + `sessions`/`session_messages`/`credit_ledger` rows inspected.

## 3. MYT-91 — Invite & party assembly (wave 1)

**Backend contracts (shipped).** Invite create/list/revoke/accept routes (MYT-75), `GET /api/invites/:code/preview` (public), join-summary + member snapshot access (MYT-90 + myth-0xwos). Party cap 6 server-side (409 `campaign_full`). Invite URL shape: `${frontendBaseUrl}/join/${inviteCode}`.

**Flows (§8, with one declared deviation).**
- **Generate/share (owner, campaign page):** `InvitePanel` replaces the invite seam — primary invite short link; copy everywhere, `navigator.share` where available; revoke. Terse lifecycle only, no invite dashboard.
- **Receive:** `/join/:code` renders the public preview. Signed-out → sign-in → return to `/join/:code` — **MANDATE: the handoff routes through the EXISTING `isLocalPath`-guarded `?returnTo` + OAuth `state` round-trip (signin.tsx → callback.tsx). No new redirect parameter or unvalidated target may be introduced; the shipped flow already validates against open-redirect vectors and MUST be reused as-is.** Signed-in → accept inline on `/join/:code` → join-summary → character creation. **Declared deviation from UX §8:** the UX spec routes signed-in acceptance through a Home-screen invite banner; this batch accepts inline on the join route and does NOT build the home banner (deferred — the join link is the only entry path at launch; the banner is a discoverability nicety for invites received while browsing).
- **Party assembly (owner's view):** live roster on the campaign page + hub card. **Liveness source (pinned to what exists):** there is NO member-joined event on any shipped transport. The real signal is the pipeline SSE's `character_creation_complete` (fires per member at finalize, requires the owner holding the campaign's status stream — the campaign page already does). For the pre-finalize window (accepted but not yet finalized), the roster refetches on: status-stream (re)connect, window focus, and a slow poll while the campaign page is foregrounded. A real `member_joined` event is named as possible backend follow-up, NOT in this batch.

**File-surface note (§7):** MYT-91 OWNS `home-card.tsx` (it restructures the card's live party data); MYT-95's low-credit treatment on the same card is layered at merge time by the controller (declared collision, not append-only).

**Done when.** Two-identity E2E on dev: owner generates link → second identity (signed out) hits `/join/:code`, signs in via the guarded returnTo, accepts, join-summary → creates a character → owner's roster updates on the finalize signal without reload; cap/revoked arms render calm notices; a crafted `returnTo` to an external host is rejected (open-redirect probe).

## 4. MYT-95 — Billing & credits screens (wave 1)

**Backend contracts (shipped, verified).** `POST /api/billing/checkout` (à-la-carte SKUs `sku_session`/`sku_world` with a 1–100 quantity parameter + subscription tiers; client supplies success/cancel URLs; returns only the redirect — grants NOTHING), `POST /api/billing/upgrade-tier` (monotonic upgrades, prorated, 409 `upgrade_already_pending` anti-double-charge), Customer Portal for downgrades/cancel/payment methods, `GET /api/billing/balance` → `{session, world_gen, active_subscription}` (SELF-scoped), `GET /api/billing/history`. Credits land ONLY via the `checkout.session.completed` webhook. Session-start debits the OWNER.

**Two credit buckets, pinned per surface.** `session` and `world_gen` are independent. Play-adjacent chrome — the header credit display and the campaign-card low-credit treatment — tracks **session credits only**. The settings screen itemizes BOTH buckets. No surface ever shows a conflated sum.

**Subscription CTA gating (showstopper fix).** Every subscription CTA is conditioned on `active_subscription`:
- `null` → subscription Checkout (mode: subscription).
- active, target tier HIGHER → `POST /api/billing/upgrade-tier` (renders the 409 `upgrade_already_pending` arm calmly).
- active, target tier LOWER or cancel → Customer Portal redirect.
**No UI state may present a plain subscription-checkout CTA to an already-subscribed user** — that path double-subscribes (Stripe does not prevent a second live subscription). This gating is a REQUIRED acceptance criterion, not chrome.

**Purchase moments (owner-pays split — fix).** The session-start 402 fires when the **owner's** balance is short, regardless of who clicked Start:
- Viewer is the OWNER → inline `PurchasePrompt` with the buy path (à-la-carte session credits; quantity control 1–100 with terse presets).
- Viewer is a NON-OWNER member → a calm notice: the campaign's owner is out of session credits (no purchase CTA — buying would credit the wrong ledger and not fix the session).
The campaign-card low-credit treatment is **owner-only** (a member-visible owner-balance read does not exist and must not be added). "Trial-end" as a distinct surface is DROPPED — the trial is a non-expiring starter credit with no trial flag on any read; the out-of-credits prompt is the one moment (declared deviation from §11's framing).

**Surfaces.**
- **Sessions & Billing (settings):** both balances, subscription state, the three §11 tiers by their brand names (Wayfarer / Sojourner / Mythwright) + "pay as you go" à-la-carte — **no "best value" labels** (§11's register constraint carries); portal link; purchase history (terse mono prose; the history feed carries amount/currency + `lookup_key` for subscription rows only — pack rows CANNOT name credit counts, so the prose says "Purchase — $X.XX", no per-item credit detail promised).
- **Header credit display + quick-buy:** session-credit count in the AppFrame chrome with a quiet path to the purchase surface. (95 edits the AppFrame HEADER only; the play route's full-bleed variant is 92's — declared shared file, §7.)
- **Checkout return:** success/cancel routes poll the balance briefly (webhook is truth). **Terminal states pinned:** balance changed → settled success; poll budget expires → a calm NON-error "purchase processing — credits appear shortly" state pointing at history (never a failure claim for a completed payment); the "arrived" signal keys off observed balance/`active_subscription` change during the poll, with the generic-success fallback accepted (the pre-redirect baseline doesn't survive the Stripe round-trip).
- Campaign ownership transfer (§11) is OUT of this batch (campaign-management scope, later issue — declared).

**Components.** `CreditBalance`, `PackList` (subscription-vs-à-la-carte split modeled; quantity control), `PurchaseHistory`, `PurchasePrompt` (owner/non-owner variants).

**Coupling note (§7):** the LIVE session-start 402 wiring belongs to the play flow (92). MYT-95 ships `PurchasePrompt` + the 402-response mapping unit-tested against the mocked contract; the controller wires and E2E-verifies the live arm at the 92-merge point.

**Done when.** E2E on dev with Stripe test mode (**precondition: the Stripe CLI webhook forwarder is running** — without it credits never land and the smoke must fail the precondition check, not hang): pack checkout round-trip credits the ledger and the UI reflects it; subscription checkout as a NEW subscriber works; the CTA gating renders upgrade-tier/portal (not checkout) for an already-subscribed test user; portal opens; the out-of-credits arm renders the owner prompt on a drained owner account; history lists real rows.

## 5. MYT-93 — Dice & skill checks (wave 2)

**Contract (corrected — showstopper fix).** The skill check is **fully server-resolved in ONE frame**: the FT tool rolls, matches the DC outcome tier, and the published `skill_check` frame already carries `roll`, `roll2`, `rollType`, `modifier`, `total`, `dc`, `outcomeTier`, `constraint`. **There is NO client→server roll interaction** — `roll_complete` is deliberately excluded from the client frame types, the turn worker runs the tool loop atomically, and NO backend work exists or is needed here. The "Roll" button is client-side theater over an already-received number, which is principle-compliant (the number is server-rolled; the client merely delays its display). The actual client work: the transcript reducer (92's, which already models `skill_check` first-class) holds the frame's reveal state, and the post-check outcome prose (`text_delta` in the same turn) is **client-buffered and released on "Continue"** — pinned as the one behaviorally subtle piece. `dice_roll` (the simpler variant) renders the same card minus skill/DC dressing.

**The moment.** `RollCard` renders in-stream: skill, context line, posture. "Roll" → `DieSpin`: a flat 2D outlined d20 (pixelarticons 24-grid outline vocabulary) spinning as a STEPPED 2D rotation — 8 steps/revolution, ~1s, pixel-honest, never smoothly interpolated (the motion analog of the brand's stepped Bayer dither; this deliberately overrides UX §13's "smooth" motion language per the brand-overrides rule) — then the server's result stamps into the die's center; mod/total/DC/outcome tier settle under it **in `--font-ui` (IBM Plex Mono — data readouts are mono per the brand)**. "Continue" releases the buffered narrative. Reduced-motion: no spin, instant land, prose releases on the same explicit Continue. Outcome tiers are typographic weight, not color chips.

**Reference note.** No animated die example exists in the design repo (searched 2026-07-14; only the static pixelarticons dice + the dither guidelines; no "Claude Design" folder found). Anchor = the icon vocabulary + Miklos's direction ("a 2D outline in some kind of 1-bit register, spun"); the `DieSpin` story is the canonical reference thereafter.

**Done when.** A real session E2E includes a skill check: the card arrives carrying the full result, the spin plays, revealed numbers match the server's roll (psql-verified against the transcript), the outcome prose stays hidden until Continue and then streams; reduced-motion path verified.

## 6. MYT-94 — Entity highlighting + knowledge sidebar (wave 2)

**Knowledge cache.** Built from the member-readable world-snapshot model (known-tier, plot-safe) — the same read the shipped drawer wiki uses. **Matching is on entity NAMES only** (no alias field exists in any known-tier projection; alias support would require widening a projection = a new read = back to design — dropped from this batch). Live tier-flips: IF a promotion event exists on the session channel, it may be consumed ONLY if it emits the now-known projection of the promoted entity (never pre-flip content) — that invariant is asserted in the plan; otherwise the cache refetches on session boundaries (safe default).

**Highlighting.** Subtle underline on entity mentions in COMPLETED DM messages (never mid-stream reflow; longest-match wins; no partial-word hits). **Hover/focus: monochrome register — NO entity-type color.** The brand restricts semantic color to UI state, no type-color tokens exist, and the UX §12 palette would break the frame; instead the differentiator is structural and CVD-safe: underline style changes on hover + a small leading type glyph (the pixelarticons vocabulary: person/pin/banner shapes for npc/location/faction) in the popover and on hover. **[Flagged for Miklos at spec review: this deliberately drops UX §12's NPC-blue/location-amber/faction-green — if you want type color, it must come from the muted avatar ramp, not semantic tokens.]** Click/tap: popover — name, type glyph, the wiki lead line, "open in wiki" → the sidebar/drawer wiki tab at that page. **Declared reduction from §12's rich popover** (prose kernel paragraphs + facts + relationships): the popover stays terse; the full knowledge surface (facts, relationships, kernel prose) lives one tap away in the wiki tab — nothing is dropped from the knowledge model, only relocated.

**Sidebar tabs** (desktop 30% panel from 92's shell — default flips to OPEN when the tabs land, per UX §9; mobile drawer):
1. **World Wiki** — the shipped drawer-wiki experience embedded, plus client-side search over the model. **Render + search index cover ONLY the fields the shipped wiki renderer shows** — stat blocks (present in the snapshot data) are excluded from both render and index (known-tier but combat-privileged; showing NPC AC/HP to players is a product decision this batch does not make). Search is mechanical substring/rank — ZFC, no LLM.
2. **Relationship Graph** — the shipped WorldGenGraph (locked ForceParams untouched; `fillHost`/`pannable` props), mounted DRAINED (the fog field mounts but starts past the drain floor — there is no fog-off prop; this is the shipped suppression mechanism), fed by a NEW adapter from the known-tier wiki model to `GraphNode[]/GraphEdge[]` (named work, not "free"). Known-tier edges only (post-myth-got9q semantics); the dev-seeded secret-edge leak assertion is a required test.
3. **Character Sheet** — **a NEW in-session sheet variant** (named work — the shipped `CharacterSheetReveal` is the creation payoff screen with confirm/start-over affordances, wrong for in-session): renders the member's sheet from the shipped `CuratedSheet` data shape + live HP/conditions folded by a NEW `ledger_update` → character-state reducer in client-core (the frame exists; nothing consumes it yet).

**Done when.** In a real session: a known NPC's name highlights in settled prose, click opens the popover, wiki tab search finds an entity, stat blocks appear nowhere in the tab or its search, the graph renders known-tier only (dev-seeded secret edge absent — leak assertion), the sheet tab tracks a live HP change from a `ledger_update`.

## 7. Orchestration & process

**Worktrees.** Wave 1: `bd worktree create` × 3 (92 / 91 / 95) per the documented flow (redirect, per-worktree DB via `worktree-setup.sh`, own `node_modules`). Wave 2 (93 / 94) branches from main immediately after 92's merge. Controller dispatches SDD implementer subagents per bead within each worktree; implementers never commit; the controller commits serially per task per worktree.

**Declared collision surfaces (not append-only) + ownership:**
- `frontend/src/routes/home/home-card.tsx` (+ its phase-line helper): 91 OWNS; 95's low-credit treatment is layered by the controller at merge.
- `frontend/src/app/app-frame.tsx`: 92 owns the play-route full-bleed layout variant; 95 owns the header credit chrome; both are declared up front so neither worktree restructures the frame wholesale.
- `frontend/ui/src/index.ts` barrel + i18n `common.json`/`descriptions.ts`: append-only; controller resolves at merge.
- `router.tsx`: single writer per wave (95 adds the checkout-return routes in wave 1; the controller wires any wave-2 routes at commit time).
- **Wave-2 shared surfaces:** 93 and 94 both extend 92's transcript reducer rendering and the play-route composition. Contract: 92's reducer models ALL mechanical frames first-class (§2) so 93/94 extend rendering only; both wave-2 plans pin the shared session-view-model surface in their briefs (the parallel-handler-contract rule); the play-route composition edits are serialized (93 lands the in-stream card rendering; 94 lands the sidebar tabs; controller merges serially).

**Cross-issue couplings (declared):** 95's live 402 arm wires at the 92-merge point (§4); 94's default-open sidebar flips 92's collapsed default (§6); 93/94 both consume 92's reducer contract (§2).

**Merges.** Serial, one worktree at a time from main, full gate re-run between merges. Never push from inside a worktree.

**Done per issue (deferred-design-review regime).** Tests + 100×4 + story coverage green; the controller-driven wire-level E2E smoke passes; wiki synced; merged to main; pushed through the pre-push gate; Linear flipped. NO per-feature visual-audit stop — visual taste debt is explicitly accepted and collected for the end-polish pass (structural/register rules still bind: DS-first, no circles, two faces only, i18n, responsive, a11y gates).

**Verify-first beads (top of the relevant plans):**
1. (92) The prep-status SSE contract + `prep_not_ready` arm against a live campaign (drive it once before building the beat).
2. (91) The shipped `returnTo` round-trip carries `/join/:code` end-to-end (probe before wiring).
3. (95) Stripe test-mode: confirm `upgrade-tier` + portal arms against the live test account; confirm the webhook forwarder smoke precondition.
4. (93) The `skill_check` frame renders from a real FT turn (one constructed-state session) before the card work.
Sequencing constraint (not a bead): 92 is the schedule keystone; 91/95 finishing early pre-write wave-2 briefs.

**Recap follow-up (declared scope cut):** a minimal player-facing recap read (`sessions.summary`) + the real recap screen + the campaignId/sessionId param fix is filed as its own bead at planning, outside 92's done-when.
