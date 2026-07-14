# Frontend Batch: Play, Invites, Billing — Design

**Date:** 2026-07-14
**Issues:** MYT-92 (play chat core), MYT-91 (invites & party), MYT-95 (billing screens) — wave 1; MYT-93 (dice & skill checks), MYT-94 (entity highlighting + knowledge sidebar) — wave 2.
**Mode:** Batch execution under the deferred-design-review regime (§9). Approved by Miklos 2026-07-14.
**Upstream authority:** UX Design spec §8, §9, §11, §12 governs flows/IA; `../../Design/mythrun-design/brand/brief.md` governs register; this spec resolves what those leave open and pins the as-built backend contracts.

---

## 1. Shared architecture (all five issues)

**Layering (rules R1–R5, unchanged).** `@mythrun/client-core` owns brains: view-models, reducers, endpoint slices, and the already-shipped realtime layer (`realtime/ws-session-client.ts`, `ws-ticket`, `sse-status-client`, `connection`). `@mythrun/ui` owns every new component, each with stories and tests, barrel-exported. Web routes compose; platform code stays thin. No ad-hoc UI anywhere.

**Copy.** Every new string is an i18n key with a `[ph:]` placeholder value (single shared `common.json` + `descriptions.ts` in lockstep). MYT-100 remains the one copy pass.

**Register.** Paper/1-bit, square, no circles, no status dots/chips. New iconography draws from the pixelarticons-pro-2 outline vocabulary (24-grid, `currentColor`) in the design repo; new glyphs (the d20 outline) are drawn in that same grid style. Desktop AND ~375px mobile by construction; chat is full-bleed on mobile and the sidebar rides the existing drawer pattern (summon/dismiss/back behavior as shipped).

**Knowledge boundary (hard rule).** Every player-facing read in this batch comes from existing known-tier projections: the campaign wiki view (`GET /api/campaigns/:id/wiki`), the world-snapshot view (member-readable, plot-safe since cb05867f), and session WS state. **No new backend read surface is added by MYT-94**; search is client-side over the already-filtered wiki model. Anything that would need a new read goes back to design.

**Realtime.** In-session events ride the shipped WS session channel (ticket exchange → socket). Out-of-session liveness (party assembly on the hub) rides the shipped realtime transport the same way the pipeline status feed does. The client never invents state: reducers fold server events; reconnect resyncs from the server snapshot.

**Testing bar per issue.** TDD suites (client-core reducers/view-models + ui components + web routes), typecheck/lint/coverage at the repo's 100×4 bar, story coverage, and a real wire-level E2E smoke driven by the controller against the live dev stack (Playwright asserting observable end state, plus curl/psql where the flow writes). Storybook browser sweep stays CI-gated.

---

## 2. MYT-92 — Play session: chat core (wave 1, keystone)

**Backend contracts (shipped, verified).** `POST /api/sessions/:campaignId/start` (member-gated; debits a session credit; `idx_sessions_one_active` makes a second concurrent start 409 — the UI must treat 409 `session_already_active` as "join the running session", not an error); `POST /api/sessions/:id/ws-ticket` → WS connect; the session controller emits message/typing/thinking/stage events over the socket; the WS snapshot carries the transcript backlog for backscroll. The recap route (`/campaigns/:id/recap`) is shipped.

**Screen.** `campaigns/:id/play` (route exists as a stub). Desktop: chat column ~70% + collapsible sidebar ~30% (the sidebar SHELL ships in 92 with a placeholder panel; its tabs are MYT-94). Mobile: chat full-bleed; the sidebar summons as the drawer.

**Components (`@mythrun/ui`).**
- `MessageStream` — virtualized-enough scroller (plain windowing only if measurement shows need; start simple), day/scene dividers, auto-follow with a "jump to now" affordance when scrolled up.
- `DmMessage` — serif, paper tint, streams token-wise (append-only text node; no re-render churn), completed messages settle.
- `PlayerMessage` — sans, distinct tint per the spec's speaker distinction; own-vs-others alignment stays subtle (no chat-app bubbles-and-avatars arms race; this is a table, not Discord).
- `SessionInput` — input + send + the prominent `@DM` summon (explicit-UI command; inserts the `@DM` token and flags the message).
- `ThinkingIndicator` — "DM is thinking…" instant on the controller's thinking event; also renders player typing indicators (typing events are already in the WS protocol).
- `SessionStartBeat` — the 1-bit loading beat family (CharacterLoadingBeat's pattern) for the session-start boundary; accelerates to completion when the server finishes early; reduced-motion instant.

**Client-core.** `session/` gains the play-screen view-model over `ws-session-client`: a transcript reducer (snapshot + streamed deltas + optimistic own-message pending state reconciled by server echo), typing/thinking presence state, connection state (reconnect banner folds into the stream as a quiet system line, matching the calm-notice register), and the start-session flow (start → 201 or 409-join → ticket → connect).

**Session end.** The controller's session-end event → "Session complete" transition → recap route. No client-side session-end authority.

**Done when.** A real multi-message session runs E2E on the dev stack: start (credit debited), streamed DM prose renders live, a second browser identity sees the same stream + typing, `@DM` summons a response, reconnect mid-session resyncs, session end lands on the recap. Wire smoke: WS frames + `sessions`/`session_messages`/`credit_ledger` rows inspected.

## 3. MYT-91 — Invite & party assembly (wave 1)

**Backend contracts (shipped).** Invite create/list/revoke/accept routes (MYT-75), `GET /api/invites/:code/preview` (public), the join-summary + member snapshot access (MYT-90 + myth-0xwos). Party-size cap 6 enforced server-side (409 `campaign_full`).

**Flows (§8).**
- **Generate/share (owner, campaign page):** an invite surface on the campaign page replacing the invite seam — shows the primary invite's short link; copy button everywhere, `navigator.share` sheet where available (mobile); revoke; the invite list stays terse (no invite-management dashboard — the spec's lifecycle only).
- **Receive:** `/join/:code` (public route exists) renders the preview (campaign name, owner, validity) via the public preview endpoint. Signed-out → sign-in/up → return to `/join/:code` (the auth flow's return-path mechanism; verify the shipped callback supports a return target, add the param if not — that's the one auth-adjacent touch, and it's a redirect target, not an auth change). Signed-in → accept → join-summary → character creation (all shipped).
- **Party assembly (owner's view):** the campaign card (hub) and the campaign page party roster update live as members join/finalize — join events ride the realtime transport; the roster is the shipped PartyRoster component fed live.

**Components.** `InvitePanel` (link + copy/share/revoke) in `@mythrun/ui`; `JoinPreview` for the public receive screen. Everything else reuses shipped pieces.

**Done when.** Two-identity E2E on dev: owner generates link → second identity (signed out) hits `/join/:code`, signs in, accepts, lands in join-summary → creates a character → owner's roster updates live without reload; cap and revoked arms return their calm notices.

## 4. MYT-95 — Billing & credits screens (wave 1)

**Backend contracts (shipped).** `POST /api/billing/checkout` (packs + subscriptions; Stripe-hosted), `POST /api/billing/portal`, purchase/billing-history reads, the credit ledger + balance read. No payment logic client-side; the client only redirects to Stripe and renders server truth.

**Surfaces (§11).**
- **Sessions & Billing (settings):** balance, subscription state, pack purchase buttons → Checkout redirect, Customer Portal link, purchase history list (terse ledger prose, no table-of-chips).
- **Purchase moments:** out-of-credits prompt where a credit action fails (session start 402/insufficient arm — verify the exact error code from the start route and render the purchase prompt inline, not a dead-end error); trial-end prompt; low-credit amber treatment on the campaign card (prose-first, register-compliant — no badge dots).
- **Header credit display + quick-buy:** the credit count in the app frame chrome with a quiet path to the purchase surface. (Touches the nav area cosmetically; the MYT-99 redesign will restyle later — keep the DOM seam clean so restyling doesn't rewire.)
- **Checkout return:** success/cancel return routes render state from the server (the webhook is the source of truth; the return page polls the balance briefly rather than trusting the query string).

**Components.** `CreditBalance`, `PackList` (purchase options), `PurchaseHistory`, `PurchasePrompt` (the moment surface) — all `@mythrun/ui`.

**Done when.** E2E on dev with Stripe test mode: checkout redirect round-trip credits the ledger and the UI reflects it; portal opens; out-of-credits arm renders the prompt on a drained account; history lists real rows.

## 5. MYT-93 — Dice & skill checks (wave 2)

**Contract.** The FT's skill-check tool already produces the server-rolled result + DC + outcome tier (pre-generated DC outcome tables, principle 5). The session controller emits a roll-request event (card data) and accepts the player's roll action; the number NEVER originates client-side. Verify the exact event names against the shipped transcript codec before planning; if the roll interaction event isn't in the codec yet, the missing arm is a small backend bead in this issue (codec-registered per the FT-tool rule).

**The moment.** `RollCard` renders in-stream: skill, context line, posture. "Roll" → `DieSpin`: a flat 2D outlined d20 (drawn in the pixelarticons 24-grid outline vocabulary) spinning as a STEPPED 2D rotation — 8 steps/revolution, ~1s, pixel-honest, never smoothly interpolated — then the server's d20 result stamps into the die's center; mod/total/DC/outcome tier settle in under it. "Continue" releases the narrative (the DM's outcome prose was written against the predetermined result). Reduced-motion: no spin, instant land. `roll_dice` variant: same card minus skill/DC dressing.

**Components.** `RollCard`, `DieSpin` (the d20 outline glyph joins the DS icon set), outcome-tier presentation (fail / success / great success as typographic weight, not color-coded chips).

**Reference note.** No animated die example exists in the design repo (searched 2026-07-14; only the static pixelarticons dice + the dither guidelines; no "Claude Design" folder found). Anchor = the pixelarticons outline vocabulary + Miklos's direction ("a 2D outline in some kind of 1-bit register, spun"); the `DieSpin` story is the canonical reference thereafter.

**Done when.** A real session E2E includes a skill check: card arrives, roll animates, revealed numbers match the server's roll (psql-verified), outcome prose follows on Continue; reduced-motion path verified.

## 6. MYT-94 — Entity highlighting + knowledge sidebar (wave 2)

**Knowledge cache.** Client-core builds the session knowledge cache from the known-tier wiki model (+ live Scribe updates when tier flips arrive over the session channel, if the event exists — verify; otherwise refetch on session boundaries). Entity names + aliases feed a client-side matcher.

**Highlighting.** Subtle underline on entity mentions in DM prose (client-side match; longest-match wins; no partial-word hits). Hover: entity-type color + a non-color differentiator (underline style change). Click/tap: popover card (name, type, the wiki lead) with "open in wiki" → the sidebar/drawer wiki tab at that page. Matching runs on COMPLETED messages only (never mid-stream reflow).

**Sidebar tabs** (desktop 30% panel from 92's shell; mobile drawer):
1. **World Wiki** — the shipped drawer-wiki experience embedded, plus client-side search over the known-tier model (name + content substring; ranked mechanically; ZFC — no LLM in the loop).
2. **Relationship Graph** — the shipped reveal force-sim (no fog layer), known-tier edges (post-myth-got9q semantics), sized to the tab/drawer viewport; tuned constants untouched (sacred-prototype rule).
3. **Character Sheet** — the shipped CuratedSheet fed by the member's character + live HP/conditions from session state.

**Done when.** In a real session: a known NPC's name highlights in streamed-then-settled prose, click opens the popover, wiki tab search finds an entity, the graph renders known-tier only (a secret edge seeded in dev does NOT appear — leak assertion), the sheet tab tracks a live HP change.

## 7. Orchestration & process

**Worktrees.** Wave 1: `bd worktree create` × 3 (92 / 91 / 95) per the documented flow (redirect, per-worktree DB via `worktree-setup.sh`, own `node_modules`). Wave 2 (93 / 94) branches from main immediately after 92's merge. Controller (this session) dispatches SDD implementer subagents per bead within each worktree; implementers never commit; the controller commits serially per task in each worktree.

**Merges.** Serial, one worktree at a time from main, full gate re-run between merges (typecheck/lint/test/wiki:check/dev-tool:check + frontend battery). Barrel + i18n conflicts are append-only; the controller resolves at merge. Never push from inside a worktree.

**Done per issue (deferred-design-review regime).** Tests + 100×4 + story coverage green; the controller-driven wire-level E2E smoke passes; wiki synced; merged to main; pushed through the pre-push gate; Linear flipped. NO per-feature visual-audit stop — visual taste debt is explicitly accepted and collected for the end-polish pass (structural/register rules still bind: DS-first, no circles, i18n, responsive, a11y gates).

**Risks pinned.** (1) 92 is the schedule keystone — 91/95 finishing early feed wave-2 prep (mockups→specs already done; plans can pre-write). (2) The roll-interaction codec arm may add a small backend bead to 93. (3) The auth return-path for `/join/:code` may add a small param to the callback flow. (4) Session-start insufficient-credits arm: verify the error code before building the 95 prompt. All four are verify-first beads at the top of their plans.
