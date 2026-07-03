# MYT-89 — Campaign Creation + World-Generation Experience — Design Spec

> **Status:** Brainstormed with Miklos (2026-07-03), approved to spec. **Blind-reviewed (5 lenses — Never Land fairies — round 1: 0 showstoppers; all findings applied inline).** The one surfaced product decision (owner reveal tier) resolved to `known`-tier. Awaiting final user review → writing-plans → beads → subagent-driven implementation.
> **Linear:** MYT-89 (Frontend milestone). Deferred sibling MYT-88 (voxel/3D animation system) moved to Post-launch — this flow is flat 1-bit ink-and-paper, no 3D.
> **Scope note:** this ticket grew during brainstorming. It now spans the full create flow, the world-gen experience, a browsable **world wiki pulled forward from MYT-94**, and the starting-situation pick. It is deliberately large — see §12 (Phasing).

## Goal

The complete experience from a player deciding to make a campaign, through describing/seeding a world, watching it generate live, exploring the finished world, and choosing where their story opens — ending at the campaign page where inviting players and making characters (MYT-90/91) take over.

## Architecture (one paragraph)

Everything is flat 1-bit "paper register" — no 3D, no glow. The create flow is the design system's borderless `SeamlessInput` register (the component's own header comment names it "the calm, one-question-at-a-time world-creation flow"). The world-gen experience is a **force-directed graph rendered on Canvas** (physics via `d3-force`, rendered ourselves so no Three.js and no SVG-node explosion), with an ambient "ghost bloom" churn layer that implies the world teeming at scale during the long, sparse real event stream. The world reveal reuses the existing backend world-snapshot as a browsable **wiki**. Two new thin backend endpoints (`synthesize-preview`, `rework`) split today's atomic guided-create so the player previews and optionally tweaks the synthesized concept before committing ~10 minutes of generation.

## Tech Stack

- **Frontend:** React + Vite, `@mythrun/ui` (design system, Storybook), `@mythrun/client-core` (the only sanctioned backend seam — R5), `@mythrun/contract` (shared wire types). i18n via i18next (`[ph: …]` placeholders for prose — final copy is brand-reviewed). Graph: `d3-force` (physics only) + Canvas 2D.
- **Backend:** Fastify + TypeScript, existing `campaigns.ts` route surface + prep pipeline. Two new endpoints; Redis-backed preview store.
- **Test:** Vitest; TDD; desktop AND 375px; visual audit before push.

## Global Constraints

- **Flat 1-bit paper register.** No 3D, no glow, no shadows (depth via borders/rules). Square, no circles, no status dots/badges/chips.
- **Borderless register through the create + reveal flow.** `SeamlessInput` for fields; ghost buttons split by `Divider` rules for the fork; text-forward actions. Softer/quieter than boxed forms.
- **All UI composes `@mythrun/ui` + a Storybook story.** No ad-hoc UI. New reusable pieces are promoted to first-class components with stories.
- **All prose is an i18n key**; prose placeholders are `[ph: <purpose>]`. Only generic chrome gets real values. Final user-facing copy is brand-reviewed (`../../Design/mythrun-design`).
- **Responsive by construction** — every surface works at ~375px and desktop; `min-h-dvh`, `flex min-w-0`.
- **All backend access through `client-core`**; all wire types in `@mythrun/contract`. Strict TS, no `any`, functions < 50 lines, modules < 400 lines. UUIDv7 keys. Conventional Commits.
- **Enforced ignorance is a hard boundary.** The reveal wiki shows `known`-tier data (DECIDED §14 — the owner is a seated player, not a GM; do NOT build an all-tiers owner view). Tier filtering is enforced SERVER-SIDE only — no secret/discoverable data reaches the client. Character knowledge-filtering is MYT-94's job; do not leak any of this into a Fast-Thinker-adjacent surface.

## Context — what already exists (do not rebuild)

- **Backend create + world-gen is fully built.** `POST /api/campaigns` (freeform concept OR guided 3-media-picks → Sonnet synthesizer → input gate → credit debit → world-gen job). Status SSE at `GET /api/campaigns/:id/status/stream`. Pipeline emits rich per-entity/edge events (`entity-added` {synthKey, entityKind ∈ **faction | location | npc** — `item` is not emitted during world-gen, `name`}, `edge-added` {from,to,relationship}, `entity-updated` {merge-patch}, `entity-removed` {reason}, `edge-removed`, `finalized`, `fact-added`/`fact-removed`, `stage-*`, `phase`). Terminal: `worlds.status='complete'`, `phase: world_ready`, colour pair produced (MYT-87 `worldColors`).
- **The graph data-model reducers exist** as pure, tested functions in the dev-tool: `deriveInventory` (→ nodes) and `derivePlaceholderBuffer` (→ edges, with `new-NNN` placeholder-edge reconciliation) in `backend/dev-tool/src/components/live-events-panel.ts`. **RECONCILE, do NOT copy** (blind-review Vidia-I1): the dev-tool's `LiveEvent` types an `entity-added` with a `data: Record<string,unknown>` payload and reads `e.data.name`, but the *live* `@mythrun/contract` `PipelineEvent` is flat (`{type, synthKey, entityKind, name}`, no `data`). Porting verbatim fails to typecheck / throws on `undefined.name`, and porting the dev-tool's `data:{name}` test fixtures would false-green. Lift the *logic* (the fold + placeholder reconciliation + `stage-reset`/`finalized` handling), re-type it against the live contract, and write **fresh** tests against the live event shape.
- **World-snapshot (the wiki data) is built — but it is `known`-TIER ONLY in production** (blind-review Rosetta-I1/Silvermist-I6): `GET /api/campaigns/:campaignId/world-snapshot` (owner) returns `['known']` entities unless `user.scopes.includes('bypass')`, which is unreachable in prod (`AUTH_MODE==='bypass'` = dev/test only). It also `409 snapshot_not_ready` until stage 4 (`entity_relationships`) commits. Grouped by entity type, locations nested via `entity_hierarchy`. Dev-tool prior art: `world-snapshot-render.ts`. **The spec previously called this an "unfiltered / all-tiers" owner view — that was wrong; see §8 + §14 (DECIDED: `known`-tier).**
- **Starting situations are built:** stage `starting_situation` produces exactly 3 `{index, locationEntityId, locationName, title, prose}`. `GET …/starting-situations` (member); `POST …/starting-situation {index}` (owner) — gates character submission.
- **The SSE client is built** (MYT-85): `createSseStatusClient(ctx)` — `open(path)`, `onEvent(cb: PipelineEvent)`, `onSnapshot(cb)`, `connectionState`, `close()`; fetch+ReadableStream (EventSource can't set headers). Reference consumer: `frontend/src/routes/dev-transport.tsx`.
- **Design-system components:** `SeamlessInput` (borderless field — no box, 28px serif answer, ember caret, baseline rule → 2px accent on focus, serif label above), `Button` (`variant="ghost"` = transparent/ink/hover-fill), `Divider` (`tone="border"` quiet rule, `tone="ink"` structural seam), plus `Text`, `Heading`, `Stack`, `Box`, `Show`, `CoverDither` (per-world identity).
- **Frontend stubs:** `frontend/src/routes/campaign-new.tsx` (15-line stub — the build target). Route wired at `router.tsx` (`campaigns/new`). **No** `createCampaign` client hook, **no** `CreateCampaign` contract type yet — MYT-89 builds the client surface.

## The MYT-94 rebalance

MYT-89 builds the **browsable world wiki** as the post-gen reveal surface. **MYT-94 is re-scoped** from "build the world-knowledge sidebar" to "wire the existing wiki into the play session + add character knowledge-filtering (+ entity highlighting)." Update MYT-94's Linear description when this ships.

**Tier scope — the wiki shows `known`-tier (DECIDED §14).** The reveal wiki reads `GET …/world-snapshot`, which is `known`-tier in prod (§Context). That is a coherent, safe reveal (the owner walks their world's *public* shape). The **data-scoping seam is SERVER-SIDE, never a client filter** (blind-review Rosetta-I2): the wiki component takes an injected *data source* that selects which tier-scoped server endpoint to call (owner-reveal → `world-snapshot`; in-play party member → the existing `known`-tier `/wiki` projection `campaign-wiki-view.ts`; a future character-scoped view → a new server endpoint). No tier filtering ever happens in the browser — secret data must not reach the client to be filtered out. Note the two existing endpoints differ in access rule AND shape (`/world-snapshot` is owner-only, nested, with prose/stat-blocks; `/wiki` is member-accessible, flat, `known`-only), so MYT-94's "adapter" spans endpoints, not just a prop — build `WorldWiki` to accept a normalized view model so either source can feed it.

---

## 1. End-to-end flow (state machine)

```
New Campaign (hub CTA)
   │
   ▼
FORK ─── "Start from an idea" ──────────────► FREEFORM (seamless prose field)
   │                                               │  Begin
   └─── "Build from what you love" ► GUIDED (3× name+why, one at a time)
                                          │  Find my world
                                          ▼
                                     synthesize-preview ──► PREVIEW (concept only)
                                          │                    │ Begin
                                          │                    ├─ Ask for one change ► rework ► PREVIEW′ (change spent) ─┐
                                          │                    │                                                        │
   ┌──────────────────────────────────────┴────────────────────┴────────────────────────────────────────────────────┘
   ▼
COMMIT  POST /api/campaigns  →  world 'generating', campaign 'setup', owner charged 1 credit, world-gen job
   │
   ▼
WORLD-GEN EXPERIENCE (returnable background state) — the B1 graph, live over SSE
   │  (owner may leave; hub card shows 'generating'; return any time to the live graph)
   ▼  phase: world_ready (worlds.status='complete')
WORLD REVEAL — explore the finished world: the wiki (browsable) + the graph (clickable)
   │  "Continue"
   ▼
STARTING SITUATION — owner picks 1 of 3 opening hooks  (POST …/starting-situation)
   │
   ▼
CAMPAIGN PAGE — invite players (MYT-91) + start characters (MYT-90). ← MYT-89 ends here (seam).
```

Freeform skips the preview entirely (the player wrote the concept). The preview beat is guided-only.

---

## 2. Create entry — the fork

A quiet full-bleed screen in the borderless register. Eyebrow (`[ph: a new world]`), a serif question heading (`[ph: how do you want to begin?]`), an italic lede. Then the two paths as **ghost buttons split by `Divider tone="border"` rules** — a rule above the first, between, and below the last (a clean divided list; no boxes, no glyph marks). Each ghost button: a serif title + a quiet `ink-tertiary` subtitle + an ember `→`; hover warms to `surface-hover` (paper-200) and nudges right.

- Choice A → freeform. Choice B → guided.
- Component: a new `@mythrun/ui` piece — working name **`GhostChoiceList`** (or compose `Button variant="ghost"` + `Divider` inline if a list primitive is overkill; decide in the plan). Storybook story required either way.
- Responsive: single column always; the rules span the content column.

## 3. Freeform path

Eyebrow (`[ph: your own idea]`), a `SeamlessInput multiline` whose **label is the question** (`[ph: describe the world you want to play in]`), a faint italic hint (`[ph: a sentence or a page — tone, place, what makes it strange]`), and the auto-growing borderless prose field (28px serif, ember caret, baseline rule → accent on focus). Placeholder is a faint evocative example.

- Validation mirrors the backend: 20–4000 chars. Below 20, "Begin" is disabled (quietly — no red error text; the field just isn't ready). No visible character counter (chrome; the ghost register omits it) — but a faint count MAY appear only within ~200 of the 4000 cap.
- Action: a text-forward **Begin →** (ink text, ember arrow, baseline rule; hover → ember). A quiet switch line below: `[ph: not sure where to start? build it from things you love →]` → guided.
- Begin → **COMMIT** (§7) with `{mode:'freeform', concept}`. Freeform commit runs the input gate (an LLM call) synchronously before `201`/`422`, so **Begin shows a pending state** (blind-review Silvermist-9 — `Button loading`) with the same three-exit handling as the guided finding beat: `201` → world-gen; `422 concept_rejected`/`content_filtered` → the rejection states (§11); `503 llm_upstream_unavailable` → calm retry.

## 4. Guided path

Three steps, one question at a time, each a `SeamlessInput` pair: a name field (`[ph: name something you love]`, input) + a why field (`[ph: what do you love about it?]`, multiline). Eyebrow reads `[ph: what you love · one/two/three of three]`. A **faint** 3-tick progress bar (`--border` → `--strong` done → `--accent` current) + a mono `[ph: one of three]` marker — the guided *input* is discrete questions where "one more to go" is a kindness (distinct from the no-progress-bar rule for world-gen). Step 1 carries the switch-to-freeform line; steps 2–3 don't.

- Each step: **Next →**; step 3: **Find my world →**. Steps 2–3 carry a quiet **← Back** (blind-review Silvermist-I3) — the three picks persist in flow state, so a user can fix an earlier answer without restarting.
- Per-field validation: name `min 1 max 200`, why `min 1 max 800` (backend `SynthesizerPickSchema`). All three pairs required before synth.
- "Find my world" → `POST synthesize-preview {picks:[3]}` → the synthesizing beat → PREVIEW (§5).
- Autofocus each step's first field on entry (the flow drives `autoFocus` via `SeamlessInput`'s `...rest` passthrough).

## 5. The preview beat (guided only) — NEW backend

An atmospheric "finding beat" (a pulsing ember seed + `[ph: finding the world in what you love]`) covers the synth call, then PREVIEW. The beat has **three exits, not one** (blind-review Iridessa-I2): success → PREVIEW; `422 concept_rejected` → the rejection state (§11); `422 content_filtered` (Anthropic policy, terminal — no retry) → a distinct calm terminal message; `503 llm_upstream_unavailable` (transient) → a calm "the DM is busy — try again" with a retry that re-fires the same call. Same three-exit handling on `rework`.

**PREVIEW** — eyebrow `[ph: the world we found]`, then the **concept prose only, no name** (name is minted later by `concept_intake` inside world-gen — showing a name here would be a lie that changes). Concept set as readable serif body (~19px, `ink-secondary`, generous leading, ~34em measure). Two actions: **Begin →** (commit) and a muted **Ask for one change**.

- **Ask for one change** → a single `SeamlessInput multiline` (`[ph: what would you change?]`, hint `[ph: one note — we'll rework the world around it]`) with **Rework →** and a muted **Never mind** (back to preview). → the reworking beat → **PREVIEW′**.
- **PREVIEW′** — same layout, the revised concept, and **Begin →** is the *only* action (the change is spent). A faint mono note `[ph: your one change has been used]`.
- **Start over** (blind-review Silvermist-I2): both PREVIEW and PREVIEW′ carry a quiet muted **Start over** → back to the guided picks (re-synthesizes a fresh preview). A user who dislikes the concept but doesn't want to spend their one change is not dead-ended between "commit" and browser-back. (No credit is charged until commit, so re-synthesizing is free to the player.)
- Begin (from either preview) → **COMMIT** (§7) with `{mode:'guided', previewId}`.

### New endpoints (thin; the RIGHT split, not a hack)

Splitting today's atomic guided-create so the gate + synthesis run before the credit-charged world-gen commit.

- **`POST /api/campaigns/synthesize-preview`** — body `{picks: SynthesizerPickSchema × 3}`. Order: rate-limit (5/min create family) → rejection-storm cooldown → **non-charging credit peek** → synthesizer → gate. The **credit peek is REQUIRED here** (blind-review Tinker Bell-I1): today the create route blocks *all* Sonnet spend behind the credit peek before synth+gate; moving synth+gate into an uncharged preview would let a 0-credit user burn ~2 Sonnet calls per request indefinitely (they can never commit, but they can spend). So gate the LLM spend on `repo.credits.getWorldGenBalance(userId) ≥ 1` (a cheap read, `403 insufficient_credits`) — "credit is for world-gen" governs *charging*, not *gating*. It does NOT debit (debit is at commit). On pass: stores the gated `{concept, intentSummary, reworkCount:0}` in Redis under a fresh `previewId` (UUIDv7, TTL ~30 min), **keyed by `${authUserId}:${previewId}`** so a cross-user id simply isn't found (IDOR-safe). Returns `{previewId, concept}`. On gate reject: `422 {code:'concept_rejected', reason, rejectionMessage, synthesizedConcept}`.
- **`POST /api/campaigns/preview/:previewId/rework`** — body `{change: string}` (bounded length). Loads the stored preview by `${authUserId}:${previewId}` (`410 preview_expired` if absent — uniform with commit, not 404). Enforces the single-rework bound *first*: `409 rework_exhausted` if `reworkCount ≥ 1`. Then runs a **NEW LLM primitive** — `reviseConcept(priorConcept, changeNote) → {concept, intentSummary}` (a new prompt + function in `backend/src/llm/prep/`; the existing `synthesizeConcept(picks)` only takes 3 picks and cannot revise) → gate. **Mutate ONLY on gate PASS** (blind-review Tinker Bell-I3/Rosetta-M2): on pass, overwrite the stored `{concept, intentSummary}` and set `reworkCount:1`; on `422` reject, return the rejection and **do NOT** overwrite the stored (already-gated) concept or spend the rework budget. Returns `{previewId, concept}` or the `422`/`content_filtered`/`503` shapes.
- **`POST /api/campaigns` (commit) — extended.** Guided source arm changes `{mode:'guided', picks}` → **`{mode:'guided', previewId}`**. **This is a breaking change** to the dev-tool's one-shot guided create (`campaign-create-panel.ts`) + 3 `campaigns-create.test.ts` cases — Phase A migrates them (preview-then-commit, or leave the dev-tool guided path on the freeform arm). Commit loads the gated concept by `${authUserId}:${previewId}` (`410 preview_expired` → UI restarts guided, ideally pre-filling the retained picks), then runs the *existing, unchanged* commit path **in full** (rejection-storm cooldown check → concurrent-gen guard → credit peek → queue-depth → debit → insert → world-gen job → **storm-counter reset on success**). **No re-synthesis, no re-gate** (the stored concept was gated at preview/rework; the store is server-authored, not client-modifiable — verified safe). Freeform arm unchanged. **Register both new routes in `backend/src/contract/backend-routes.ts`** (not `pipeline-routes.ts` — they aren't campaign-status surfaces) or the boot-drift test fails.

**Contract types (new, `@mythrun/contract`):** `SynthesizePreviewRequest`/`Response`, `ReworkRequest`/`Response`, `ConceptRejection`, and the widened `CreateCampaignRequest` guided arm. **client-core (new):** `synthesizePreview`, `reworkPreview`, `createCampaign` (+ hooks). These are the R5 backend seam — nothing else calls the API directly.

## 6. World-gen experience — the B1 graph

The centrepiece. A **returnable background state**, not a takeover: the owner can watch, or leave (hub card shows `generating` via MYT-87's `cardPhase`) and return to the live graph any time.

**Mount + rehydration (blind-review Iridessa-C1 — load-bearing).** The SSE `snapshot` frame is **phase-only** (`{phase, stages, cost}`, no entity inventory) and the Redis subscriber has **no historical replay** — so "re-open and replay snapshot" does NOT reconstruct the graph. Correct behavior: on mount the graph opens the status SSE and folds live events from that point; to rehydrate on a *return* mid-gen, once `phase ≥ world_snapshot_ready` (stage 4 committed) fetch `GET …/world-snapshot` once, seed the graph from it, then continue folding live events. **Before `world_snapshot_ready` there is no full-state source** (snapshot 409s, SSE has no replay): a return during the first ~half of gen shows a deliberately **sparse** graph that fills from post-reconnect arrivals. Accepted limitation — the world still completes and the end reveal is whole; do not claim full fidelity on early return. (Full early-return fidelity would need backend entity-event buffering/replay — out of scope; §14.)

**Two layers, both flat ink on paper, one Canvas:**

1. **The named graph (force-directed, interactive).** Nodes = streamed `entity-added`, edges = `edge-added` (placeholder-reconciled). Physics via `d3-force` (`forceManyBody` + `forceLink` + `forceCenter`). **Node-identity preservation (blind-review Vidia-I2):** maintain ONE persistent simulation node set for the screen's life and **merge** new nodes into it per event — never `simulation.nodes(freshArrayFromReducer)` per event (that re-seeds and explodes the layout on every arrival, and arrivals are **bursty**: stages 2–3 stream 6–40 `entity-added` events within seconds). Survivors keep their `x/y/vx/vy`; only new nodes are seeded. This is what produces "settle and re-balance," not thrash. **Draggable** (fine-pointer only, see Mobile) + **hover-reactive**. Glyphs square, type-varied (world = ember; faction = filled ink; location = outlined; npc = small ink) — no circles. `entity-removed`/`edge-removed` (repair + coherence) get a dissolve treatment mirroring the crystallize-in (the wire invariant: entities never vanish silently).
2. **The ambient "ghost bloom" churn (B1).** Between sparse real arrivals (entities stream in per-stage bursts, then long entity-free stretches during embed/coherence/etc. over ~10 min), continuous faint unnamed nodes bloom out of dither and dissolve — the world teeming at scale. Procedural so a long wait never reads as a stale loop; real entities **crystallize** out of the churn. FIFO-capped particles; edges bounded by total edge count.

**Data model:** RECONCILE the two reducers to the live contract (§Context — logic lifted, re-typed, freshly tested — not a verbatim port) into `client-core`; the Canvas + `d3-force` renderer is `WorldGenGraph` in `@mythrun/ui` (Storybook story driven by a **bursty** scripted fixture, not a metronome). Fold ONCE per SSE event (sparse) — never inside the rAF loop. `prefers-reduced-motion`: no churn/blooms; the sim ticks synchronously to convergence and redraws once per arrival (a static layout that updates on each new entity — not a frozen frame).

**Accessibility (blind-review Silvermist-I4).** The Canvas is a decorative enhancement over an **accessible streamed-entity list** — a keyboard-navigable, screen-reader-legible DOM list of entities as they arrive (name + kind); this is the a11y path during gen (Canvas nodes are `aria-hidden`). Activating a list item selects the node.

**Mobile (blind-review Silvermist-I5, ~375px).** The live graph is view-first on touch: **tap-to-select** (no drag — drag-to-reposition is a fine-pointer nicety so it can't fight page scroll), labels for the selected node, and the accessible entity list is the primary interaction surface. Fits the viewport; no horizontal scroll.

**In-gen node detail (blind-review Silvermist-I8/Iridessa-M3/Rosetta-M3).** Clicking a node *during gen* opens a LIGHT detail (name + kind) from the STREAMED reducer state — NOT `world-snapshot` (409s until stage 4) and NOT the full wiki (facts/prose don't stream as graph events; a small extra `fact-added` fold would be needed for live facts). Rich detail (facts, prose) is the post-gen reveal (§8). Keep the in-gen panel honestly light.

**Chrome + lifecycle.** Minimal, no progress bar; a quiet stage whisper (`[ph: … factions]`) + concept echo. On leave the SSE closes; on return, re-open + rehydrate per above; `world_snapshot_ready` on a returning client maps to "still generating" (not a dead phase). `phase: world_ready` → the reveal (§8). **Failure** (`world_gen_failed`): a calm state whose retry **branches on the resume response** (blind-review Iridessa-I1) — `POST …/resume` → `202` (re-enqueued → back to the graph) OR terminal `409 world_gen_capped`/`phase_not_yet_implementable` (a distinct "can't retry" surface, not a re-clicking dead-end). A user's own in-flight `409 concurrent_generation` on re-entry routes to the existing generating view, not an error.

## 7. Commit + the returnable transition

Begin → `createCampaign` → `201 {campaignId}` → route to the world-gen experience.

**Routing must be phase-aware (blind-review Silvermist-I1).** The hub card + index row already link to `/campaigns/:id` (→ `CampaignDetailRoute`, the §10 landing). Rather than a second `/generating` route the card doesn't know about, **make `/campaigns/:id` phase-aware**: while the world is `generating` it renders the world-gen experience (§6); once the campaign is past setup it renders the campaign page (§10). So the existing hub-card link *is* the return path, and "returnable" needs no new route or link change — one phase-aware route.

**Commit error surface, per-arm (blind-review Iridessa-I3).** The guided commit runs NO LLM (concept was gated at preview) — its errors are `403 insufficient_credits`, `503 queue_full`, `409 concurrent_generation` (→ route to the generating view, not an error), `410 preview_expired` (→ restart guided). The freeform commit additionally gates, so it can return `422 concept_rejected`/`content_filtered` AND `503 llm_upstream_unavailable` (a second, distinct 503 beyond `queue_full`). Each gets a calm inline state, not a raw toast.

## 8. World reveal — the wiki + graph exploration

On `world_ready`, the experience resolves into an **exploration state**: the settled graph on one side, a **browsable wiki** on the other (responsive: stacked/tabbed at 375px). A gentle prompt invites exploration (`[ph: your world is ready — look around]`), and a **Continue →** drops into the situation pick (§9).

**The wiki (pulled from MYT-94):** a browsable view of the world-snapshot — entities grouped by type (factions / locations / npcs / items), locations nested by `entity_hierarchy`, each entity opening to its facts. Search across entities. Data from `GET …/world-snapshot`, which is **`known`-tier in prod** (§Context) — a coherent "walk your world's public shape" reveal, NOT an all-tiers view (DECIDED §14: `known`-tier). Built as a first-class `@mythrun/ui` component (**`WorldWiki`**, Storybook story) that accepts a **normalized view model from an injected SERVER-SIDE data source** (per the MYT-94-rebalance rule — owner-reveal → `world-snapshot`; in-play → the `known`-tier `/wiki`; no client-side tier filtering, ever). Clicking a graph node selects the same entity in the wiki and vice-versa (shared selection state).

## 9. Starting-situation pick

Continue → a quiet screen presenting the **3 opening hooks** (`GET …/starting-situations`): each `{title, locationName, prose}` as a selectable ghost item (borderless register, square, rules — not boxed cards, not radio dots). Owner picks one → `POST …/starting-situation {index}` → route to the campaign page. Members (non-owners who arrive here) see a read-only "the host is choosing your opening" state — but in MYT-89's happy path the owner is the actor. Re-pick allowed while unlocked (idempotent until a character concept is submitted).

## 10. Post-create landing / hand-off

After the situation pick → the **campaign page** (`campaigns/:id`). MYT-89 lands the owner here with the world ready + opening chosen; the page's invite (MYT-91) and character-start (MYT-90) surfaces are **stubbed with clear seams** (a placeholder "invite players" + "everyone makes a character" region wired to the existing routes' shapes but not built out). This is the explicit MYT-89 boundary.

## 11. Cross-cutting defaults (redirect in review)

- **Gate rejection UX:** the `422 concept_rejected` → a calm inline state showing `rejectionMessage` (never the model's raw reasoning). Freeform: return to the field with the message; edit + retry. Guided: show the `synthesizedConcept` that was judged + the message, offer "edit as freeform" (drop into freeform pre-filled) or "start over." `content_filtered` (terminal, no retry) → a distinct calm terminal message.
- **The "New Campaign" CTA gap:** MYT-87 only shipped the CTA on the *empty* hub. Add it to the **populated** hub (`CampaignHubBody`) — a quiet ghost/rule affordance consistent with the register, routing to `campaigns/new`.
- **Resume/leave:** `/campaigns/:id` is phase-aware (§7), so the hub card *is* the return path while `generating`; on return the graph rehydrates per §6 (world-snapshot once `phase ≥ world_snapshot_ready`, sparse before that) — NOT via the phase-only SSE snapshot.
- **Pre-commit refresh (blind-review Iridessa-M1/Silvermist-11):** `previewId` + the guided picks live in flow state only; a refresh at the preview abandons a still-valid (30-min TTL) Redis preview. Acceptable (no credit charged pre-commit), but retain the picks client-side (sessionStorage) so a refresh or `410` re-prefills them rather than forcing a re-type of three name+why pairs.
- **Reduced motion:** graph → per §6 (sim ticks to convergence, redraws per arrival), no churn/blooms; beats → instant.
- **Auth:** all create/preview/situation routes require an onboarded user; the create flow assumes the owner is signed in + onboarded (the hub is already gated).

## 12. Phasing (for decomposition into beads)

Build order that keeps each phase independently testable:

- **Phase A — Backend + contract + client-core.** `synthesize-preview` + `rework` endpoints (the new `reviseConcept` LLM primitive; the `${userId}:${previewId}` Redis store; credit-peek on preview; gate-pass-only mutation) + the widened create arm; register both in `backend-routes.ts`; **migrate the dev-tool's guided-create + the 3 `campaigns-create.test.ts` cases** off the removed `picks` arm; contract types; client-core `synthesizePreview`/`reworkPreview`/`createCampaign` hooks. Real-LLM constructed-state smoke of preview→rework→commit→gate. (Core infra — no shortcuts.)
- **Phase B — Create UI.** Fork (`GhostChoiceList`), freeform, guided (one-at-a-time), the preview beat, gate-rejection states. Wired to Phase A. The "New Campaign" CTA on the populated hub.
- **Phase C — World-gen graph.** Reconcile the reducers to the live contract (fresh tests); `WorldGenGraph` (Canvas + `d3-force` with node-identity merge + ghost blooms + the accessible entity-list); the phase-aware route + SSE wiring + rehydration + failure/resume-branching.
- **Phase D — Reveal + wiki + situation.** `WorldWiki`, the exploration state (graph↔wiki shared selection), Continue, the situation pick, the campaign-page landing with stubbed seams.

Each phase = several beads. Per [[reference_unpushed_vertical_accumulates_ungated_gaps]], run the full pre-push gate at each phase boundary rather than accumulating to one giant push.

## 13. Testing

- TDD throughout. Unit: the reducers (nodes/edges/placeholder reconciliation — **fresh tests against the live `PipelineEvent` contract, NOT the dev-tool's stale `data:{…}` fixtures**, blind-review Vidia-I1), the graph node-identity merge (survivors keep physics state across arrivals), the preview single-rework bound + gate-pass-only mutation, the create-arm validation, gate-rejection branching.
- Component: Storybook stories for every new `@mythrun/ui` piece (`GhostChoiceList`, `SeamlessInput` compositions, `WorldGenGraph` with a scripted event fixture, `WorldWiki`). Heavy-render note: the graph + wiki can be DOM-heavy — see [[reference_heavy_svg_render_ci_waitfor_timeout]]; bump `asyncUtilTimeout` for wired multi-entity tests.
- Integration/smoke: a real-LLM constructed-state smoke of the guided preview→rework→commit path and the freeform commit path (per the dev-tool E2E smoke rule) — assert observable end state (previewId issued, concept gated, world-gen enqueued, credit debited), not "page loaded."
- Desktop AND 375px on every screen; visual audit before push (Miklos reviews the register live).

## 14. Open questions / risks / out of scope

- **Owner reveal tier scope — DECIDED (Miklos, 2026-07-03): `known`-tier only.** The owner is a seated player at their own table, not a GM; they keep their own sense of discovery (principles #1/#6/#7). The reveal reads `world-snapshot` (`known`-tier in prod) — zero backend change. The all-tiers "owner-as-author" alternative was rejected (it would spoil the owner's play and needs a new endpoint). This is now a settled requirement, not an open question.
- **Early-return graph fidelity (blind-review Iridessa-C1):** a return during stages 2–5 (before `world_snapshot_ready`) shows a sparse graph that fills forward — no full-state source exists pre-stage-4. Accepted for MYT-89. Full early-return fidelity would need backend entity-event buffering/replay — a separate change if ever wanted.
- **Preview store durability:** Redis TTL is fine (a preview is ephemeral, pre-commit). If Redis is unavailable, `synthesize-preview` fails loud (config/infra), not a silent degrade.
- **`d3-force` dependency:** meets the dependency bar (reputable, active, industry-standard, physics-only — no rendering, no Three.js). Confirm bundle cost in the plan; it's tree-shakeable to the forces used.
- **Graph performance over ~10 min:** the ambient churn is procedural + capped (FIFO on ambient particles); the named graph is ≤ ~60 nodes. Canvas, not SVG, precisely to avoid the DOM-node explosion.
- **Out of scope (explicit):** invite/party assembly (MYT-91), character creation (MYT-90), in-play character-filtered wiki + entity highlighting (MYT-94, re-scoped), the pre-world-gen lobby (deferred backend retrofit), guided-builder character path, world forking.
- **MYT-94 re-scope** must be reflected in its Linear description when this ships.
