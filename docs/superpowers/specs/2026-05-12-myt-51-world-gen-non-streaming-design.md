# MYT-51 — World Gen Non-Streaming Stages + Credit Gate + Cost Cap + Resume — Design

**Date:** 2026-05-12
**Status:** Revised after blind review (round 1) — ready for user review
**Revisions:** Applied 1 SHOWSTOPPER fix + ~25 inline nit fixes from the 5-reviewer round (Phoenix / Hydra / Wyvern / Roc / Kraken). Round 2 not dispatched (stopping rule: 1 SHOWSTOPPER → fix + ship). See "Round 1 fixes" appendix at the bottom for the change list.
**Linear:** [MYT-51](https://linear.app/mythrun/issue/MYT-51)
**Parent spec:** `docs/specs/2026-04-13-world-campaign-pipeline.md` §3 (amended during the status-surface ticket to consolidate the API to campaign-scoped routes only)
**Related design:** `docs/superpowers/specs/2026-05-12-myt-50-pipeline-status-surface-design.md`

## Summary

This ticket lands the world-gen pipeline minus the two streaming stages: the `POST /api/campaigns` entry point that atomically creates a campaign + world stub and debits one `world_gen` credit; a worker processor that runs world-gen stages (1, 4, 5 fully implemented; 2 + 3 stubbed for the streaming-stages ticket); per-world cost-cap circuit-breaker; the campaign-scoped resume endpoint; and the boot-time enforcement hook that fails app startup if a `/api/campaigns/...` route is registered without appearing in `PIPELINE_ROUTES`.

Two creation modes ship at launch: **freeform** (user-typed concept text) and **guided** (user picks three pieces of media + a reason for each; a Sonnet synthesizer call produces an original concept from the cross-section). Both modes funnel through the same validation gate and the same downstream pipeline.

The previous ticket in the milestone (status surface) shipped the snapshot + SSE stream + Redis pub/sub bridge. This ticket is the first one whose worker actually publishes lifecycle events onto that bridge — so the dev tool's status panel finally shows real-time progress against a real generating world.

---

## Architectural decisions

### D1. Campaign is the user-facing unit (carries over from MYT-50 brainstorming)

World sharing is post-launch scope. Worlds don't get their own addressable surface at launch — a world is created atomically inside its owning campaign in the same transaction. All status, resume, and details flow through campaign-scoped routes (`/api/campaigns/...`). The status-surface ticket established this; this ticket implements the worker side and the campaign-create entry point.

### D2. Discriminated body shape, polymorphic from day one

`POST /api/campaigns` accepts a discriminated union body even though only one variant is functional at launch. Shape (launch-final — the `'existing'` arm is intentionally NOT stubbed because stubbing a polymorphic seam you know will change is more dangerous than not stubbing it):

```ts
{
  name: z.string().min(1).max(200),
  world: z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('new'),
      source: z.discriminatedUnion('mode', [
        z.object({
          mode: z.literal('freeform'),
          concept: z.string().min(20).max(4000),       // length-capped; see Roc-C3
        }),
        z.object({
          mode: z.literal('guided'),
          picks: z.array(z.object({
            title: z.string().min(1).max(200),
            whyILikeIt: z.string().min(1).max(800),
          })).length(3),
        }),
      ]),
    }),
  ])
}
```

Future addition (`kind: 'existing'`) is a purely additive Zod discriminator entry. Until that ticket ships, an unknown `kind` value produces a standard 400 Bad Request from Zod (not 501) — cleaner than committing today to a stub shape we know will change. The seam is in the discriminated-union pattern itself, not in a pre-declared placeholder arm.

### D3. Conditional credit-debit + enqueue

The route handler treats credit-debit and BullMQ enqueue as conditional on `world.kind === 'new'`. At launch the conditional is always true; the seam is in place for the future `'existing'` arm to skip both (since an existing world doesn't need re-generation and doesn't get re-charged). No rework needed when that variant turns on.

### D4. Backend-side synthesizer for the guided mode

The route handler (not the frontend) runs the synthesis from `picks → concept string`. One Sonnet call.

**Why backend, not frontend wrap:** if the frontend formatted the picks into a concept string ("I like Harry Potter because..."), the IP gate would flag the literal mention of Harry Potter and reject. The gate would have to be taught to recognize "this is a list of inspirations, not a request to clone," which entangles two responsibilities. Backend synthesis keeps the gate single-purpose: it always judges a clean original concept string.

**Synthesis prompt** instructs the model to produce an original world inspired by the cross-section of the picks **without echoing the source titles** by name in the output. Output schema:

```ts
{
  concept: string,                       // the synthesized original concept (fed into stage 1)
  intentSummary: {                       // structured signal for downstream stages
    aesthetics: string[],                // ["found family", "muted color palette"]
    themes: string[],                    // ["coming of age", "secrets buried in institutions"]
    sourcesInternal: string[]            // ["Harry Potter (magical academy)", ...]
                                         // INTERNAL ONLY — never rendered to user, never echoed
                                         // into prompts that go beyond the input gate. Retained
                                         // for ops/debugging only. Renamed from
                                         // sourcePicksAcknowledged for clarity (Wyvern-Imp5,
                                         // Phoenix-Min6).
  }
}
```

`intentSummary` flows to two consumers (revised after Roc-Imp7 + Wyvern-Imp2):

1. **The input gate** (D5) receives both `concept` and `intentSummary`. The gate's clone-intent and inappropriateness axes consider `intentSummary.sourcesInternal` directly — closing the prompt-injection path where a user puts adversarial text in `picks[].title` ("Ignore prior instructions...") to bypass the gate. The synthesized concept itself is also judged as before.
2. **`concept_intake`** receives `intentSummary.aesthetics` + `intentSummary.themes` as separate prompt variables. NOT `sourcesInternal` — that field is opaque to all prompts downstream of the gate. This prevents copyrighted titles from round-tripping through stage 1's prose generation.

After synthesis, freeform and guided paths converge at the gate. Freeform's `intentSummary` is `null`.

### D5. Input gate is a single Sonnet call with three axes

A Sonnet call runs after synthesis (if guided) and before credit debit. The call judges the concept against three concerns:

- **`srd_compat`** — can D&D 5e mechanics (classes, spells, monsters, dice) support this fiction? Bias permissive: only reject pure realism with NO room for any supernatural element (gritty Civil War drama, courtroom thriller). Anything where supernatural elements can plausibly be added (urban fantasy, magical-realism, sci-fi with magic) is allowed.
- **`clone_intent`** — is the user requesting a verbatim clone of copyrighted IP? Mentioning IP as reference/comparison is FINE ("a magic system like Harry Potter's"); requesting a clone is NOT FINE ("I want a world set at Hogwarts"). Sonnet judges intent, not entity mentions.
- **`inappropriate`** — slot reserved for Sonnet to organically refuse. No content-policy prompt language; the model uses its training. If it returns `verdict: 'reject', reason: 'inappropriate'`, we surface the user-facing reasoning from Sonnet's output.

**Verdict logic** (revised from blind review — Wyvern-C3):

```
Reject if:
  - srd_compat.fits === false AND srd_compat.confidence > 0.85, OR
  - clone_intent.flagged AND clone_intent.confidence > 0.85, OR
  - inappropriate.flagged (binary; no confidence), OR
  - Aggregate fallback: any two of {srd_compat, clone_intent} fire with confidence ≥ 0.70 each
```

The aggregate rule catches the "two axes both screaming 'probably bad' but neither crosses 0.85" near-miss case.

**Confidence semantic** (state explicitly to remove ambiguity): each axis's `confidence` is "confidence in the NEGATIVE finding." So `srd_compat.fits=false, confidence=0.83` means "83% sure it doesn't fit." The verdict logic above maps cleanly onto this.

**422 response shape (revised — Roc-C2, Kraken-Imp3, Wyvern-Imp6):**

```ts
{
  code: 'concept_rejected',
  reason: 'srd_incompat' | 'clone_intent' | 'inappropriate',
  rejectionMessage: z.string().max(400),         // user-facing, plain text only, no markdown
  synthesizedConcept?: string                    // present only on guided-mode rejection;
                                                 // lets the user see what was judged so they
                                                 // can switch to freeform-edit (Kraken-C2 fix)
}
```

`reasoning` is logged server-side, NOT returned in the response (server-only field; Roc-Imp6 information-leak mitigation).

**FE rendering contract:** `rejectionMessage` MUST be rendered as **plain text via `textContent`**, never `innerHTML`. The dev-tool create panel and any future production FE must honor this. Sonnet is an attacker-controllable output channel; an adversarial concept can attempt to inject HTML into the rejection message field. The 400-char length cap and the plain-text rendering together close the XSS surface (Roc-C2).

**Threshold:** 0.85 for primary, 0.70 for aggregate. Bias permissive — false positives at launch hurt retention more than false negatives. Tune in the MYT-55 hardening pass based on real rejection logs.

**Rejection-storm cooldown** (revised — Kraken-C3): a per-sub rejection counter in Redis with a 1-hour sliding window. After 3 rejections in 1 hour, return 429 Too Many Requests with `code: 'rejection_storm_cooldown'` and a brand-voice message suggesting the user try a wholly different framing or contact support. Counter is incremented on every 422 from this route; reset on a successful 201 (proves the user can produce a passing concept). Prevents adversarial Sonnet-burn loops AND surfaces a help path for genuinely-stuck users.

### D6. Paint-job output validator wraps concept_intake

The input gate catches user *intent* to clone. The output validator catches the OTHER failure mode: the LLM produces a paint-job clone regardless of input. The "Pigmoles called Pigmoles, but it's Hogwarts" case.

Stage 1 (`concept_intake`) wraps `generateObject` in a validator loop (revised after Wyvern-C1 + Wyvern-C2):

1. Draft the WorldConcept via Vercel SDK's `generateObject` with **`maxRetries: 1`** (the validator loop is the sole retry authority; without this, the SDK's internal 3-retries and the validator's 3-retry loop fight for a worst-case 12 Sonnet calls per stage).
2. Sonnet check (a **separate call** with a **distinct judge prompt**, not a self-check): "Is this a recognizable IP paint-job, regardless of the names used? Consider plot structure, character archetypes, faction shapes, setting tropes." Returns structured `{ flagged: bool, confidence: 0..1, mirroredWork: string | null, specificDriftAxes: string[] }`.
3. On flag (`flagged && confidence > 0.85`): **discard the rejected draft from context entirely** (do NOT include it in the retry prompt) and re-invoke `generateObject` with an amendment that tells the model "the previous attempt mirrored [mirroredWork] along these axes: [specificDriftAxes]. Explore a fundamentally different direction — different aesthetic register, different faction archetype." Temperature bumped to ~1.0 on retry for divergence. Without this, retries produce surface-renames ("Hogwarts → Pigmoles") rather than genuinely different worlds (Wyvern-C2's specific concern).
4. Up to **2 retries total** (3 attempts including the original). Cost-bounded: ~6 Sonnet calls worst-case for stage 1 (3 drafts + 3 judges).
5. **All validator costs accumulate into `pipeline_runs.cost_usd` for stage 1** (judge call + every retry draft), so the per-world cost cap correctly observes them (Roc-Imp4 + Wyvern-Min1).
6. After exhaustion, stage fails with `error_code='concept_intake_paint_job_loop_exhausted'` → phase becomes `world_gen_failed`. User can adjust the input and resume.

The check runs only on stage 1's output — the world's foundational characterization. Subsequent stages (4, 5; 2, 3 in the next ticket) inherit the gate's verdict implicitly because they're generating in the cleared-clean world.

**Judge prompt is distinct from generator prompt** — the judge is a fresh call with no memory of the generator's reasoning; otherwise the judge mirrors the generator's tropes (Roc-Min6).

### D7. Stages 2 + 3 fail visibly with typed error

Worker stage registry contains all 5 stages. Stages 2 + 3 are wired to a `stageNotImplementedHandler` that immediately records `pipeline_runs.status='failed', error_code='stage_not_implemented'`, publishes the `stage-failed` event, and returns. Phase derivation reports `world_gen_failed`. Dev tool watcher sees a clean failure state.

When the streaming-stages ticket ships, it swaps real handlers in. The resume endpoint re-runs from stage 2 idempotently because completed stages (1, 4, 5) are skipped via `pipeline_runs.status='completed'` gating, and failed stages (2, 3) get re-attempted.

> **Why not skip stages 2 + 3 and pretend the world is complete?** Because the world isn't complete — it has no factions, locations, or NPCs. Character creation in the next ticket needs those entities. A pretended-complete world produces character-creation failures downstream that are harder to diagnose than a clean "stage_not_implemented" stop here.

### D8. Worker job payload is `{ campaignId }` only

Spec originally said `{ campaignId, worldId, userId }` but worldId + userId are derivable from `SELECT FROM campaigns WHERE id = $1`. The worker already reads the campaign row at pickup (to fetch the concept text), so the "extra DB read" cost is illusory. Cleaner: less payload-vs-DB divergence risk, simpler test fixtures.

### D9. BullMQ jobId = campaignId for dedupe — with terminal-job pruning

Duplicate enqueues (resume button mashed twice, retry-while-active) silently merge into the existing job. Stage-level idempotency (`pipeline_runs.status`) handles the rest. Layered defense.

**SHOWSTOPPER fix from Hydra-C2:** BullMQ's `jobId` dedupe is **permanent across the queue's terminal-state retention** — once a job with `jobId=X` is in `completed` or `failed` state, `queue.add(..., { jobId: X })` is a silent no-op until that job is removed. As originally written, the resume endpoint's `worldGenQueue.add(...)` call would return 202 + enqueue nothing for any campaign that previously failed. The happy resume path was structurally broken.

**Fix:** configure the `world-gen` queue with **immediate terminal-job pruning**:

```ts
const worldGenQueue = new Queue('world-gen', {
  connection: redisBatch,
  defaultJobOptions: {
    removeOnComplete: { count: 0 },   // prune completed jobs immediately
    removeOnFail: { count: 0 },        // prune failed jobs immediately (after BullMQ retries exhausted)
  },
})
```

Once a job hits a terminal state and BullMQ's retry policy is exhausted, the job is removed from the queue immediately. The `jobId=campaignId` slot is freed. The resume endpoint's `queue.add(..., { jobId: campaignId })` succeeds normally.

**Tradeoff:** we lose BullMQ's job-history retention. We don't need it — `pipeline_runs` is our durable audit trail (rich enough for incident review). BullMQ's retention is for short-term operator inspection via Bull Board / Arena, which we don't run.

**Resume's contract under this:** `queue.add` succeeds for terminal-state campaigns; the 202 response is honest. For ACTIVE-state campaigns, `queue.add` still merges silently with the in-flight job (correct behavior — no double-run).

### D10. Resume route is fully polymorphic from MYT-51

Route handler reads phase via `derivePhase` (from the status-surface ticket) and switches on it. **All 8 arms of `PipelinePhase` are enumerated; the switch ends with `assertNever` for compile-time exhaustiveness** (Phoenix-C1):

| Phase observed | Action |
|---|---|
| `world_gen` (active) | 409 Conflict + **`Retry-After: 30`** header (`code: 'world_gen_in_progress'`, transient — Phoenix-Imp2) |
| `world_gen_failed` | Inspect `pipeline_runs` for stuck-stage's `error_code`. If `error_code='stage_not_implemented'`, return **409 `code: 'phase_not_yet_implementable', stuckAtStage: <stage>'`** (Kraken-Imp4 — don't loop the user on a guaranteed-fail). Otherwise re-enqueue `world-gen` job. **If cost-cap-exceeded was the failure (see D11 revisions), this branch ALSO returns 409 `code: 'world_gen_capped'` — admin action required.** Successful re-enqueue: 202 with `{ campaignId, action: 'world-gen-re-enqueued' }`. |
| `world_ready` | 409 Conflict (`code: 'nothing_to_resume'`) |
| `character_creation` (active or failed) | **422 Unprocessable Entity** (per RFC 9110 — 501 is wrong here; the method is implemented, just not for this state) with `{ code: 'phase_resume_not_yet_implemented', phase: 'character_creation' }`. The downstream ticket ID is logged server-side, NOT returned in the body (Roc-Imp6) |
| `post_creation` (active or failed) | Same as above with `phase: 'post_creation'` |
| `complete` | 409 Conflict (`code: 'already_complete'`) |
| `failed` | 409 Conflict (`code: 'terminal_failure'`) — generic terminal failure phase from MYT-50's union; admin action required |
| `not_started` | **Recovery path** (Phoenix-Imp4 + Hydra-Imp1): check whether a BullMQ job exists for `campaignId`. If yes → 409 `code: 'world_gen_in_progress'` (raced with first enqueue). If no → re-enqueue `world-gen` job; this is the Redis-blip recovery path documented in the create-flow failure modes. 202 with `{ campaignId, action: 'world-gen-enqueued-after-orphan-recovery' }`. |

**HTTP status code semantics summary** (Phoenix-Imp1/2/3):
- **402** is NEVER used for `insufficient_credits`. Use **403 Forbidden** with `code: 'insufficient_credits', creditType: 'world_gen'` (402 is reserved for actual Stripe/payment-instrument failures — would collide with billing flows).
- **409** uses `Retry-After` header on transient states (`world_gen_in_progress`) so polling clients back off correctly. Terminal-state 409s have no `Retry-After`.
- **422** is used (not 501) for "valid request shape but action not yet supported in this state." 501 is reserved for "method not implemented at all," which doesn't apply here.

**Error envelope discriminated union** (Phoenix-Imp7) — every error response from this surface conforms to one of these shapes, declared in `backend/src/contract/pipeline-errors.ts` and validated at boot:

```ts
type PipelineRouteError =
  | { code: 'concept_rejected', reason: '...', rejectionMessage: string, synthesizedConcept?: string }
  | { code: 'insufficient_credits', creditType: 'world_gen' | 'session' }
  | { code: 'queue_full', retryAfterSeconds: number }
  | { code: 'rejection_storm_cooldown', retryAfterSeconds: number }
  | { code: 'world_gen_in_progress' }
  | { code: 'phase_not_yet_implementable', stuckAtStage: string }
  | { code: 'world_gen_capped' }
  | { code: 'nothing_to_resume' }
  | { code: 'already_complete' }
  | { code: 'terminal_failure' }
  | { code: 'phase_resume_not_yet_implemented', phase: 'character_creation' | 'post_creation' }
  | { code: 'concurrent_generation_in_progress' }   // Kraken-Imp7
  // Standard Fastify body-parse / Zod errors stay as 400; not enumerated here
```

The API contract is stable from day one; downstream tickets just flip the 422 stubs to real handling.

### D11. Cost-cap: per-stage read with refund-on-fire

**Revised after Hydra-C3, Kraken-C1, Roc-Imp2/3.** Three changes from the original "in-memory + 5min TTL" approach:

1. **Read the cap value at the start of EACH stage, not every 5 minutes.** One cheap PK SELECT per stage (5 reads per world-gen run). The 5-minute TTL window was a premature optimization that created an operator-emergency-response gap — if an operator sees a runaway and lowers the cap, they want the next stage to observe it immediately. The per-stage read cost is negligible against the LLM call cost.

2. **Refund on cost-cap fire.** When the breaker activates:
   - Set `worlds.status = 'failed'` (not "still generating, ticket support" — Hydra-C3 contradiction).
   - INSERT `credit_ledger` row: `{ amount: +1, credit_type: 'world_gen', source_type: 'cost_cap_refund', source_purchase_id: null, source_billing_history_id: null }` inside the same transaction as the stage's `pipeline_runs.status='failed'` UPDATE.
   - Publish `phase: world_gen_failed` event with `error_code: 'world_gen_cost_cap_exceeded'`.
   - `derivePhase` now sees `world.status='failed'` and reports `world_gen_failed` cleanly.
   - Resume returns 409 `code: 'world_gen_capped'` (per D10 revisions) — operator must adjust the cap before user can retry, OR an admin uses `/api/dev/credits/grant` to issue a fresh credit.

3. **Boot-load fails loudly on parse failure** (Roc-Min3): if `settings.world_gen_cost_cap_usd` is absent or unparseable, the worker refuses to start. No silent fallback to a default — a misconfigured row is a wallet-drain risk.

The cost-cap check itself: SUM `pipeline_runs.cost_usd` for `(world.id, NULL user) WHERE status = 'completed'` — explicit completed-status filter (Wyvern-Imp4). Failed-stage rows don't contribute to the cap (they represent un-charged work). Paint-job validator retry costs DO accumulate into stage 1's row's `cost_usd` (per D6), so they're correctly observed by the cap on each iteration.

### D12. Pipeline-routes contract enforcement at boot — inverted

**Revised after Phoenix-C2 + Roc-Imp9.** Original spec checked routes against a prefix list, which (a) only governed one URL family, (b) silently let `/api/campaign/...` (singular typo) through, and (c) required two files to stay in sync.

**Inverted approach:** routes declared in `PIPELINE_ROUTES` carry a `routeOptions.config.pipelineRoute = true` marker. The boot hook enforces both directions:

1. **Forward (declared → mounted):** every entry in `PIPELINE_ROUTES` must have a corresponding registered route at boot. Hook collects the registered set during `onRoute`, then in an `onReady` check, verifies every declared route is present. Missing → throw.
2. **Reverse (mounted → declared):** every route with `config.pipelineRoute === true` must appear in `PIPELINE_ROUTES`. Catches "registered but not declared" — the common drift case.

```ts
// Pseudocode
const registeredPipelineRoutes = new Set<string>()

app.addHook('onRoute', (route) => {
  if (!APPROVED_VERBS.includes(route.method)) return                        // skip HEAD/OPTIONS
  if (route.config?.pipelineRoute !== true) return                          // not a pipeline route
  const key = `${route.method} ${route.url}`
  registeredPipelineRoutes.add(key)
  if (!PIPELINE_ROUTES.includes(key)) {
    throw new Error(
      `Pipeline route ${key} is registered with config.pipelineRoute=true ` +
      `but not declared in pipeline-routes.ts`
    )
  }
})

app.ready(async () => {
  const missing = PIPELINE_ROUTES.filter(k => !registeredPipelineRoutes.has(k))
  if (missing.length > 0) {
    throw new Error(`Pipeline routes declared but not registered: ${missing.join(', ')}`)
  }
})
```

`APPROVED_VERBS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH']` — HEAD/OPTIONS are explicitly out-of-contract (Phoenix-Imp6).

The opt-in `config.pipelineRoute` marker means dev-only routes (like `/api/dev/credits/grant`) and other non-pipeline families (`/api/billing/*`, `/api/users/*`) are simply not marked and pass through unchecked. No prefix-pattern matching needed.

### D13. Dev-only credit grant route — defense in depth

A `/api/dev/credits/grant` route registers only when `AUTH_MODE === 'bypass'`. Same gating as the bypass-auth plugin itself; production never sees it.

**Revised after Roc-C1** — even though the route is gated by 6 bypass-plugin defense layers, hardening the route itself adds belt-and-suspenders against a regression of any of those layers.

**Body (strict Zod schema):**

```ts
{
  creditType: z.enum(['world_gen', 'session']),
  amount: z.number().int().positive().max(100),       // hard cap; no unlimited grants
}
```

Refuses non-integer / negative / >100 / unknown-credit-type bodies.

**Identity handling:** unlike other bypass routes, this route does NOT honor the `x-mythrun-dev-sub` header — credit grants always apply to the fixed default bypass user (`bypass:dev-1`). The dev-tool's identity switcher selects the active sub for normal API calls, but credit grants target the canonical bypass identity. If a dev needs credits as a non-default sub, they edit the DB directly (the smoke-test setup script already does this).

**Rate limit:** `{ max: 30, timeWindow: '1 hour', keyGenerator: req => req.ip }`. Even in dev, a buggy test hammering this route shouldn't run unbounded.

**Persistence:** inserts a positive-amount `credit_ledger` row with `source_type='admin'`. Same source-link constraint as production refunds.

Used by:
- The cost-cap smoke test (set cap low, run gen, breaker fires + refunds; grant additional credits, repeat).
- The dev tool's credit-ledger debug view's force-grant button (default amount: 5, configurable).

---

## Detailed flows

### POST /api/campaigns flow

```
1. Validate body (Zod). Reject 400 on shape mismatch.
2. **Cheap pre-checks first (revised — Wyvern-Min7, Kraken-Imp5, Hydra-Min2):** reject expensive paths before spending Sonnet $.
     a. Rate-limit check (5/min per-sub) — Fastify @fastify/rate-limit fires here (BEFORE handler body), so this is automatic from the route config.
     b. **Concurrent-generation guard (Kraken-Imp7):** SELECT campaigns.id WHERE created_by=$user AND world_id IN (SELECT id FROM worlds WHERE status='generating'). If any row → 409 `code: 'concurrent_generation_in_progress'`. User must wait for the in-flight gen to finish/fail before starting another.
     c. **Rejection-storm cooldown (D5 — Kraken-C3):** Redis read of `rejection_count:{userId}` in the last hour. If ≥ 3 → 429 `code: 'rejection_storm_cooldown'`, Retry-After header pointing at when the window expires.
     d. **Credit balance peek** (read-only, no advisory lock yet): SELECT COALESCE(SUM(amount), 0) FROM credit_ledger WHERE user_id=$1 AND credit_type='world_gen'. If < 1 → 403 `code: 'insufficient_credits', creditType: 'world_gen'`. (Phoenix-Imp1: use 403, not 402 — 402 reserved for Stripe-instrument failures.)
     e. **Queue-depth admission:** queueDepth = await worldGenQueue.getJobCounts(['waiting', 'active', 'delayed']) — count includes all pre-completion states (Hydra-Imp4). If > 20 → 503 `code: 'queue_full'` + `Retry-After: 60` header.
3. **Now the LLM calls (only after preconditions pass):**
     a. If world.kind === 'new' && source.mode === 'guided':
        synth = await synthesize(source.picks)         // Sonnet call
        concept = synth.concept
        intentSummary = synth.intentSummary
     b. Else (mode === 'freeform'):
        concept = source.concept
        intentSummary = null
4. gate = await inputGate(concept, intentSummary)         // Sonnet call (3 axes); intentSummary is ALSO judged
                                                          // (Roc-Imp7 prompt-injection mitigation: title strings
                                                          // pass through the gate, not around it)
   If gate.verdict === 'reject':
     INCR rejection_count:{userId} with 1h TTL
     Return 422 {
       code: 'concept_rejected',
       reason: gate.reason,
       rejectionMessage: gate.rejectionMessage,           // max 400 chars, plain text
       synthesizedConcept: (guided mode only) concept     // lets user see what was judged
     }
5. **BEGIN transaction** (revised — Roc-Imp1 UUID-cast fix):
   SET LOCAL lock_timeout = '5s';                         // stuck holder gets killed, not held forever
   SET LOCAL statement_timeout = '10s';
   SELECT pg_advisory_xact_lock(hashtextextended(users.id::text, 0));
   // ^^ UUIDv7 can't cast to bigint directly; hashtextextended produces a bigint from the uuid as text.
   // Re-read balance under the lock (the pre-check at step 2d was a peek; this is the authoritative read):
   balance = SELECT COALESCE(SUM(amount), 0) FROM credit_ledger
             WHERE user_id=$1 AND credit_type='world_gen'
             AND (expires_at IS NULL OR expires_at > now())
   If balance < 1:
     ROLLBACK; return 403 { code: 'insufficient_credits', creditType: 'world_gen' }
     // (peek may have been stale if a concurrent debit landed; the locked re-check is authoritative)
   INSERT worlds (id, created_by, name=body.name, concept=<the concept>, status='generating')
     RETURNING id AS world_id
     // ^^ World inherits the campaign name as its default. Stage 1 may overwrite worlds.name with an
     //    LLM-generated original; the FE renders worlds.name when present, falls back to campaigns.name
     //    otherwise (Kraken-Imp1 reconciliation).
   INSERT campaigns (id, world_id, created_by, name=body.name, status='setup') RETURNING id AS campaign_id
   INSERT campaign_members (id, campaign_id, user_id, role='owner', invite_accepted=true)
   INSERT credit_ledger (id, user_id, credit_type='world_gen', amount=-1,
                         source_type='debit', source_purchase_id=NULL, source_billing_history_id=NULL)
   INSERT pipeline_runs (id, world_id=world_id, stage='concept_intake', status='pending',
                         started_at=NULL, user_id=NULL)
     // ^^ Seed row so a missed-enqueue presents as world_gen_failed (not not_started),
     //    making the Redis-blip recovery path observable to resume (Phoenix-Imp4, Hydra-Imp1).
   COMMIT
6. **Reset rejection_count** for this user (proves they can produce a passing concept): DEL rejection_count:{userId}
7. await worldGenQueue.add('world-gen', { campaignId }, { jobId: campaignId })
8. Return 201 { campaignId }    // NOT worldId — Phoenix-Min7: don't leak the world's existence to FE
```

**Failure modes:**

- Step 2 reject → no LLM call, no debit, no rows inserted. Cheapest reject.
- Step 4 reject → 1 Sonnet call burned (gate; plus synth if guided). No debit, no rows inserted.
- Step 5 ROLLBACK on insufficient credits → no orphaned rows. User sees 403.
- Step 5 COMMIT then step 7 enqueue fails (Redis blip) → the seeded pipeline_runs row + campaign + world stay; `derivePhase` sees the pending row and reports `world_gen_failed` (no row movement). Recovery: `POST /api/campaigns/:id/resume` enqueues normally per D10's revised `not_started`/`world_gen_failed` paths.
- Step 7 succeeds → caller's responsibility to poll `GET /api/campaigns/:id/status/stream` for progress (status-surface ticket).

**Idempotency:** the route is NOT idempotent at the create level (no idempotency key in body). The concurrent-generation guard (step 2b) prevents the double-submit foot-gun: a second submission while one is in-flight returns 409 immediately. Two genuinely-separate creates (one finishes, user creates another) work as intended.

### Sonnet synthesizer (guided mode)

**Model:** `claude-sonnet-4-6` (existing config constant).
**Prompt:** stored at `backend/src/llm/prompts/prep/synthesize-concept.txt`. Authored, not ported (prototype doesn't have this flow).

**System prompt outline:**
```
You are synthesizing an original D&D world concept from a list of media inspirations.

The user has named 3 pieces of media they enjoy and explained what they like about each.
Your job is to produce an ORIGINAL concept that draws on the cross-section of their
tastes — themes, aesthetic, tone, archetypes — without echoing the source titles
or naming any copyrighted entities. The output must read as a fresh original world,
not a "[Source A] meets [Source B]" pitch.

Constraints:
- No proper nouns from the source media.
- No paint-job characters or settings.
- 150-400 words for the concept field.
- Distill the user's stated values into the intentSummary structure.

Return: { concept: string, intentSummary: { aesthetics, themes, sourcePicksAcknowledged } }
```

Zod schema validates the response. Vercel SDK's `maxRetries: 3` handles schema-fail retries.

### Sonnet input gate

**Model:** `claude-sonnet-4-6`.
**Prompt:** `backend/src/llm/prompts/prep/input-gate.txt`. Authored.

**System prompt outline (paraphrased — actual prompt is iterated in implementation):**
```
You are reviewing a proposed D&D world concept for three concerns:

1. SRD compatibility. Can D&D 5e mechanics (classes, spells, monsters, dice-based
   action resolution) support the fiction this concept implies? Bias permissive.
   Reject ONLY if the concept describes a setting with no room for ANY supernatural,
   fantastical, or class-fantasy element (a courtroom drama, a journalism procedural,
   a relationship film). If the user could plausibly add supernatural elements
   ("a Union regiment that encounters something at Antietam"), allow.

2. Clone intent. Is the user requesting a verbatim clone of copyrighted intellectual
   property? Distinguishing factor is INTENT, not entity mentions:
   - "A world with a magic system like Harry Potter's" → ALLOW (reference)
   - "Inspired by Naruto, but with original characters" → ALLOW (inspiration)
   - "I want a world set at Hogwarts" → REJECT (clone intent)
   - "Recreate the Star Wars universe" → REJECT (clone intent)

3. Other. If for any reason you would decline to help develop this concept further
   — content you find genuinely problematic, requests you would not engage with —
   return verdict: 'reject', reason: 'inappropriate', and explain.

Output structured JSON. Confidence is calibrated 0..1. Reject only when confident
(>0.85). Borderline = allow.

For rejections, draft a rejectionMessage that's helpful and brand-tone (terse,
respectful, suggests a constructive path forward — not preachy, not bureaucratic).
```

Output schema:
```ts
{
  verdict: 'allow' | 'reject',
  axes: {
    srd_compat:  { fits: boolean, confidence: number, reasoning: string },
    clone_intent:{ flagged: boolean, confidence: number, reasoning: string },
    inappropriate:{ flagged: boolean, reasoning: string }  // confidence omitted; this is binary
  },
  reason: 'srd_incompat' | 'clone_intent' | 'inappropriate' | null,
  rejectionMessage: string | null
}
```

### Worker — world-gen processor

**Queue name:** `world-gen` (per spec §6).
**Concurrency:** 3 (per spec §6).
**Connection:** `redisBatch`.

**Job processor:**

```
1. Read campaign + world via repo.campaigns.getById(campaignId)
2. Publish phase=world_gen event on pipeline:campaign:{campaignId}
3. capUsd = await readCostCap()    // PK SELECT from settings; fresh per job (D11 revision)
4. For each stage in [concept_intake, world_and_factions, locations_and_npcs,
                      starting_situation, random_tables]:
     a. existing = repo.pipelineRuns.getByScopeAndStage(world.id, stage, null)
     b. If existing?.status === 'completed': continue
        If existing?.status === 'running' AND existing.started_at < now() - INTERVAL '5 minutes':
          // 5min threshold (Hydra-Imp2, Phoenix-Min8): real Opus calls under load can
          // exceed 60s. 5min is comfortably above p99 for any single stage; a stuck-
          // longer-than-5min stage genuinely needs reset.
          //
          // Atomic claim (Hydra-Imp5):
          claimed = await UPDATE pipeline_runs
                    SET status='running', started_at=now(), worker_id=$myWorkerId
                    WHERE world_id=$1 AND stage=$2 AND user_id IS NULL
                      AND status='running' AND started_at < now() - INTERVAL '5 minutes'
                    RETURNING id
          If claimed is empty: another worker raced and won the reset; re-fetch and reconsider
          // (this fall-through is safe — re-fetch will see status='running' fresh now or
          //  'completed' if the racer finished it)
     c. Publish stage-started event
     d. Atomic claim for fresh starts (Hydra-Imp5):
        INSERT INTO pipeline_runs (id, world_id=$1, stage=$2, status='running',
                                   started_at=now(), user_id=NULL, worker_id=$myWorkerId)
        ON CONFLICT (COALESCE(world_id, campaign_id), stage, COALESCE(user_id, sentinel))
        DO UPDATE SET status='running', started_at=now(), worker_id=$myWorkerId,
                      completed_at=NULL, cost_usd=0, input_tokens=0, output_tokens=0, error=NULL
        WHERE pipeline_runs.status IN ('pending', 'failed')
        RETURNING id
        If RETURNING is empty: a concurrent worker won this stage; skip (status is now 'running'
        or 'completed' by them).
     e. Heartbeat: job.updateProgress(stage)
     f. Run the stage's handler:
        - concept_intake: paint-job-validator-wrapped generateObject + persist worlds columns.
                          ALL validator iterations (draft + judge calls + retries) accumulate
                          into the stage's cost_usd (D6 fix).
        - world_and_factions: stageNotImplementedHandler → throw StageNotImplementedError
        - locations_and_npcs: stageNotImplementedHandler → throw
        - starting_situation: generateObject + persist worlds.starting_situations
        - random_tables: generateObject + persist random_tables + random_table_entries
     g. On stage success (inside transaction):
        UPDATE pipeline_runs SET status='completed', completed_at=now(),
                                 cost_usd=$cumulativeForStage, input_tokens=..., output_tokens=...
        COMMIT
        Publish stage-completed event
        Check cost cap: SELECT SUM(cost_usd) FROM pipeline_runs
                        WHERE world_id=$1 AND user_id IS NULL AND status = 'completed'
                        // ^^ explicit completed-filter (Wyvern-Imp4): failed-stage rows
                        //    don't contribute (they represent un-charged work).
        If sum > capUsd:
          BEGIN
            UPDATE pipeline_runs SET status='failed', error='world_gen_cost_cap_exceeded'
                                  WHERE id=$thisRunId
            UPDATE worlds SET status='failed' WHERE id=$1
            INSERT credit_ledger (id, user_id=$ownerId, credit_type='world_gen', amount=+1,
                                  source_type='cost_cap_refund',
                                  source_purchase_id=NULL, source_billing_history_id=NULL)
          COMMIT
          Publish stage-failed + phase=world_gen_failed events
          exit loop
        Publish cost-update event (cumulative)
     h. On stage failure (incl. StageNotImplementedError) (inside transaction):
        UPDATE pipeline_runs SET status='failed', error=$sanitizedError, completed_at=now()
        // sanitized via backend/src/llm/errors.ts (Roc-Imp8): only error.code +
        // a whitelisted message preview lands here; raw err chain stays in CloudWatch
        // worker logs but never in pipeline_runs.error or stage-failed event payloads.
        COMMIT
        Publish stage-failed event
        Throw → BullMQ retries per retry-policy table
5. If loop completed without exception:
     UPDATE worlds SET status='complete'
     Publish phase=world_ready event
```

**Retry policy** (per spec §6 + amended for this ticket):

| Failure mode | Retries | Backoff |
|---|---|---|
| Postgres FK / type / unique error | 0 | n/a — code bug, fail fast |
| LLM call timeout | 2 | exponential 30s/2m |
| Schema-fail re-roll (Vercel SDK internal) | 3 | per SDK config |
| Paint-job validator exhaustion | 0 | n/a — fail stage, surface as world_gen_failed |
| Cost cap exceeded | 0 | n/a — circuit-breaker |
| `StageNotImplementedError` (stages 2, 3) | 0 | n/a — expected stop |
| Transient infra (Redis blip, BullMQ failure) | 3 | exponential 30s/2m/8m |

### POST /api/campaigns/:campaignId/resume flow

```
1. Auth: requireCampaignMember(role='owner')
2. campaign = repo.campaigns.getById(campaignId)
3. snapshot = await loadSnapshot(campaignId)         // reuses status-surface logic
4. switch (snapshot.phase) {
     case 'world_gen_failed': {
       // Inspect the specific failure to avoid loop-forever scenarios:
       const stuckRun = await pipelineRunsRepo.getLatestFailedForWorld(campaign.world_id)
       if (stuckRun?.error?.includes('stage_not_implemented')) {
         return 409 { code: 'phase_not_yet_implementable', stuckAtStage: stuckRun.stage }
         // ^ Kraken-Imp4: don't re-enqueue a guaranteed-fail loop. User waits for the
         //   downstream ticket to ship.
       }
       if (stuckRun?.error?.includes('world_gen_cost_cap_exceeded')) {
         return 409 { code: 'world_gen_capped' }
         // ^ Cost-cap fired (D11): the refund is already in the ledger; admin must
         //   adjust the cap before this user can retry. UI surfaces "this generation
         //   exceeded its budget — your credit was refunded; contact support to retry."
       }
       await worldGenQueue.add('world-gen', { campaignId }, { jobId: campaignId })
       return 202 { campaignId, action: 'world-gen-re-enqueued' }
     }
     case 'not_started': {
       // Redis-blip orphan recovery path (Phoenix-Imp4, Hydra-Imp1).
       // The create transaction seeds a pending pipeline_runs row, so 'not_started'
       // should be rare. If we land here, it's the post-COMMIT pre-enqueue failure case.
       const existingJob = await worldGenQueue.getJob(campaignId)
       if (existingJob && !existingJob.isCompleted() && !existingJob.isFailed()) {
         return 409 { code: 'world_gen_in_progress' }
       }
       await worldGenQueue.add('world-gen', { campaignId }, { jobId: campaignId })
       return 202 { campaignId, action: 'world-gen-enqueued-after-orphan-recovery' }
     }
     case 'character_creation':
       return 422 { code: 'phase_resume_not_yet_implemented', phase: 'character_creation' }
       // ^ Phoenix-Imp3: 422 not 501 (method IS implemented, just not for this state).
       //   Downstream ticket ID logged server-side, not returned (Roc-Imp6).
     case 'post_creation':
       return 422 { code: 'phase_resume_not_yet_implemented', phase: 'post_creation' }
     case 'world_gen':
       reply.header('Retry-After', '30')
       return 409 { code: 'world_gen_in_progress' }
     case 'world_ready':
       return 409 { code: 'nothing_to_resume' }
     case 'complete':
       return 409 { code: 'already_complete' }
     case 'failed':
       return 409 { code: 'terminal_failure' }
     default:
       return assertNever(snapshot.phase)   // Phoenix-C1 exhaustiveness check
   }
```

### Boot-time pipeline-routes enforcement

**Revised after Phoenix-C2 + Roc-Imp9 — see D12 for the inverted approach. The below pseudocode reflects the old prefix-based design and is retained ONLY as a historical reference; implementer should follow D12's `config.pipelineRoute = true` opt-in marker pattern.**

~~Original pseudocode (deprecated):~~

```ts
const PIPELINE_ROUTE_PREFIXES = ['/api/campaigns/']  // exported from pipeline-routes.ts

app.addHook('onRoute', (route) => {
  if (!isHttpMethod(route.method)) return                    // skip HEAD etc.
  const matchesPrefix = PIPELINE_ROUTE_PREFIXES.some(p => route.url.startsWith(p))
  if (!matchesPrefix) return
  const key = `${route.method} ${route.url}`
  if (!PIPELINE_ROUTES.includes(key)) {
    throw new Error(
      `Pipeline route ${key} is registered but not declared in pipeline-routes.ts. ` +
      `Add it to PIPELINE_ROUTES (and dev-tool/coverage.json if it's a user-facing route).`,
    )
  }
})
```

**Tests:**
- Fixture app with a fake `/api/campaigns/unauthorized` route → `app.ready()` rejects.
- Fixture app with `/api/campaigns/:campaignId/status` (already in contract) → boots clean.

---

## Dev tool surface

### Campaign create panel

**Component:** `backend/dev-tool/src/components/campaign-create-panel.ts`.

Mode toggle (radio): `freeform` (default) | `guided`.

**Freeform mode:**
- Single textarea for concept.
- Optional name input (defaults to "Untitled Campaign" if empty).
- Submit button.

**Guided mode:**
- 3 rows of `{ title input, why-I-like-it textarea }`.
- Name input (same as freeform).
- Submit button.

On submit:
- POST to `/api/campaigns` via the existing `apiCall` wrapper.
- On 201: capture `campaignId`, programmatically set the status-panel's `input.value = campaignId`, click the panel's `Watch` button. UI flows seamlessly from "I just made a campaign" to "watching it generate."
- On 422 (`concept_rejected`): render `rejectionMessage` **via `textContent`** (not `innerHTML`; Roc-C2 XSS mitigation) above the form. If `synthesizedConcept` is present (guided-mode reject), render it as a collapsed "see what was judged" expander so the user can either rephrase their picks or toggle the form to freeform mode and edit the synthesis directly (Kraken-C2).
- On 403 (`insufficient_credits`): render "insufficient world_gen credits" with a one-click link to the credit-grant button.
- On 409 (`concurrent_generation_in_progress`): render "you already have a world generating; wait for it to finish or fail before starting another." Disable the submit button until the user's other in-flight campaign settles.
- On 429 (`rejection_storm_cooldown`): render "you've had several rejections recently — try a wholly different framing, or pause for an hour" with the `Retry-After` countdown.
- On 503 (`queue_full`): render "service busy, retry in N seconds" with a countdown from `Retry-After`.

**Identity-switcher coupling** (Kraken-Imp6): when the identity switcher changes the active sub, the create panel resets all input + clears any rendered rejection / error state, AND the status panel's active watcher is closed (per the dev-tool's general "identity switch closes all panel state" rule that should land in this ticket's dev-tool main.ts changes).

### Campaign details panel

**Component:** `backend/dev-tool/src/components/campaign-details-panel.ts`.

Renders below the status panel. Reads `GET /api/campaigns/:campaignId` and lays out:
- Campaign name + ID
- World name + concept (truncated to ~200 chars with expand toggle)
- Member list (just dev-user-1 at launch since only the owner exists)
- World tone / themes / geography_summary / political_summary / era / key_tensions (rendered when stage 1 completes)
- Starting situations (rendered when stage 4 completes)
- Random tables (rendered when stage 5 completes)
- (Entities + prose kernels + facts come from stages 2 + 3 → not rendered until the next ticket ships)

### Credit ledger debug panel

**Component:** `backend/dev-tool/src/components/credit-ledger-panel.ts`.

Renders below the identity switcher in the page header. For the current dev user:
- Current balance per credit type (`world_gen`, `session`)
- Last 20 ledger entries: timestamp, type, amount (signed), source_type, optional source_id
- Force-grant button: POST to `/api/dev/credits/grant` with `{ creditType: 'world_gen', amount: 5 }` (default).

The force-grant is the cost-cap smoke loop's enabler — without it, every iteration of "set cap low, run gen, watch breaker fire" requires manual DB writes.

### Resume button

Renders on the campaign details panel when `phase === 'world_gen_failed'`. POST to `/api/campaigns/:campaignId/resume`. On 202, re-runs the watch flow on the status panel.

### Coverage manifest update

Add to `backend/dev-tool/coverage.json`:

```json
{
  "routes": [
    // ... existing 2 routes from MYT-50 ...
    "POST /api/campaigns",
    "GET /api/campaigns/:campaignId",
    "GET /api/campaigns/mine",
    "POST /api/campaigns/:campaignId/resume",
    "POST /api/dev/credits/grant"
  ],
  "events": [
    // ... 11 entries from MYT-50 (none change) ...
  ],
  "jobs": [
    "world-gen"   // new
  ],
  "exempt": {
    "routes": {},
    "events": {
      // ... 5 entity-event arms still exempt per MYT-50; MYT-52 flips them ...
    },
    "jobs": {}
  }
}
```

`backend/src/contract/pipeline-routes.ts` and `pipeline-jobs.ts` get matching entries.

---

## Files affected

### New files

```
backend/src/routes/__tests__/campaigns-create.test.ts
backend/src/routes/__tests__/campaigns-resume.test.ts
backend/src/routes/__tests__/campaigns-details.test.ts
backend/src/routes/__tests__/campaigns-list.test.ts
backend/src/llm/prep/synthesize-concept.ts
backend/src/llm/prep/synthesize-concept.test.ts
backend/src/llm/prep/input-gate.ts
backend/src/llm/prep/input-gate.test.ts
backend/src/llm/prep/paint-job-validator.ts
backend/src/llm/prep/paint-job-validator.test.ts
backend/src/llm/prep/stages/concept-intake.ts
backend/src/llm/prep/stages/concept-intake.test.ts
backend/src/llm/prep/stages/starting-situation.ts
backend/src/llm/prep/stages/starting-situation.test.ts
backend/src/llm/prep/stages/random-tables.ts
backend/src/llm/prep/stages/random-tables.test.ts
backend/src/llm/prep/stages/stage-not-implemented.ts
backend/src/llm/prep/world-gen-processor.ts
backend/src/llm/prep/world-gen-processor.test.ts
backend/src/llm/prep/cost-cap.ts
backend/src/llm/prep/cost-cap.test.ts
backend/src/llm/prompts/prep/synthesize-concept.txt
backend/src/llm/prompts/prep/input-gate.txt
backend/src/llm/prompts/prep/paint-job-validator.txt
backend/src/llm/prompts/prep/concept-intake.txt          (ported + adjusted)
backend/src/llm/prompts/prep/starting-situation.txt      (ported + adjusted)
backend/src/llm/prompts/prep/random-tables.txt           (ported + adjusted)
backend/src/repo/pipeline-runs.ts                        (already exists from MYT-50; this ticket adds writers)
backend/src/repo/campaigns.ts                            (existing — extends with creation transaction helper)
backend/src/repo/__tests__/campaigns-create-tx.test.ts
backend/src/repo/credit-grants.ts                        (dev-only)
backend/src/routes/dev-credits.ts                        (dev-only)
backend/src/auth/__tests__/pipeline-routes-enforcement.test.ts
backend/dev-tool/src/components/campaign-create-panel.ts
backend/dev-tool/src/components/campaign-details-panel.ts
backend/dev-tool/src/components/credit-ledger-panel.ts
docs/wiki/content/runtime/world-gen.html
docs/wiki/diagrams/runtime/world-gen.dot
```

### Modified files

```
backend/src/app.ts                              # register campaignsCreateRoutes, devCreditsRoutes; install pipeline-routes onRoute hook
backend/src/routes/campaigns.ts                 # extend with create/get/list/resume (status routes already present from MYT-50)
backend/src/contract/pipeline-routes.ts         # add 5 routes
backend/src/contract/pipeline-jobs.ts           # add "world-gen"
backend/dev-tool/coverage.json                  # add 5 routes + 1 job
backend/dev-tool/src/main.ts                    # mount new panels
backend/migrations/0XX_settings_world_gen_cost_cap.sql  # INSERT default row only if absent
docs/wiki/structure.ts                          # add world-gen page entry
```

---

## Out of scope

- World sharing (reuse a world across campaigns) → post-launch
- Streaming stages 2 + 3 → MYT-52
- Per-player character creation → MYT-53
- Barrier + post-creation stages → MYT-54
- Admin override / force-allow for input-gate rejections → MYT-55 if needed
- Server-side idempotency keys on POST /api/campaigns → MYT-55 if needed
- Rate-limit / cost-tracking dashboards → MYT-55 hardening
- Production-grade content moderation beyond what Sonnet flags organically → MYT-55 if needed
- Settings hot-reload via Postgres LISTEN/NOTIFY (the 5min TTL is the launch trade-off) → post-launch

---

## Open questions

(none after brainstorming closed)

---

## Validation / testing

### Unit tests
- Synthesizer: mocked Sonnet returns three fixture-pick scenarios → assert concept doesn't echo source titles.
- Input gate: mocked Sonnet returns each axis's reject case → assert 422 response shape.
- Paint-job validator: mocked Sonnet reject-twice-then-allow → assert 2 retries + success. Mocked Sonnet reject-3-times → assert stage fails with the typed error.
- Cost cap: fixture cumulative cost vector exceeding cap → assert circuit-breaker fires after the offending stage.
- Stage-not-implemented: assert it records the typed failure without making any LLM call.

### Integration tests (real Postgres + Redis + mocked Anthropic)
- POST /api/campaigns happy path (freeform): asserts 201, ledger debited, BullMQ job enqueued, status panel receives `phase=world_gen` event.
- POST /api/campaigns happy path (guided): asserts synthesizer ran, synthesized concept used downstream.
- POST /api/campaigns insufficient credits: asserts 402, no rows inserted, no enqueue.
- POST /api/campaigns queue full: asserts 503 + Retry-After header, no debit.
- POST /api/campaigns input-gate reject (each axis): asserts 422 + structured response, no debit.
- POST /api/campaigns existing kind: asserts 501.
- POST /api/campaigns advisory-lock concurrency: two concurrent debits for same user → one succeeds, one waits and observes the new balance correctly.
- POST /api/campaigns/:id/resume world_gen_failed → asserts new BullMQ job with the same campaignId.
- POST /api/campaigns/:id/resume each unimplemented phase → asserts 501 with the correct futurePathTicket.
- Boot-time pipeline-routes hook: fixture app with an unauthorized pipeline route → asserts `app.ready()` rejects.

### End-to-end staging smoke (per the Linear ticket's "Done when")
- Create campaign via dev tool (freeform).
- Stages 1, 4, 5 run; stages 2, 3 fail with `stage_not_implemented`; phase → `world_gen_failed`.
- Status panel shows the failure with clean reason.
- Credit ledger debug view shows balance decremented by 1.
- Force-grant 5 credits via the dev panel.
- Set cost cap to $0.50 via the settings table.
- Create another campaign; assert cost-cap breaker fires after stage 1 (~$0.30 expected) or stage 4 (~$0.85 cumulative).
- Force-grant + reset cap, create another, exercise resume by manually `UPDATE pipeline_runs SET status='failed'` mid-run (or wait for stage 2 to fail), click resume → assert re-enqueue.

### Wiki page
- New page `docs/wiki/content/runtime/world-gen.html` covering: the create flow, the synthesizer, the input gate (three axes), the paint-job validator, stage taxonomy + which are wired in this ticket vs the next, cost cap mechanism, resume semantics, dev tool surface.
- Cross-link to the status-surface page (event source) and the worker page (BullMQ processor lifecycle).

---

## Estimate

~3 days of implementation work (the heaviest ticket in the milestone outside the streaming-stages one). Breakdown:

| Slice | Estimate |
|---|---|
| LLM prompts (synthesize, input gate, paint-job validator, 3 stage prompts) — write + iterate | 1 day |
| Sonnet caller wrappers + Zod schemas + tests | 0.5 day |
| Worker processor + stage registry + cost-cap + retry policy + tests | 0.75 day |
| Route handlers (create, details, list, resume) + tests | 0.5 day |
| Dev tool panels (create, details, credit ledger) | 0.5 day |
| Wiki page + boot-time enforcement hook + smoke test | 0.5 day |

Most of the implementation work is in the LLM prompts and their iteration; the rest is straightforward scaffolding.

Estimate bumped to **~3.5 days** from the original 3, accounting for the round-1 review fixes (concurrent-generation guard, refund-on-cost-cap, inverted pipeline-routes hook, rejection-storm cooldown, distinct judge prompt for paint-job validator).

---

## Round 1 fixes appendix

Findings from the 5-reviewer blind review (Phoenix / Hydra / Wyvern / Roc / Kraken) and how they were applied. 1 SHOWSTOPPER, ~30 NIT fixes folded inline.

**SHOWSTOPPER (Hydra-C2): BullMQ `jobId` permanent dedupe** — `queue.add(..., { jobId: campaignId })` silently no-ops when a terminal-state job with that ID exists. Fix: configure the world-gen queue with `removeOnComplete: { count: 0 }` + `removeOnFail: { count: 0 }` so terminal jobs are pruned immediately. Resume's `queue.add` then re-enqueues normally. (See D9.)

**Inline NIT fixes applied:**

API contract / HTTP semantics (Phoenix):
- 402 → 403 for `insufficient_credits` (402 reserved for Stripe payment-instrument failures).
- 501 → 422 for "valid request, action not yet implemented for this state" on the resume route.
- 409 with `Retry-After: 30` on `world_gen_in_progress` (transient).
- Drop the stubbed `kind: 'existing'` arm from the body union; unknown kinds produce standard Zod 400 instead.
- Resume switch is fully exhaustive over `PipelinePhase`'s 8 arms (including `'failed'`), with `assertNever` for compile-time check.
- HEAD/OPTIONS explicitly out-of-contract (`APPROVED_VERBS` list).
- Error envelope discriminated union exported in `pipeline-errors.ts`, boot-time check.
- Pipeline-routes hook inverted: `config.pipelineRoute = true` opt-in marker; forward + reverse checks at boot.
- 201 returns `{ campaignId }` only (not `worldId` — world is non-addressable per D1).

Concurrency / data integrity (Hydra):
- Cost-cap query explicitly filters `status='completed'`.
- Stuck-stage threshold bumped 60s → 5min; atomic `UPDATE ... WHERE ... RETURNING` claim, not check-then-update.
- `pipeline_runs` UPSERT semantics written out explicitly (ON CONFLICT target, RETURNING for atomic claim).
- Queue-depth admission counts `waiting + active + delayed`, not just `waiting`.
- Cost-cap value re-read at start of each stage (per D11 revision), not 5-min TTL — operator emergency response is immediate.
- Create transaction seeds a `pipeline_runs` pending row so post-COMMIT enqueue failure presents as `world_gen_failed`, observable to resume.

LLM orchestration (Wyvern):
- Paint-job validator's inner `generateObject` uses `maxRetries: 1`; validator loop is sole retry authority (no more Vercel SDK × validator fight).
- Retry prompt **discards prior draft**, raises temperature to ~1.0, instructs fresh direction — fixes the surface-rename failure mode.
- Distinct judge prompt for the paint-job validator (not a self-check).
- All validator iteration costs accumulate into stage 1's `cost_usd` (cost cap observes them).
- Aggregate confidence rule on input gate: two axes ≥ 0.70 → reject (catches the dual-near-miss case).
- Confidence semantic explicitly defined ("confidence in the negative finding").
- `intentSummary.sourcesInternal` (renamed from `sourcePicksAcknowledged`) is gated AND scoped — gate judges it; downstream prompts never see it.

Security (Roc):
- Concept field: `z.string().min(20).max(4000)`; pick title `max(200)`; pick reason `max(800)`.
- `rejectionMessage`: max 400 chars, plain text only, FE renders via `textContent` (XSS mitigation).
- `reasoning` field logged server-side, not returned in 422 (info-leak mitigation).
- `futurePathTicket` removed from response bodies (logged server-side instead).
- Advisory-lock cast fixed: `hashtextextended(users.id::text, 0)` (UUIDv7 can't cast to bigint).
- `SET LOCAL lock_timeout = '5s'; statement_timeout = '10s';` inside the credit transaction (DoS protection on stuck holders).
- `/api/dev/credits/grant`: strict Zod (amount ≤ 100 int positive); does NOT honor `x-mythrun-dev-sub` header; per-IP rate limit.
- Cost-cap parse failure now fails worker boot (no silent default).
- Error sanitization referenced explicitly for `pipeline_runs.error` and `stage-failed` event payloads.
- Pipeline-routes hook inverted (also a Phoenix finding; same fix).
- `intentSummary` flows to gate, not around it (prompt-injection mitigation).

Product / UX (Kraken):
- Concurrent-generation guard: 409 if user already has an in-flight world-gen.
- Cost-cap fire now: refund credit + `worlds.status='failed'` + clean resume path with 409 `world_gen_capped`.
- 422 rejection responses for guided-mode include `synthesizedConcept` so user can see what was judged.
- Rejection-storm cooldown: 3 rejections in 1h → 429 with help message.
- Resume on `stage_not_implemented` failures returns 409 `phase_not_yet_implementable` (no infinite-fail loop).
- World name inherits from campaign name; stage 1 may overwrite; FE renders with fallback.
- Identity-switcher closes all panel state on switch.

**NITs deferred to MYT-55 hardening** (per stopping rule — these are real but not launch-breaking):
- Prompt versioning + A/B framework (Wyvern-Imp7) — schema seam (`prompt_hash` column on pipeline_runs) added; full A/B infra deferred.
- LLM-judge eval for synthesizer output quality (Wyvern-Min6).
- Server-side idempotency keys on POST /api/campaigns (Wyvern-Imp1 / Kraken-Imp7's stronger variant) — concurrent-gen guard covers most cases.
- Settings hot-reload via LISTEN/NOTIFY (Roc-Imp3) — per-stage read is enough at launch.
- Production-grade 402 ↔ Stripe disambiguation flow (Phoenix-Imp1) — covered by using 403 here, but Stripe-flow alignment is a billing-side concern.
- CSRF posture documentation for dev routes (Roc-Imp10).
- Cost-cap default tuning + firing UX testing (Kraken-Min3) — the refund mechanism makes firing safe to test.

**Stopping rule verdict:** 1 SHOWSTOPPER → fix + ship. No round 2.
