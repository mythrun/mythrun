# MYT-73 — Scribe Reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** the in-session canonization layer that closes MYT-72's relay-only gap — an ephemeral session working set (read-after-write), an FT-emitted fact-delta, a per-turn secret tripwire, and a secret-preserving retcon delivered by a first-class correction turn.

**Architecture:** a new post-turn **Scribe job** (its own BullMQ queue, modeled on `st-evaluation-worker`) receives each turn's player-facing prose + the FT's parsed `worldDelta` + a turn-scoped ST-injection sink; it appends them to a Redis **working set** (embed-on-append, document vectors), runs a Haiku **secret tripwire** over the prose against the prep's core secrets, and on a breach runs an Opus **retcon-author** + enqueues a player-less **correction turn**. The §17.6 resolver reads working-set ∪ canon. Durable canon writes stay entirely in MYT-74.

**Tech Stack:** Node 24 + TS strict (exactOptionalPropertyTypes), Postgres (pgvector), Redis (ioredis), BullMQ, Anthropic via `llm/ai.ts` (`generateObject`+repair+`redactRawText`), Voyage embeddings, Zod, prompts as `.txt` via `loadPrompt('session', name, vars)`, Vitest (real PG → `mythrun_test`; LLM tests mock `'ai'`'s `generateText`; Redis tests ioredis-mock).

---

## Context primer (cross-cutting facts every implementer needs)

Read this even if your task is one file — these invariants span the feature.

1. **The flow.** Each turn: FT renders prose (+ optionally appends a `[[WORLD_DELTA]]` section); mid-turn world-lookups (MYT-72) may record ST injections. **After** the turn, a dedicated **Scribe job** (off the hot path) appends those proposals to the working set, runs the secret tripwire over the prose, and on a breach authors + delivers a retcon. Canon (durable PG) is **never written** here — MYT-74 owns that (spec §1, D1).

2. **Enforced ignorance is structural (the load-bearing invariant, spec §8).** The secret `sd_playbook` is read ONLY on the secret side — the tripwire (Haiku) + retcon-author (Opus), via the dedicated narrow `LookupVetRepo` surface MYT-72/T9 built (`repo.sessionPreps.getBy(campaignId, sessionNumber)`; resolve `sessionNumber` via `repo.sessions.getActiveByCampaign`). NEVER via `FtTurnContext` (secret-free) and NEVER widening `TurnWorkerRepo.sessionPreps` (the MYT-69 `{ftContext}`-only split). The tripwire's output is an **opaque control signal** (no secret-derived prose, no `why` field). The retcon `Z` is ST-authored to be secret-free (no secret, paraphrased or implied). The working set holds ONLY: MYT-72-vetted relays, public FT deltas (`tier:'known'`, parser-stamped), and secret-preserving `Z`. `FtTurnContext.workingSet` stays permanently `[]` — the FT reads the working set ONLY through the ST-vet relay, never as a context field.

3. **`redactRawText` is a `generateObject`-only option.** Both new LLM calls (tripwire, retcon-author) MUST go through `generateObject` (their outputs are flat Zod objects) with `redactRawText: true` — so a malformed response reasoning over secrets can't spill into the repair WARN log / `.diagnostic.rawTextSnippet`/`zodIssues` / SSE. LLM-boundary tests mock `'ai'`'s `generateText` (the SDK primitive `generateObject` wraps), per `st-lookup-vet.test.ts` — NEVER a raw `generateText` call in product code.

4. **Flat Zod roots; no `.max()` on free-prose; no `.refine`.** Tripwire/retcon/delta schemas are flat `z.object`. Free-prose fields (`retconText`) are `.min(1)` floors, NO `.max()`. NO `.refine` on the LLM-output schemas (the repair chain must not author a "valid" tree).

5. **Fail-soft vs fail-loud (spec §9; `feedback_fail_loud_on_external_api_misconfig`).** Transient LLM/embed failures degrade (log, re-fire next turn). An **unresolvable/empty `sd_playbook`** for the tripwire FAILS LOUD (`*_misconfigured`, alarmable) — a tripwire checking against zero secrets is a silently-disarmed safety gate. Discard-on-repair: a `repairAttempted` retcon tree was re-authored by a different model → fail-soft (no retcon this cycle).

6. **The data-flow path (spec §2.4 / D8) — the showstopper the blind review caught.** The FT prose + parsed delta + mid-turn ST injections reach the post-turn Scribe job via: (a) `FastThinker.render()` returns `worldDelta?` on the `AssistantMessage`; (b) `FtToolDeps.recordInjection(proposal)` is a turn-scoped sink the controller threads in, called synchronously inside the lookup tool `execute` on `mode:'invent'|'relay'`; (c) the controller enqueues a Scribe job carrying the rendered **player-facing prose** (post-delimiter-split), the `worldDelta`, and the injection-sink array. The MYT-72 vet surfaces are **widened** to actually carry `{mode, tier}` out of the tool (they currently drop them).

7. **The delimiter-guard (spec §4.2) guards BOTH sinks.** The FT delta rides a newline-anchored `\n[[WORLD_DELTA]]\n` section. The consume-loop guard suppresses it from BOTH `emit.emitText` (player stream) AND `assembler.pushTextDelta` (the transcript) — guarding only emit would persist the raw delimiter+JSON into the `dm_text` row + re-inject into FT history forever (the MYT-72 §6 permanent-leak). The matcher is **exact-literal**, newline-anchored, KMP-style re-anchor on divergence; flushes a pending partial at a tool/step boundary.

8. **Tests:** co-located `__tests__/`, real-PG → `mythrun_test` (scoped fixtures, `createTestPool`/`makeTestScope`/`guardTestDatabase`). LLM tests mock `'ai'` `generateText`. Redis tests use ioredis-mock. Run scoped: `pnpm vitest run <path>` (+ `--coverage --coverage.include='<src>'` for coverage on a new file). Verify lint via **`pnpm --filter @mythrun/backend lint` (= `eslint src`)**, NOT per-file (type-aware rules — `require-await`, `no-unsafe-assignment`, `non-nullable-type-assertion-style` — only fire over the whole tree; per-file reported clean then the pre-push failed, cost a cycle in MYT-72). `pnpm --filter @mythrun/backend typecheck` is authoritative over injected diagnostics + the plan's sketches; adjust property reads to the real interface, never loosen to `any`.

9. **Models:** `HAIKU` / `OPUS` from `llm/models.js`. Never hardcode model strings. Config constants in a `session/scribe-config.ts` (new), mirroring `world-lookup-config.ts`.

---

## File map / task-wave table

| Task | Files | Wave | Deps |
|---|---|---|---|
| T1 working-set types + schemas | `session/working-set/types.ts` (+ `llm/schemas/world-delta.ts`) | A | — |
| T2 WorkingSetRepo (Redis) | `redis/working-set.ts` | A | T1 |
| T3 secret-tripwire | `llm/secret-tripwire.ts` + schema + prompt | A | — |
| T4 retcon-author | `llm/retcon-author.ts` + schema + prompt | A | — |
| T5 searchLore widening | `world/retrieval/search.ts`, `world/retrieval/types.ts` | A | — |
| T6 MYT-72 vet-surface widening + injection sink | `session/world-fact-lookup.ts`, `tiers/lookup-wiring.ts`, `tiers/ft-tools.ts` | B | T1 |
| T7 FT delta + delimiter-guard | `tiers/fast-thinker.ts`, `tiers/types.ts`, `prompts/session/ft-system.txt` | B | T1 |
| T8 read-merge (working-set ∪ canon) | `tiers/ft-tools.ts`, `tiers/lookup-wiring.ts` | C | T2, T5, T6 |
| T9 correction turn | `session/turn-queue.ts`, `session/turn-worker.ts`, `prompts/session/ft-system.txt`, `tiers/fast-thinker.ts` | C | T7 |
| T10 Scribe job (queue + worker) | `session/scribe-queue.ts`, `session/scribe-worker.ts`, `session/scribe-config.ts` | D | T1–T4, T9 |
| T11 controller + data-flow rewiring | `session/session-controller.ts`, `session/turn-worker.ts`, `worker.ts` | D | T6, T7, T10 |
| T12 controller leak-matrix + real-LLM smoke + close | `session/__tests__/scribe-leak.test.ts`, `scripts/smoke/myt-73-scribe-smoke.ts` | E | all |

File-ownership overlaps to serialize: T6/T7/T8 all touch `ft-tools.ts`/`fast-thinker.ts` → **not parallel**; run T6→T7 (B, sequential on shared files) then T8 (C). T9 + T11 both touch `turn-worker.ts` → T9 before T11. T8 + T6 both touch `lookup-wiring.ts`/`ft-tools.ts` → T8 after T6.

---

## T1 — Working-set types + Zod schemas

**Files:** Create `backend/src/session/working-set/types.ts`; Create `backend/src/llm/schemas/world-delta.ts`; Test `backend/src/llm/schemas/__tests__/world-delta.test.ts`.

- [ ] **Write `working-set/types.ts`** (the item + the proposal — proposals are pre-embed, items are post-embed):
```ts
import type { AccessLevel } from '../../repo/world-retrieval.js'  // 'known' | 'discoverable' | 'secret' — verify the export path

export type WorkingSetProvenance =
  | { readonly kind: 'objective' }
  | { readonly kind: 'attributed'; readonly npcEntityId: string; readonly npcName: string }

/** A pre-embed proposal (what the FT delta / ST injection / retcon produce). */
export interface WorkingSetProposal {
  readonly kind: 'fact' | 'entity' | 'relationship'
  readonly content: string
  readonly subjectName: string
  readonly edge?: { readonly fromName: string; readonly toName: string; readonly relType: string }
  readonly parentName?: string
  readonly tier: AccessLevel
  readonly provenance: WorkingSetProvenance
  readonly source: 'ft_delta' | 'st_injection' | 'retcon'
  readonly supersedesId?: string | null
  readonly supersededContent?: string
}

/** A working-set item = a proposal + its id, turnId, and document embedding. */
export interface WorkingSetItem extends WorkingSetProposal {
  readonly id: string
  readonly turnId: string
  readonly embedding: readonly number[]   // 512-dim Voyage DOCUMENT vector; '[]' on embed-failure
}
```
- [ ] **Write `llm/schemas/world-delta.ts`** (the FT-emitted delta body — flat, NO `tier` field; the parser stamps `tier:'known'`):
```ts
import { z } from 'zod'
// The FT NEVER supplies a tier — public-by-construction. No tier field here;
// the parser stamps tier:'known', provenance:objective, source:'ft_delta'.
export const WorldDeltaItemSchema = z.object({
  subject: z.string().min(1),
  content: z.string().min(1),
  kind: z.enum(['fact', 'entity', 'relationship']),
})
export const WorldDeltaSchema = z.object({ facts: z.array(WorldDeltaItemSchema) })
export type WorldDelta = z.infer<typeof WorldDeltaSchema>
```
- [ ] **Test** `world-delta.test.ts`: accepts a valid `{facts:[…]}`; rejects an item missing `content`; rejects an unknown `kind`; **a stray `"tier":"secret"` in an item is IGNORED** (the schema has no tier field → `.parse` strips it; assert the parsed item has no `tier` key). Accepts `{facts:[]}`.
- [ ] **Run / PASS:** `pnpm vitest run src/llm/schemas/__tests__/world-delta.test.ts`; `pnpm --filter @mythrun/backend typecheck`.
- [ ] **Commit:** `feat(MYT-73): working-set types + world-delta schema (T1)`

---

## T2 — WorkingSetRepo (Redis)

**Files:** Create `backend/src/redis/working-set.ts`; Test `backend/src/redis/__tests__/working-set.test.ts`.

The working set is session-keyed (`{prefix}session:{campaignId}:workingset`) as a Redis **list** (atomic `RPUSH` append — never load-blob-mutate-SET, so a concurrent flush can't lose an item, spec §9). Each element is one `WorkingSetItem` JSON. `load` parses all elements. `evictIfOver` trims oldest **public** items only (LTRIM-style, but preserving ST injections + retcons — implement by reading, partitioning, and rewriting under the per-session lock the worker already holds; document the non-atomic-but-lock-guarded rewrite). **Embeddings are NOT part of the checkpoint** — see T11 (the checkpoint serializer strips them); `WorkingSetRepo` stores full items (with embeddings) in the live list.

- [ ] **Write failing tests** (ioredis-mock): `append` then `load` round-trips items (incl. embedding arrays); `append` is RPUSH (two concurrent appends both survive — simulate by interleaving); `evictIfOver(cap)` with cap=2 and 4 items (2 public oldest, 1 st_injection, 1 retcon) evicts only the oldest public, keeps both non-public + the newest public; `load` on an empty key → `[]`.
- [ ] **Implement** `WorkingSetRepo` (model the constructor on `makeSessionState` in `redis/session-state.ts` — `(redis, keyPrefix)`):
```ts
export interface WorkingSetRepo {
  load(campaignId: string): Promise<WorkingSetItem[]>
  append(campaignId: string, items: readonly WorkingSetItem[]): Promise<void>   // RPUSH each JSON
  evictIfOver(campaignId: string, cap: number): Promise<void>
  clear(campaignId: string): Promise<void>   // session-end (MYT-74 consumes first)
}
export function makeWorkingSetRepo(redis: Redis, keyPrefix: string): WorkingSetRepo { /* … */ }
```
`append`: `if (items.length) await redis.rpush(key, ...items.map((i) => JSON.stringify(i)))`. `load`: `(await redis.lrange(key, 0, -1)).map((s) => JSON.parse(s) as WorkingSetItem)`. Apply the existing `DIRECTION_TTL_S`-style TTL/`refreshTtls` pattern so the working set expires with the session.
- [ ] **Run / PASS:** `pnpm vitest run src/redis/__tests__/working-set.test.ts`; typecheck.
- [ ] **Commit:** `feat(MYT-73): WorkingSetRepo — atomic Redis-list working set (T2)`

---

## T3 — Secret tripwire (`llm/secret-tripwire.ts`)

**Files:** Create `backend/src/llm/schemas/secret-tripwire.ts`, `backend/src/llm/prompts/session/secret-tripwire.txt`, `backend/src/llm/secret-tripwire.ts`; Test `backend/src/llm/schemas/__tests__/secret-tripwire.test.ts`, `backend/src/llm/__tests__/secret-tripwire.test.ts`.

- [ ] **Schema** `secret-tripwire.ts` (flat; opaque control signal — NO `why`/secret-derived prose, spec §6):
```ts
import { z } from 'zod'
export const SecretTripwireResultSchema = z.object({
  breached: z.boolean(),
  confidence: z.number().min(0).max(1),   // Principle #3 — low confidence escalates to the retcon-author
  secretRef: z.string().nullable(),       // an OPAQUE playbook handle/id, NEVER prose. null when breached:false
})
export type SecretTripwireResult = z.infer<typeof SecretTripwireResultSchema>
```
- [ ] **Schema test:** accepts each shape; rejects confidence > 1; rejects a missing `breached`; accepts `secretRef: null`.
- [ ] **Prompt** `secret-tripwire.txt` (the model is told the playbook's core secrets carry **labels/handles**; it returns the breached secret's handle, never its content):
```
You are the secret tripwire for an AI Dungeon Master. The narrator (Fast Thinker) just wrote the player-facing prose below. You alone hold the session's CORE SECRETS — facts that are currently in play and breakable. Your ONLY job: decide whether the narrator's prose ASSERTED (stated, strongly implied, or revealed) something that contradicts or prematurely exposes a core secret.

HARD RULE: your output is a control signal, NOT content. You return only {breached, confidence, secretRef}. `secretRef` is the HANDLE of the breached secret (the bracketed [SECRET-n] label below), never the secret's text. Never quote, paraphrase, or describe the secret in any field.

Player-facing prose this turn:
{{prose}}

Core secrets (each prefixed with its handle; for GATING only, never to be echoed):
{{secrets}}

Return JSON: { "breached": <bool>, "confidence": <0..1>, "secretRef": "<[SECRET-n] handle or null>" }
Bias toward recall: if a break is plausible but uncertain, set breached=true with a LOW confidence (the Slow Thinker will double-check). A clean turn is breached=false, confidence high, secretRef null.
```
- [ ] **Write failing test** `secret-tripwire.test.ts` (mock `'ai'` `generateText`, model on `st-lookup-vet.test.ts`): happy clean path → `{breached:false,…}`, prompt threads `{{prose}}`/`{{secrets}}`; breach path → `{breached:true, secretRef:'[SECRET-1]'}`; **secret-suppression**: drive the terminal-failure path with raw text containing a secret → assert `.diagnostic.rawTextSnippet === null` AND no warn-log arg contains the secret (redactRawText). Each field round-trips.
- [ ] **Implement** `runSecretTripwire` (`generateObject`, `redactRawText:true`, `model: SCRIBE_TRIPWIRE_MODEL = HAIKU`, `callSite:'secret-tripwire'`, a `timeoutMs` from config). Input `{ prose: string; secrets: string; abortSignal? }`. The CALLER (T10) resolves+formats `secrets` from the sd_playbook (handles + text) and FAILS LOUD if empty — the wrapper itself is playbook-agnostic.
- [ ] **Run / PASS:** the two test files; typecheck.
- [ ] **Commit:** `feat(MYT-73): secret tripwire — Haiku breach detector, opaque control signal (T3)`

---

## T4 — Retcon-author (`llm/retcon-author.ts`)

**Files:** Create `backend/src/llm/schemas/retcon-author.ts`, `backend/src/llm/prompts/session/retcon-author.txt`, `backend/src/llm/retcon-author.ts`; Test `backend/src/llm/schemas/__tests__/retcon-author.test.ts`, `backend/src/llm/__tests__/retcon-author.test.ts`.

- [ ] **Schema** (flat; `retconText` `.min(1)` NO `.max()`; NO `.refine`):
```ts
import { z } from 'zod'
export const RetconResultSchema = z.object({
  retconText: z.string().min(1),       // the open, in-DM-voice correction (player-facing, secret-free)
  supersededContent: z.string().min(1),// what's being corrected (for the working-set supersede record)
  tier: z.enum(['known', 'discoverable', 'secret']),  // provenance for MYT-74; the supersede item itself is stamped 'known'
})
export type RetconResult = z.infer<typeof RetconResultSchema>
```
- [ ] **Schema test:** accepts; rejects empty `retconText`; accepts long `retconText`; rejects unknown `tier`.
- [ ] **Prompt** `retcon-author.txt` — carry the IDENTICAL paraphrase-and-implication hard-rule clause as `st-lookup-vet.txt`; prefer the minimal honest correction; only frame "earlier I said X" when X was player-visible:
```
You are the Slow Thinker, authoring a secret-preserving CORRECTION. The narrator wrote prose that breaks a core secret. You write the correction the narrator will deliver OPENLY to the players, in DM voice — terse, honest, not jokey.

HARD RULE — enforced ignorance: the correction must remove the contradiction WITHOUT revealing the secret, paraphrased or implied. The secret (and anything that would let a player deduce it) must NEVER appear in retconText. Revealing it is a product-breaking bug.

Prefer the MINIMAL honest correction — fold the fix into ongoing narration where you can, rather than a heavy "I was wrong" beat. Only use the explicit "earlier I said X — correction, it's actually Z" framing when X was actually spoken to the players in the prose below (not an internal note).

The breaching prose (player-visible):
{{prose}}

The breached assertion / what went wrong:
{{breach}}

The secret to preserve (your private knowledge; never surface it):
{{secret}}

Recent narration (so the correction flows from what was just said):
{{recentNarrative}}

Return JSON: { "retconText": "<the open correction, DM voice, secret-free>", "supersededContent": "<the false thing being corrected>", "tier": "known"|"discoverable"|"secret" }
```
- [ ] **Write failing test** (mock `'ai'`): happy path → `{retconText, supersededContent, tier}`, prompt threads `{{breach}}`/`{{secret}}`; `repairAttempted` path → surfaces `repairAttempted:true` (caller fail-softs); secret-suppression on terminal failure (redactRawText → `.diagnostic.rawTextSnippet === null`, no secret in warn logs).
- [ ] **Implement** `runRetconAuthor` (`generateObject`, `model: SCRIBE_RETCON_MODEL = OPUS`, `redactRawText:true`, `maxOutputTokens: SCRIBE_RETCON_MAX_OUTPUT_TOKENS = 1_200`, `timeoutMs`, `repairStrategy:'haiku-then-sonnet'`). Returns `{ result: RetconResult, usage, repairAttempted }`.
- [ ] **Run / PASS:** the two test files; typecheck.
- [ ] **Commit:** `feat(MYT-73): retcon-author — Opus secret-preserving correction (T4)`

---

## T5 — searchLore widening (return the query vector) + LoreHit.provenance

**Files:** Modify `backend/src/world/retrieval/search.ts`, `backend/src/world/retrieval/types.ts`; Test `backend/src/world/retrieval/__tests__/search.test.ts` (verify the existing test path; real-PG).

The read-merge (T8) needs the query embedding `searchLore` already computes (avoid a second Voyage call — Nineveh-C2/I4) and a provenance field on `LoreHit`.

- [ ] **`types.ts`:** add `readonly provenance?: WorkingSetProvenance` to `LoreHit` (optional — canon hits omit it; working-set hits set it). Import the type from `session/working-set/types.js`. Add `readonly source: 'fact'|'entity'|'working_set'` extension — verify the existing `source` union and widen it to include `'working_set'`.
- [ ] **`search.ts`:** change `SearchResolvers.searchLore` to return `{ hits: LoreHit[]; queryVec: readonly number[] }` (so the caller can cosine-rank the working set against the same vector). Update the body: capture `vec`, return `{ hits: merged.slice(0,limit), queryVec: vec }`. On the catch arm return `{ hits: [], queryVec: [] }`.
- [ ] **Update callers:** `ft-tools.ts`'s `search_lore` resolve closure (T6/T8 own the merge; here just adjust the call to destructure `{hits}`) and the MYT-71 smoke (`scripts/smoke/world-retrieval-voyage.ts`) — destructure `{hits}`. Run `pnpm --filter @mythrun/backend typecheck` to find every caller; fix each.
- [ ] **Write/extend failing test:** the existing search test asserts ordering on `LoreHit[]`; update to destructure `{hits}`; add: the returned `queryVec` has length 512 (the embed dim).
- [ ] **Run / PASS:** `pnpm vitest run src/world/retrieval/__tests__/search.test.ts` (real-PG); typecheck.
- [ ] **Commit:** `feat(MYT-73): searchLore returns the query vector + LoreHit.provenance (T5)`

---

## T6 — MYT-72 vet-surface widening + the injection sink (`ft-tools.ts`, `world-fact-lookup.ts`, `lookup-wiring.ts`)

**Files:** Modify `backend/src/session/world-fact-lookup.ts`, `backend/src/session/tiers/ft-tools.ts`, `backend/src/session/tiers/lookup-wiring.ts`; Tests: the existing `world-fact-lookup.test.ts`, `ft-tools.test.ts`, `lookup-wiring.test.ts`.

The wired MYT-72 orchestrator drops `tier`/`mode`; widen the surfaces so an injection can be recorded (spec §2.4 step 1).

- [ ] **`world-fact-lookup.ts`:** widen `WorldFactLookupVet` to return `{ mode: 'relay'|'none'|'invent'; text: string; tier: AccessLevel; repairAttempted: boolean }` (add `tier`). Widen `WorldFactLookupResult` to `{ relayText; skillGateFrame?; rollHidden; vetMode: 'relay'|'none'|'invent'|'fail_soft'; vetTier: AccessLevel | null }`. In `runWorldFactLookup`, set `vetMode`/`vetTier` from the vet result (fail-soft arms → `vetMode:'fail_soft', vetTier:null`).
- [ ] **`lookup-wiring.ts`:** the `vet` closure surfaces `tier` (`return { mode: r.result.mode, text: r.result.text, tier: r.result.tier, repairAttempted: r.repairAttempted }`). Add a `recordInjection` field to `FtToolDeps` (a `(p: WorkingSetProposal) => void` sink) — thread it through `buildLookupDeps` from `LookupWiringDeps`/`LookupWiringArgs`.
- [ ] **`ft-tools.ts`:** in each lookup tool's `execute`, after `runWorldFactLookup` returns, if `out.vetMode === 'invent' || out.vetMode === 'relay'` call `deps.recordInjection({ kind:'fact', content: out.relayText, subjectName: <topic/character/faction>, tier: out.vetTier ?? 'known', provenance: <channel: dm→objective; npc→{kind:'attributed', npcEntityId, npcName}>, source:'st_injection' })`. The `FtToolDeps` type gains `readonly recordInjection: (p: WorkingSetProposal) => void`.
- [ ] **Tests:** extend `world-fact-lookup.test.ts` — the vet stub returns a `tier`; assert `runWorldFactLookup` surfaces `vetMode`/`vetTier`. Extend `ft-tools.test.ts` — a fake `recordInjection` spy; assert a `relay`/`invent` lookup records an injection with the right provenance (dm→objective, npc→attributed) + tier; a `none`/fail-soft records nothing. Extend `lookup-wiring.test.ts` — `recordInjection` is threaded.
- [ ] **Verify:** `pnpm --filter @mythrun/backend typecheck` (the `FtToolDeps` widening ripples to the construction site in `turn-worker.ts` makeTiers — T11 wires the real sink; until then expect ONLY that one call-site error, like the MYT-72/T6 pattern; note it).
- [ ] **Commit:** `feat(MYT-73): widen vet surfaces to carry mode/tier + recordInjection sink (T6)`

---

## T7 — FT delta emission + the delimiter-guard (`fast-thinker.ts`, `types.ts`, `ft-system.txt`)

**Files:** Modify `backend/src/session/tiers/fast-thinker.ts`, `backend/src/session/tiers/types.ts`, `backend/src/llm/prompts/session/ft-system.txt`; Test `backend/src/session/tiers/__tests__/fast-thinker.test.ts`.

- [ ] **`types.ts`:** add `readonly worldDelta?: WorldDelta` to `AssistantMessage` (import `WorldDelta` from `llm/schemas/world-delta.js`).
- [ ] **`ft-system.txt`:** add a section instructing the FT to append, after its prose, on its own line: `[[WORLD_DELTA]]` then a JSON `{ "facts": [...] }` of any NEW named entities/facts it introduced this turn (public). State it's optional (omit if nothing new) and is stripped before players/the transcript see it. (This text is public-by-construction; no secrets involved.)
- [ ] **Write failing tests** (model on the existing fast-thinker stream tests): (1) a stream whose text contains `\n[[WORLD_DELTA]]\n{"facts":[{"subject":"The Salt Wife","content":"a tavern","kind":"entity"}]}` → the player emit stream contains only the pre-delimiter prose (assert no `[[` in any `emitText` arg), the returned `AssistantMessage.worldDelta` parses, and the assembled text part (→ transcript) contains no `[[WORLD_DELTA]]` and no JSON; (2) prose with a literal mid-sentence `=`/`[` that ISN'T the delimiter → streamed normally (false-alarm flush); (3) the delimiter split across two text-delta chunks → still caught; (4) no delimiter → whole stream emitted, `worldDelta` undefined; (5) malformed JSON after the delimiter → `worldDelta` undefined + a warn, pre-delimiter prose still emitted + assembled.
- [ ] **Implement** the delimiter-guard: a small stateful filter in the `text-delta` branch (spec §4.2 — guards BOTH `pushTextDelta` and `emitText`). Arm only at `\n` + `[`; hold buffer ≤ literal length; exact-literal match of `\n[[WORLD_DELTA]]`; divergence → flush to both sinks + KMP-re-anchor; completion → route the tail to a `deltaAccumulator` (neither sink); flush a pending partial on a tool/step boundary; at `finalize`, the assembled text part is pre-delimiter only and the accumulator is `JSON.parse`+`WorldDeltaSchema.safeParse`d onto `worldDelta` (unparseable → undefined + warn). Keep the guard state on the render-scope (spans deltas + steps).
- [ ] **Run / PASS:** `pnpm vitest run src/session/tiers/__tests__/fast-thinker.test.ts`; typecheck.
- [ ] **Commit:** `feat(MYT-73): FT fact-delta section + dual-sink delimiter-guard (T7)`

---

## T8 — The read-merge: working-set ∪ canon (`ft-tools.ts`, `lookup-wiring.ts`)

**Files:** Modify `backend/src/session/tiers/ft-tools.ts`, `backend/src/session/tiers/lookup-wiring.ts`; Tests: `ft-tools.test.ts`, `lookup-wiring.test.ts`.

The merge lives INSIDE the `search_lore` resolve closure, BEFORE `renderLoreHits` (spec §3 / Nineveh-C1).

- [ ] **`lookup-wiring.ts` / `FtToolDeps`:** add `readonly workingSet: () => Promise<WorkingSetItem[]>` (a thunk the controller wires from `WorkingSetRepo.load`) + `readonly cosine: (a: readonly number[], b: readonly number[]) => number` (or inline a small cosine helper). Build them in `buildLookupDeps`.
- [ ] **`ft-tools.ts` `search_lore` closure:** `const { hits, queryVec } = await deps.search.searchLore(deps.worldId, topic, {})`; `const ws = await deps.workingSet()`; cosine-rank `queryVec` against each `ws` item's `embedding` (skip empty-embedding items); map the top-K working-set hits to `LoreHit` (`source:'working_set'`, `accessLevel = item.tier`, `provenance = item.provenance`, `entityName = item.subjectName`, `content = item.content`, `score = cosineScore`); merge into `hits` preserving the canon limit + appending ≤ K working-set hits; re-render via `renderLoreHits` which now emits `[tier=…]` + `[claim by {npcName}]` when `provenance.kind==='attributed'`. The graph closures (`characters_known_to`/`faction_tree`) merge working-set `entity`/`relationship` items by name + `edge`/`parentName` (flat-append with `depth:null` when no structural anchor).
- [ ] **`renderLoreHits`:** add the `[claim by {npc}]` annotation when `hit.provenance?.kind === 'attributed'`.
- [ ] **Write failing tests** (`ft-tools.test.ts`, mock `runWorldFactLookup`/inject a fake `workingSet` + fake `searchLore` returning `{hits, queryVec}`): a working-set item semantically near the query is merged into the results passed to the orchestrator's `resolve` closure (extract the `results` string, assert it contains the working-set content); an `attributed` item renders `[claim by …]`; a `secret`-tier working-set item still appears in the over-pull (the ST-vet gates it — unchanged boundary); the canon limit is preserved.
- [ ] **Verify:** `pnpm --filter @mythrun/backend typecheck`; scoped coverage on `ft-tools.ts`.
- [ ] **Commit:** `feat(MYT-73): resolver reads working-set ∪ canon (semantic + structural merge) (T8)`

---

## T9 — The correction turn (`turn-queue.ts`, `turn-worker.ts`, `ft-system.txt`, `fast-thinker.ts`)

**Files:** Modify `backend/src/session/turn-queue.ts`, `backend/src/session/turn-worker.ts`, `backend/src/llm/prompts/session/ft-system.txt`, `backend/src/session/tiers/fast-thinker.ts`; Test `backend/src/session/__tests__/turn-worker.test.ts`, `fast-thinker.test.ts`.

A player-less turn that delivers an open retcon (spec §7.2 / D6).

- [ ] **`turn-queue.ts`:** add `'correction'` to `TurnJobPayload.trigger.kind`. Add an optional `readonly correctionText?: string` to the payload (the `Z` the FT delivers). A correction turn carries `triggerMessages: []` and a `maxConsumedSeq` equal to the CURRENT responded watermark (it must NOT advance past unresponded player seqs — the next real turn still picks them up).
- [ ] **`turn-worker.ts`:** in `processTurnJob`, branch on `payload.trigger.kind === 'correction'`: skip the no-monologue/empty-batch guard (a correction is intentionally player-less); set the one-shot direction to `[[DM CORRECTION: <correctionText>]]` (a distinct marker, not a normal `[DM direction:]`); render the FT turn; and on flush, **do NOT advance `last-responded-seq`** (the correction consumed no player message). Reuse the existing FT render + persist + flush path otherwise.
- [ ] **`ft-system.txt`:** add to the DM Direction Protocol: a `[[DM CORRECTION: ...]]` line is the RARE EXCEPTION to silent-consume — deliver it OPENLY in DM voice (e.g. "A moment — let me correct something: …"), terse and honest, then hand the floor back. (Distinct from the silent `[DM direction:]`.)
- [ ] **Write failing tests:** (`turn-worker.test.ts`, the converge-path builder style) a `correction`-kind payload renders a turn without hitting the empty-batch guard + does NOT advance the responded watermark; (`fast-thinker.test.ts`) a `[[DM CORRECTION: Z]]` standing line → the FT is prompted to deliver it openly (assert the prompt/marker reaches the model; the existing direction-fusion test pattern).
- [ ] **Verify:** typecheck; the two test files.
- [ ] **Commit:** `feat(MYT-73): player-less correction turn + open-correction FT affordance (T9)`

---

## T10 — The Scribe job: queue + worker (`scribe-queue.ts`, `scribe-worker.ts`, `scribe-config.ts`)

**Files:** Create `backend/src/session/scribe-queue.ts`, `backend/src/session/scribe-worker.ts`, `backend/src/session/scribe-config.ts`; Test `backend/src/session/__tests__/scribe-worker.test.ts`.

The post-turn reconciler job (spec §2.4 step 3). Model the queue/worker on `st-eval-queue.ts` + `st-evaluation-worker.ts`.

- [ ] **`scribe-config.ts`:** `SCRIBE_TRIPWIRE_MODEL=HAIKU`, `SCRIBE_RETCON_MODEL=OPUS`, `SCRIBE_TRIPWIRE_TIMEOUT_MS=30_000`, `SCRIBE_RETCON_TIMEOUT_MS=45_000`, `SCRIBE_RETCON_MAX_OUTPUT_TOKENS=1_200`, `WORKING_SET_CAP=200`, `RETCON_FORCE_AFTER_TURNS=3`.
- [ ] **`scribe-queue.ts`:** `QUEUE_SCRIBE='scribe'`, `ScribeJobPayload { campaignId, sessionId, turnId, prose: string, worldDelta: WorldDelta | null, injections: readonly WorkingSetProposal[] }`, `ScribeQueueLike { add }`, `enqueueScribe(queue, payload)`.
- [ ] **Define a narrow `ScribeRepo`** (its OWN `sessionPreps.getBy → {sdPlaybook}` + `sessions.getActiveByCampaign → {sessionNumber}` + `entities.findIdByWorldAndNormalizedName` — secret side; mirrors `StEvalRepo`/`LookupVetRepo`). NOT a widening of `TurnWorkerRepo.sessionPreps`.
- [ ] **`scribe-worker.ts` `processScribeJob`:**
  1. Build all `WorkingSetProposal`s: the `injections` + the `worldDelta.facts` mapped to proposals (`source:'ft_delta'`, `tier:'known'`, `provenance:objective`, parser-stamped).
  2. Embed each (`embedder.embedDocuments` — document input-type) → `WorkingSetItem`s; embed-failure → empty embedding + degraded log. `workingSetRepo.append(...)` then `evictIfOver(WORKING_SET_CAP)`.
  3. Resolve the sd_playbook via `ScribeRepo` (fail loud if empty). Format `{secrets}` (handles + text). `runSecretTripwire({prose, secrets})`.
  4. On `breached` (or low-confidence escalation): `runRetconAuthor({prose, breach, secret, recentNarrative})`; `repairAttempted` → fail-soft (log, return). Else: `enqueueScribe`-sibling → `enqueueTurn(sessionTurnQueue, { kind:'correction', correctionText: retconText, … })`; append a `retcon`-source supersede `WorkingSetItem` (`tier:'known'`, `supersedesId`/`supersededContent`). Guard against double-retcon (a live supersede for the same `secretRef` gates re-authoring; track via a per-session Redis key or scan the working set).
  5. TOTAL: never throw out of the job (BullMQ retry handles transient; a terminal failure logs).
- [ ] **Write failing tests** (mock `runSecretTripwire`/`runRetconAuthor` + a fake embedder + fake repos + fake queues): clean turn → proposals appended, tripwire run, no retcon/correction; breach → retcon authored + a correction turn enqueued (`kind:'correction'`, `correctionText`) + a `retcon` supersede appended; empty playbook → fails loud (throws/logs `*_misconfigured`); embed-failure → item appended with `[]` embedding + degraded log; `repairAttempted` retcon → no correction enqueued.
- [ ] **Run / PASS:** `pnpm vitest run src/session/__tests__/scribe-worker.test.ts`; typecheck.
- [ ] **Commit:** `feat(MYT-73): post-turn Scribe job — working-set append + tripwire + retcon (T10)`

---

## T11 — Controller + data-flow rewiring (`session-controller.ts`, `turn-worker.ts`, `worker.ts`)

**Files:** Modify `backend/src/session/session-controller.ts`, `backend/src/session/turn-worker.ts`, `backend/src/worker.ts`; Tests: `session-controller.test.ts` (+ the turn-worker/e2e fakes).

Wire the data-flow (spec §2.4) + retire the fire-and-forget `scribe.extract`.

- [ ] **`session-controller.ts`:** construct a per-turn injection sink (`const injections: WorkingSetProposal[] = []; const recordInjection = (p) => injections.push(p)`) and thread it into the tier deps (so `FtToolDeps.recordInjection` is real). After `render()`, replace the fire-and-forget `scribe.extract` with: `enqueueScribe(deps.scribeQueue, { campaignId, sessionId, turnId, prose: <the player-facing prose from this.assistant's text parts>, worldDelta: this.assistant.worldDelta ?? null, injections })`. Keep `FtTurnContext.workingSet: []` (pinned empty — spec §8). Remove the old `Scribe`/`ScribeResult`/`scribe.extract` seam (the stub + the interface) since the job replaces it.
- [ ] **`turn-worker.ts` `makeTiers` / `buildSessionTurnWorker`:** wire `recordInjection` (from the controller per-turn) + `workingSet: () => workingSetRepo.load(campaignId)` into `buildLookupDeps`; construct `makeWorkingSetRepo` + the `scribeQueue` in `buildSessionTurnWorker` (mirror the st-eval queue construction); pass the scribe queue into `TurnProcessorDeps`. This closes the T6 `buildFtTools` call-site type gap (the `recordInjection` + `workingSet` deps now supplied).
- [ ] **`worker.ts`:** construct + run the new **scribe worker** (`buildScribeWorker(redisBatch, redisRealtime, env.redisKeyPrefix, logger, pg, embedder)` — reuse the boot-probed embedder from MYT-72/T9) alongside the st-eval worker; register it in the shutdown path.
- [ ] **Write/extend failing tests:** `session-controller.test.ts` — after a turn, `enqueueScribe` is called with the prose + `worldDelta` + injections (a fake scribe queue spy); a lookup that records an injection shows up in the enqueued payload; `FtTurnContext.workingSet` is `[]`. `resolveWorldId`-style narrow-repo assertions for `ScribeRepo`.
- [ ] **Verify:** `pnpm --filter @mythrun/backend typecheck` (now FULLY green — the T6 gap closed); the controller + turn-worker test files.
- [ ] **Commit:** `feat(MYT-73): wire the turn data-flow + retire fire-and-forget scribe (T11)`

---

## T12 — Controller: leak-matrix + gated real-LLM smoke + close

**Controller-run** (like MYT-72's T10). Files: Create `backend/src/session/__tests__/scribe-leak.test.ts`; Create `backend/scripts/smoke/myt-73-scribe-smoke.ts` + the `pnpm smoke:scribe` script.

- [ ] **Leak matrix** (`scribe-leak.test.ts`, real PG + forced LLM, modeled on `world-lookup-leak.test.ts` break-it-to-prove-it) — spec §8 (a)–(e): (a) tripwire over secret-breaching prose → secret absent from `.diagnostic.rawTextSnippet`/`zodIssues` + every warn-log arg (terminal-failure path); (b) the retcon `Z` never reveals the secret — a **semantic** check (a forced retcon-author returning a leak fails; a clean one passes — assert via a curated paraphrase set or a judge stub); (c) the working set never holds a raw `sd_playbook` secret; (d) an `attributed` NPC-claim item surfaced beside objective hits with a different asker never elevates to objective in the relay; (e) a `secret`-tier working-set item never appears in `buildModelMessages` / `FtTurnContext.workingSet`.
- [ ] **Run:** `pnpm vitest run src/session/__tests__/scribe-leak.test.ts`.
- [ ] **Gated real-LLM smoke** (`myt-73-scribe-smoke.ts`, gated on ANTHROPIC + VOYAGE keys, seeds + tears down its own scratch world in mythrun_dev, modeled on `myt-72-world-lookup-smoke` / `world-retrieval-voyage`): seed a world + a `session_prep` `sd_playbook` core secret; (1) drive an FT turn whose prose breaks the secret → assert the real Haiku tripwire fires (`breached:true`), the real Opus retcon-author writes a secret-free `Z` (assert the secret tokens absent), a `correction`-kind turn is enqueued, and a `retcon` supersede lands in the working set; (2) append an FT-delta fact to the working set (embed via real Voyage) → drive a `search_lore` and assert the invented fact is semantically re-found (read-after-write); inspect at the WIRE level (working-set Redis contents, logs, the enqueued correction payload) — secret never leaks.
- [ ] **Controller sweep:** full `pnpm --filter @mythrun/backend lint` (eslint src — 0 errors) + scoped coverage on every new/modified file (sweep debt). Then full `pnpm --filter @mythrun/backend test:coverage` (100% gate).
- [ ] **Wiki:** dispatch the `docs/wiki/AUTHORING.md` subagent for MYT-73 (the Scribe page / Runtime section) — content sync, not just hash refresh.
- [ ] **Push (single):** commit T12, then `git push origin main` (the pre-push gate runs typecheck + lint + test:coverage + wiki:check; the scribe-worker is a new worker — confirm no dev-tool:verify trigger). Then flip Linear **MYT-73 → Done** + `bd close` the T12 bead.
- [ ] **Commit:** `test(MYT-73): enforced-ignorance leak matrix + real-LLM scribe smoke (T12)`

---

## Self-review

**Spec coverage:** §2 working set→T1/T2; §2.4 data-flow→T6/T11; §3 read-merge→T5/T8; §4 FT delta+guard→T1/T7; §5 ST injections→T6; §6 tripwire→T3/T10; §7 retcon+correction turn→T4/T9/T10; §8 enforced-ignorance→T11(pinned `[]`)+T12(leak matrix); §9 edges→T2(atomic/evict)/T10(fail-loud/embed)/T9(watermark); §10 contracts→all; §11 testing→each task + T12; §12 out-of-scope→respected (no durable canon writes anywhere). ✓

**Placeholder scan:** schemas/prompts/signatures given in full; "verify against the real interface / typecheck authoritative" notes only where extending existing surfaces (the MYT-72 idiom), not as a substitute for code. ✓

**Type consistency:** `WorkingSetProposal`/`WorkingSetItem` (T1) used identically in T2/T6/T8/T10/T11; `searchLore → {hits, queryVec}` (T5) consumed in T8; `WorldDelta` (T1) on `AssistantMessage` (T7) consumed in T11; `recordInjection: (p: WorkingSetProposal) => void` consistent T6/T11; `trigger.kind:'correction'` + `correctionText` (T9) consumed in T10. ✓
