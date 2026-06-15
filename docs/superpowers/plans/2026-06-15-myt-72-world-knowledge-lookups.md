# MYT-72 — World-knowledge lookups (unified ST-gated flow) — Implementation Plan

> For agentic workers: REQUIRED SUB-SKILL: superpowers:subagent-driven-development — dispatch each task wave per the dependency order below; all implementer subagents run on Opus; the controller stages + commits each task's files serially (implementers do NOT `git add`/`git commit`); the controller runs full lint + scoped coverage and sweeps the debt before the push.

**Goal.** Let the Fast Thinker (FT) pull world knowledge it lacks — from the Postgres world store shipped in MYT-71 — **without ever seeing secrets**. A player asks about world state the FT can't answer from its curated `ft_context`; a *contextual* skill check gates the lookup; a resolver over-pulls the store across **all** tiers (secrets included); a **new synchronous Opus ST-vet** is the single safety gate that decides what (if anything) to surface; the relay flows back into the in-flight turn as a `tool_result`. On a genuine gap, the ST-vet **invents** a tone/thread-consistent answer (play-is-canon). The FT never knows an ST was in the loop. **Done when:** a passed lookup returns ST-vetted info to the FT; a secret-touching query never leaks (across every egress — `tool_result`, logs/`pipeline_runs.error`/SSE, skill-gate frame, persisted+replayed transcript); a miss yields an ST invention.

**Architecture.** Three new FT tools (`search_lore`, `characters_known_to`, `faction_tree`) register into the existing `buildFtTools` registry (`ft-tools.ts`). Each tool's `execute` calls one shared orchestrator (`session/world-fact-lookup.ts`): **gate** (`session/world-lookup-gate.ts`, contextual Haiku DC-table over *public* standing + deterministic roll) → **resolve** (the MYT-71 `world/retrieval` surface, over-pulling all tiers) → **ST-vet** (`llm/st-lookup-vet.ts`, a new synchronous Opus `generateObject`+repair call that holds `sd_playbook` and is the single tier-safety gate) → **relay** (returned as the `tool_result`; no ST visible). The secret enters and dies inside an **opaque `vet` closure** captured on `FtToolDeps` — never the raw `sd_playbook` string on the FT seam. Frame emission for the skill-gate happens in the FT consume loop (`fast-thinker.ts`), with an NPC roll-hidden variant. No durable writes (D1 — canonization is MYT-73).

**Tech Stack.** Node 24 + TypeScript strict (`exactOptionalPropertyTypes`); Postgres (pgvector + recursive-CTE graph walks, MYT-71); Anthropic via the canonical `llm/ai.ts` wrapper (Opus for the ST-vet, Haiku for the gate); Voyage embeddings (`llm/embed.ts`, boot-probed); Zod for all LLM-output schemas; prompts as `.txt` template files; Vitest (real PG against `mythrun_test`, scoped fixtures; mocked LLM boundary at `'ai'`).

---

## Context primer (cross-cutting facts every implementer needs)

Read this section even if your task is one file — these invariants span the whole feature.

1. **The ST-gated flow.** Each lookup tool's `execute` runs `gate → resolve → ST-vet → relay` and returns **only the ST-vet's relay text** as the `tool_result`. The FT narrates from that relay; it never learns an ST ran (Runtime §17.4).

2. **Relay-only / no durable writes (D1).** MYT-72 writes **nothing** durable. The invented/relayed fact carries forward only via the FT's own transcript. No working-set read side, no Scribe — those are MYT-73. Do **not** call any write primitive.

3. **Enforced ignorance is structural, not behavioral.** The FT **model call** only ever receives the vetted relay. The secret `sd_playbook` is captured **inside an opaque `vet` closure** that `FtToolDeps` carries — the raw `sd_playbook` string is **never** a field on `FtToolDeps`, `ft-tools.ts`, or `fast-thinker.ts`. The secret enters the closure, is vetted, and dies there. The narrow `sdPlaybook` read lives on a **dedicated lookup-vet repo surface**, NOT a widening of `TurnWorkerRepo.sessionPreps.getBy` (which stays `{ftContext}`-only — the MYT-69 split). Precedent: `st-evaluation-worker.ts`'s `StEvalRepo` defines its own `sessionPreps.getBy → {sdPlaybook}` surface for exactly this reason.

4. **TOTAL / fail-soft contract.** Every tool `execute` is a **pure data resolver** that NEVER throws into the FT. Failure → a fail-soft relay (channel-appropriate "you can't quite recall" / "they don't seem to know"), **never** a raw error, **never** an unvetted/over-pulled result. The skill-gate, the resolver, and the ST-vet each have explicit fail-soft arms (§7 of the spec). The `{error}`-shaped tool-result is what the FT narrates around (`fast-thinker.ts:567` — an `error` key emits no frame).

5. **Tier annotation is mandatory on the ST-vet input.** `LoreHit.accessLevel` exists. `KnownCharacter`/`FactionNode` (the graph results) do **not** carry `access_level` today — T1 adds it. The ST-vet input carries **per-result `accessLevel`** for every substrate, so the gate isn't blind on the graph paths.

6. **Discard-on-repair + rawTextSnippet suppression (the ST-vet posture).** The ST-vet's relay `text` is surfaced **verbatim to the player**, so it is authoritative prose like `st-director`'s `direction`, NOT code-consumed like `st-gate`'s output. Copy **st-director's** posture, not st-gate's: `runStLookupVet` surfaces `repairAttempted`, and the caller treats `repairAttempted===true` as a **fail-soft** (a repaired tree's prose was re-authored by a different model — never surface it). Separately, the ST-vet is the one Mythrun LLM call whose **raw output reasons over secrets**: it MUST suppress the `ai.ts` `rawTextSnippet` capture (the `logRepair` pino line + the `attachDiagnostic` egress that world-gen surfaces into `pipeline_runs.error`/SSE), so a malformed-JSON ST-vet response can't spill a secret into logs/diagnostics. T4a adds a `redactRawText` opt to `ai.ts`.

7. **LLM-through-`ai.ts` + prompts-as-template-files.** All LLM calls go through `llm/ai.ts` (`generateObject` for the gate + vet). Never `import from 'ai'` in product code. Every prompt is a `.txt` file under `backend/src/llm/prompts/session/`, loaded via `loadPrompt('session', '<name>', vars)` with `{{var}}` interpolation.

8. **No `.max()` on free-prose LLM fields.** The ST-vet `text` and the gate's outcome strings are `.min(1)` floors only — never a `.max()` (rejecting valid generated prose terminal-fails the stage; repair fixes JSON, not over-length prose). `.max()` is allowed only on short labels / DB-CHECK mirrors (e.g. the gate's `dc: int 1..30`).

9. **Flat `z.object` root on every tool `inputSchema` and every gate/vet output schema.** The Anthropic tool API requires a root `"type":"object"`; Zod's `discriminatedUnion` emits a root `{oneOf}` with no top-level `type` → 400 (`ft-tools.ts:103–113`). Carry the `channel` discriminator as a flat `z.enum` field + optional per-channel fields, branch in `execute`. The gate output is flat `{auto_success, dc, outcomes}` (NOT a `{auto}|{dc,outcomes}` union); the ST-vet output is flat `{mode, text, tier}`.

10. **Tests in `__tests__/`, scoped fixtures, `mythrun_test`.** Co-located `__tests__/` dirs. Real-PG tests use `createTestPool(process.env.DATABASE_URL)` + `makeTestScope`/`cleanupTestScope` + `guardTestDatabase`. Backend tests target `mythrun_test` (`DATABASE_URL_TEST`), never `mythrun_dev`. LLM-boundary tests mock `'ai'`'s `generateText` (the wrapper drives `sdkGenerateText` with `Output.object` underneath — mock that, not `ai.ts`'s `generateObject`), per `st-director.test.ts`.

11. **`run … vitest` commands.** Scoped, fast: `pnpm vitest run <path>` for a single file; add `--coverage --coverage.include='<source>'` only when checking coverage on a new file during iteration (NEVER full `pnpm test:coverage` mid-iteration). Real-PG tests need `DATABASE_URL` sourced (the worktree's `.env.worktree` / repo `.env.development`).

---

## File map / task-wave table

| Task | Creates | Modifies | Test |
|---|---|---|---|
| **T1** graph tier-annotation | — | `repo/world-retrieval.ts`, `world/retrieval/graph.ts`, `world/retrieval/types.ts` | `repo/__tests__/world-retrieval.test.ts`, `world/retrieval/__tests__/graph.test.ts` |
| **T2** name→id resolver | — | `repo/entities.ts` | `repo/__tests__/entities.test.ts` |
| **T3** contextual skill-gate | `session/world-lookup-gate.ts`, `llm/schemas/world-lookup-gate.ts`, `llm/prompts/session/world-lookup-gate.txt`, `session/world-lookup-config.ts` | — | `session/__tests__/world-lookup-gate.test.ts`, `llm/schemas/__tests__/world-lookup-gate.test.ts` |
| **T4a** `ai.ts` redact opt | — | `llm/ai.ts` | `llm/__tests__/ai.test.ts` (extend) |
| **T4b** the ST-vet | `llm/st-lookup-vet.ts`, `llm/schemas/st-lookup-vet.ts`, `llm/prompts/session/st-lookup-vet.txt` | `session/world-lookup-config.ts` (add `ST_LOOKUP_VET_*`) | `llm/__tests__/st-lookup-vet.test.ts`, `llm/schemas/__tests__/st-lookup-vet.test.ts` |
| **T5** the orchestrator | `session/world-fact-lookup.ts` | — | `session/__tests__/world-fact-lookup.test.ts` |
| **T6** the three FT tools | — | `session/tiers/ft-tools.ts` | `session/tiers/__tests__/ft-tools.test.ts` |
| **T7** frame emission | — | `session/tiers/fast-thinker.ts`, `session/tiers/types.ts` | `session/tiers/__tests__/fast-thinker.test.ts` |
| **T8** transcript-codec mapping | — | `session/transcript-codec.ts` | `session/__tests__/transcript-codec.test.ts` |
| **T9** boot/turn wiring | — | `session/turn-worker.ts`, `worker.ts` | `session/__tests__/turn-worker.test.ts` |
| **T10** leak matrix + smoke (controller-run) | `session/__tests__/world-lookup-leak.test.ts`, `scripts/smoke/myt-72-world-lookup-smoke.ts` (or equivalent) | — | (is the test) |

**Dependency waves.**
- **Wave A (parallel):** T1, T2, T4a. (T1 and T2 touch disjoint repo methods; T4a is `ai.ts`-only. No file overlap.)
- **Wave B (parallel):** T3 (gate), T4b (vet — depends on T4a's redact opt + T1's tier types). T3 and T4b share `world-lookup-config.ts` — assign that file to **exactly one** (T3 creates it; T4b appends; serialize the config edit or have T3 land first, then T4b).
- **Wave C:** T5 (orchestrator — depends on T1, T2, T3, T4b).
- **Wave D (parallel):** T6 (tools — depends on T5), T8 (codec — independent of T5/T6 in file terms; can run in B/C).
- **Wave E:** T7 (frame emission — depends on T5/T6's result shape).
- **Wave F:** T9 (wiring — depends on T5/T6/T7).
- **Wave G (controller-run):** T10 (leak matrix + real-LLM smoke — depends on everything).

Config note: `session/world-lookup-config.ts` is touched by T3 and T4b. To avoid a write race, **T3 creates it** with the gate constants; **T4b appends** the vet constants. If run in parallel, the controller serializes the two edits to that file (per `feedback_parallel_agent_commits`).

---

## T1 — Graph tier-annotation (§5.1)

Join `access_level` onto the two recursive-CTE graph queries + the DB-row + camel result types + the graph.ts mappers. The ST-vet's graph input needs per-node tier; the binder dropped it today.

**Files:**
- Modify: `backend/src/repo/world-retrieval.ts` (the two graph SQL methods + `KnownCharacterDbRow`/`FactionNodeDbRow`)
- Modify: `backend/src/world/retrieval/types.ts` (`KnownCharacter`/`FactionNode` gain `accessLevel`)
- Modify: `backend/src/world/retrieval/graph.ts` (`toKnownCharacter`/`toFactionNode` mappers)
- Test: `backend/src/repo/__tests__/world-retrieval.test.ts` (real PG), `backend/src/world/retrieval/__tests__/graph.test.ts` (mapper)

**Steps:**

- [ ] **Write failing test** in `world-retrieval.test.ts`: extend the `charactersKnownTo` and `factionTree` describe blocks. Seed a public root entity and a `secret`-tier child entity (via the existing `seedEntity(worldId, type, name, axis, accessLevel)` helper which already takes the tier arg), wire a relationship / `entity_hierarchy` edge, and assert the returned rows now carry `access_level`. Concretely for `factionTree`:
  ```ts
  it('factionTree returns access_level per node (MYT-72 T1)', async () => {
    const root = await seedEntity(worldA, 'faction', 'Open Council', null, 'known')
    const childSecret = await seedEntity(worldA, 'faction', 'Hidden Cabal', null, 'secret')
    await pool.query(
      `INSERT INTO entity_hierarchy (id, parent_entity_id, child_entity_id)
       VALUES (uuid_generate_v7(), $1, $2)`,
      [root, childSecret],
    )
    const rows = await inScanTx(pool, (c) => worldRetrievalNs(c).factionTree(root, 5))
    const byName = new Map(rows.map((r) => [r.name, r]))
    expect(byName.get('Open Council')?.access_level).toBe('known')
    expect(byName.get('Hidden Cabal')?.access_level).toBe('secret')
  })
  ```
  And the mirror for `charactersKnownTo` (seed two `npc` entities, one `secret`, insert a `relationships` row, assert `access_level` on the reachable node). Check the existing `relationships` insert shape in this test file's setup before writing the edge SQL.
- [ ] **Run / FAIL:** `pnpm vitest run backend/src/repo/__tests__/world-retrieval.test.ts` — fails: `access_level` is `undefined` on the rows (column not selected; type lacks the field).
- [ ] **Implement** in `repo/world-retrieval.ts`. Add `access_level` to both DB-row types:
  ```ts
  export interface KnownCharacterDbRow {
    readonly entity_id: string
    readonly name: string
    readonly entity_type: GraphEntityType
    readonly access_level: AccessLevel
    readonly depth: number
  }
  export interface FactionNodeDbRow {
    readonly entity_id: string
    readonly name: string
    readonly entity_type: GraphEntityType
    readonly access_level: AccessLevel
    readonly parent_id: string | null
    readonly depth: number
  }
  ```
  Select `e.access_level` in both queries' final projection (the `JOIN entities e` is already present):
  - `charactersKnownTo`: `SELECT DISTINCT ON (m.entity_id) m.entity_id, e.name, e.entity_type, e.access_level, m.depth …`
  - `factionTree`: `SELECT t.entity_id, e.name, e.entity_type, e.access_level, t.parent_id, t.depth …`
  (`AccessLevel` is already imported at the top of this file.)
- [ ] **Implement** in `world/retrieval/types.ts`: add `readonly accessLevel: AccessLevel` to both `KnownCharacter` and `FactionNode` (the `AccessLevel` import is already present).
- [ ] **Implement** in `world/retrieval/graph.ts` mappers:
  ```ts
  function toKnownCharacter(row: KnownCharacterDbRow): KnownCharacter {
    return { entityId: row.entity_id, name: row.name, entityType: row.entity_type, accessLevel: row.access_level, depth: row.depth }
  }
  function toFactionNode(row: FactionNodeDbRow): FactionNode {
    return { entityId: row.entity_id, name: row.name, entityType: row.entity_type, accessLevel: row.access_level, parentId: row.parent_id, depth: row.depth }
  }
  ```
- [ ] **Add a mapper test** in `graph.test.ts`: a mocked `repo.worldRetrieval.factionTree`/`charactersKnownTo` returning a row with `access_level: 'secret'` → assert the camel result carries `accessLevel: 'secret'`. (The existing `graph.test.ts` mocks the binder; extend its fixtures with the new column.)
- [ ] **Run / PASS:** `pnpm vitest run backend/src/repo/__tests__/world-retrieval.test.ts backend/src/world/retrieval/__tests__/graph.test.ts`
- [ ] **Commit:** `feat(MYT-72): tier-annotate graph results — access_level on KnownCharacter/FactionNode`

---

## T2 — The name→id resolver (§10/§11)

`characters_known_to`/`faction_tree` take a *name* from the FT; resolve it to an `entityId` scoped to the world. **Decision (resolves §11 open question):** use **exact normalized-name match** (`lower(btrim(name))`), not fuzzy top-1 `findSimilarEntities`. Rationale: the graph walk is a structural read keyed by id — a *wrong* fuzzy id silently walks the wrong subtree (a confident-but-wrong relay, worse than a clean "no such character"). The FT reasons in canonical names it can read off `ft_context`; an exact miss is a clean `null` → clean "no such character" relay. (`findSimilarEntities` stays the match-vs-mint tool for MYT-73, where a fuzzy candidate is *reviewed*, not blindly walked.) A `secret` entity absent from the public name surface simply won't resolve (no id → no walk); graph channels reach secret *descendants of a resolvable public root* (T1 tier-annotates those), never secret *roots* — consistent with enforced ignorance.

**Files:**
- Modify: `backend/src/repo/entities.ts` (new `findIdByWorldAndNormalizedName` on `entitiesNs`)
- Test: `backend/src/repo/__tests__/entities.test.ts` (real PG)

**Steps:**

- [ ] **Write failing test** in `entities.test.ts` (model on the existing `findByWorldAndName` tests in this file — read them first for the scope/fixture shape):
  ```ts
  it('findIdByWorldAndNormalizedName matches case/whitespace-insensitively, world-scoped (MYT-72 T2)', async () => {
    const id = uuidv7()
    await entities.insert(pool, { id, worldId: worldA, entityType: 'npc', name: 'The Spymaster', accessLevel: 'known', createdIn: 'stage:test' })
    expect(await entitiesNs(pool).findIdByWorldAndNormalizedName(worldA, '  the spymaster ')).toBe(id)
    expect(await entitiesNs(pool).findIdByWorldAndNormalizedName(worldA, 'nobody')).toBeNull()
    expect(await entitiesNs(pool).findIdByWorldAndNormalizedName(worldB, 'The Spymaster')).toBeNull() // world-scoped
  })
  ```
- [ ] **Run / FAIL:** `pnpm vitest run backend/src/repo/__tests__/entities.test.ts` — `findIdByWorldAndNormalizedName is not a function`.
- [ ] **Implement** on `entitiesNs(c)` in `entities.ts`:
  ```ts
  /**
   * MYT-72: resolve a colloquial entity name to its id, world-scoped, matching
   * on lower(btrim(name)) so "  the spymaster " hits "The Spymaster". Returns
   * null on no match (a clean "no such character" relay — never throws). Used by
   * the lookup tools' name→id step before a graph walk.
   */
  findIdByWorldAndNormalizedName: async (worldId: string, name: string): Promise<string | null> => {
    const result = await c.query<{ id: string }>(
      `SELECT id FROM entities WHERE world_id = $1 AND lower(btrim(name)) = lower(btrim($2)) LIMIT 1`,
      [worldId, name],
    )
    return result.rows[0]?.id ?? null
  },
  ```
- [ ] **Run / PASS:** `pnpm vitest run backend/src/repo/__tests__/entities.test.ts`
- [ ] **Commit:** `feat(MYT-72): world-scoped normalized name→id entity resolver`

---

## T3 — The contextual skill-gate (`session/world-lookup-gate.ts`, §4)

A Haiku DC-table over the asker's **public** standing → flat `{auto_success, dc, outcomes}` + the reused deterministic roll-vs-DC core. Two channels: **DM** (knowledge-skill enum, PC roller) and **NPC** (`entityId`-seeded stat-or-fabricate). Auto-success bypasses the roll entirely.

**Files:**
- Create: `backend/src/llm/schemas/world-lookup-gate.ts`
- Create: `backend/src/llm/prompts/session/world-lookup-gate.txt`
- Create: `backend/src/session/world-lookup-config.ts`
- Create: `backend/src/session/world-lookup-gate.ts`
- Test: `backend/src/llm/schemas/__tests__/world-lookup-gate.test.ts`, `backend/src/session/__tests__/world-lookup-gate.test.ts`

**Steps:**

- [ ] **Write the schema** `llm/schemas/world-lookup-gate.ts` (flat, no root union; `dc` bounded; outcomes `.min(1)` no `.max()`):
  ```ts
  import { z } from 'zod'

  // Flat shape — auto_success + dc + outcomes all at the root (Anthropic's
  // structured output rejects a root discriminated union, cf. ft-tools.ts:103).
  // When auto_success is true, dc/outcomes are ignored by code (the gate bypasses
  // the d20 entirely — it is NOT a DC-1 roll). Outcome strings: .min(1) floors,
  // NO .max() (free prose — feedback_no_max_on_llm_prose_fields).
  export const WorldLookupGateResultSchema = z.object({
    auto_success: z.boolean(),
    dc: z.number().int().min(1).max(30),
    outcomes: z.object({
      fail: z.string().min(1),
      success: z.string().min(1),
      great_success: z.string().min(1),
    }),
  })
  export type WorldLookupGateResult = z.infer<typeof WorldLookupGateResultSchema>
  ```
- [ ] **Schema test** `llm/schemas/__tests__/world-lookup-gate.test.ts` (model on `skill-check.test.ts`): accepts a valid `{auto_success:false, dc:14, outcomes:{...}}`; rejects `dc:0` / `dc:31`; rejects empty outcome string; accepts a long outcome (no max).
- [ ] **Write the config** `session/world-lookup-config.ts`:
  ```ts
  import { HAIKU } from '../llm/models.js'

  /** The lookup-gate DC-table is a Haiku judgment call (which the asker would
   *  plausibly know), like the skill-check DC table. */
  export const WORLD_LOOKUP_GATE_MODEL = HAIKU
  export const WORLD_LOOKUP_GATE_TIMEOUT_MS = 30_000

  /** Knowledge skills the DM channel constrains to (a free FT pick can't become
   *  an Unknown-skill hard blank — skill-check.ts:80). The five INT-knowledge
   *  skills plus three domain skills the spec names (§4.2). */
  export const KNOWLEDGE_SKILLS = [
    'history', 'arcana', 'religion', 'nature', 'investigation',
    'medicine', 'survival', 'insight',
  ] as const
  export type KnowledgeSkill = (typeof KNOWLEDGE_SKILLS)[number]

  /** NPC fabricated-check tuning. A statless NPC gets a stable ability modifier
   *  seeded off its entityId (no durable write — D1). The band keeps a fabricated
   *  modifier in a plausible -1..+4 range. */
  export const NPC_FAB_MOD_MIN = -1
  export const NPC_FAB_MOD_MAX = 4

  /** Fail-soft DC table when the Haiku gate fails/aborts — mirrors ft-config's
   *  FALLBACK_DC/FALLBACK_OUTCOMES (moderate band; the deterministic roll still
   *  runs so a gate outage doesn't auto-pass or auto-blank). NOT auto_success. */
  export const GATE_FALLBACK_DC = 13
  export const GATE_FALLBACK_OUTCOMES = {
    fail: "You can't quite bring it to mind.",
    success: 'You recall what you know of it.',
    great_success: 'You recall it in vivid detail.',
  } as const
  ```
- [ ] **Write the prompt** `llm/prompts/session/world-lookup-gate.txt`. Structure (verbatim-grade — the model must emit the flat schema and judge *plausibility relative to the asker's public standing*, NOT topic difficulty in the abstract):
  ```
  You are setting whether and how hard it is for someone to recall a piece of world knowledge they were asked about. This is a CONTEXTUAL check: the difficulty is set by how plausibly THIS asker — given their public role, standing, background, and competence — would know THIS topic. It is NOT the topic's difficulty in the abstract.

  Asker: {{asker_summary}}
  Channel: {{channel}}   (dm = a player character is recalling; npc = a non-player character is recalling)
  World tone: {{world_tone}}
  Topic asked about: {{topic}}

  Decide:

  1. AUTO-SUCCESS (no roll). Set "auto_success": true when this asker would OBVIOUSLY know the answer — knowledge is a foregone conclusion from their PUBLIC standing. Examples: the publicly-known head of an organization asked about that organization's structure; an NPC asked about their own household or trade. When auto_success is true, dc and outcomes are ignored — set dc to 1 and write brief placeholder outcomes.

  2. OTHERWISE set a DC (1–30) scaled by plausibility:
     - A topic squarely within the asker's public role/expertise → low DC (5–10).
     - A topic at the edge of what they'd plausibly know → moderate DC (11–17).
     - A topic they plausibly COULD NOT know (a four-year-old on city governance; a foreign visitor on a closely-held local matter) → very high DC (18–28): they may roll, but will likely fail.
     Write three outcome descriptions — fail, success, great_success — as one-sentence GENERAL narrative constraints (not specific prose), giving the DM creative freedom in how the recall (or failure to recall) is narrated.

  You see only PUBLIC standing. Do NOT assume any hidden role or secret knowledge — a secret-backed foregone conclusion is handled downstream, not here.

  Respond as JSON:
  {
    "auto_success": <true|false>,
    "dc": <number 1-30>,
    "outcomes": {
      "fail": "<what a failed recall looks like>",
      "success": "<what a successful recall looks like>",
      "great_success": "<what an exceptional recall looks like>"
    }
  }
  ```
- [ ] **Write failing test** `session/__tests__/world-lookup-gate.test.ts`. Mock `'ai'`'s `generateText` (per `st-director.test.ts`). Cases:
  - DM channel, gate returns `auto_success:true` → result `{ outcome: 'auto_success' }`, no roll fields, no `dc` rolled.
  - DM channel, `auto_success:false, dc:14`, injected `rng` so the d20 + modifier clears → `{ outcome: 'pass', payload }` carrying a `SkillCheckFramePayload`-shaped sub-payload (characterName, skill, roll, dc, total, outcomeTier, constraint).
  - DM channel, `dc:25`, injected `rng` so it fails → `{ outcome: 'fail', payload }` (the fail-tier constraint).
  - NPC channel with a `dc`, fabricated modifier: assert the SAME `entityId` produces the SAME fabricated modifier across two calls (seed-stability), and a hidden-roll payload variant (no metagame tell — see T7 for the frame; the gate just returns the roll-hidden flag).
  - Gate LLM throws → fail-soft to `GATE_FALLBACK_DC`/`GATE_FALLBACK_OUTCOMES` (NOT auto-success), roll still runs.
  - DM channel skill arg is constrained to `KnowledgeSkill` at the type level (the tool passes a validated enum; the gate maps it to the canonical 5e skill for the modifier calc).
- [ ] **Run / FAIL.**
- [ ] **Implement** `session/world-lookup-gate.ts`. The exported surface:
  ```ts
  import { generateObject } from '../llm/ai.js'
  import { loadPrompt } from '../llm/prompts.js'
  import { WorldLookupGateResultSchema, type WorldLookupGateResult } from '../llm/schemas/world-lookup-gate.js'
  import {
    WORLD_LOOKUP_GATE_MODEL, WORLD_LOOKUP_GATE_TIMEOUT_MS,
    GATE_FALLBACK_DC, GATE_FALLBACK_OUTCOMES, NPC_FAB_MOD_MIN, NPC_FAB_MOD_MAX,
    type KnowledgeSkill,
  } from './world-lookup-config.js'
  import { calculateModifier, resolveRollType, rollD20WithType, type Rng } from './dice/engine.js'
  import { createHash } from 'node:crypto'
  import type { SkillCheckFramePayload } from './tiers/types.js'
  import type { Character } from '../repo/types.js'

  /** The asker context the gate needs — built by the orchestrator from public
   *  data only (ft_context / character sheet for DM; entity public identity for
   *  NPC). NEVER the secret playbook. */
  export interface WorldLookupGateInput {
    readonly channel: 'dm' | 'npc'
    readonly topic: string
    readonly worldTone: string
    /** Public, free-text summary of the asker's standing for the Haiku judgment. */
    readonly askerSummary: string
    /** DM channel: the PC roller + the validated knowledge skill. */
    readonly dm?: { readonly character: Character; readonly skill: KnowledgeSkill; readonly skills: readonly { skill_name: string; proficiency_level: string }[] }
    /** NPC channel: the entityId the fabricated modifier is seeded off + the NPC display name for the frame. */
    readonly npc?: { readonly entityId: string; readonly npcName: string }
  }

  export type WorldLookupGateResolution =
    | { readonly outcome: 'auto_success' }
    | { readonly outcome: 'pass'; readonly frame: SkillCheckFramePayload; readonly rollHidden: boolean }
    | { readonly outcome: 'fail'; readonly frame: SkillCheckFramePayload; readonly rollHidden: boolean; readonly failConstraint: string }

  export interface WorldLookupGateDeps {
    readonly worldTone: string
    readonly rng?: Rng
    readonly abortSignal?: AbortSignal
    readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
  }
  ```
  Body:
  1. `fetchGateTable(deps, input)` → calls `generateObject({ model: WORLD_LOOKUP_GATE_MODEL, schema: WorldLookupGateResultSchema, schemaName, prompt: loadPrompt('session','world-lookup-gate',{ asker_summary, channel, world_tone, topic }), callSite: 'world-lookup-gate', repairStrategy: 'haiku-then-sonnet', timeoutMs: WORLD_LOOKUP_GATE_TIMEOUT_MS, ...(abortSignal ? {abortSignal} : {}) })`, returning `result.output`; on any throw, `logger?.warn` + return `{ auto_success: false, dc: GATE_FALLBACK_DC, outcomes: {...GATE_FALLBACK_OUTCOMES} }`.
  2. If `table.auto_success` → return `{ outcome: 'auto_success' }` (no roll, no frame; rollHidden moot).
  3. Else compute the modifier:
     - **DM:** reuse the skill-check modifier math (`skill-check.ts:104–111`): find the skill row, `level → profBonus` (`expertise`=2×PB, `proficient`=PB, else 0), `modifier = calculateModifier(character[ability]) + profBonus`. Map the `KnowledgeSkill` enum value to the canonical-cased skill + ability via a small local map (`history→{canonical:'History', ability:'int'}`, etc.) — do NOT re-call Haiku for it. `rollHidden = false`.
     - **NPC:** `modifier = fabricatedModifier(npc.entityId)` — a **deterministic** function: `const h = createHash('sha256').update(entityId).digest(); const span = NPC_FAB_MOD_MAX - NPC_FAB_MOD_MIN + 1; return NPC_FAB_MOD_MIN + (h.readUInt32BE(0) % span)`. `rollHidden = true`.
  4. Roll: `rollType = resolveRollType(false,false)` (lookups have no adv/disadv); `d20 = rollD20WithType(rollType, deps.rng)`; `total = d20.keptRoll + modifier`; `outcomeTier = total >= dc+5 ? 'great_success' : total >= dc ? 'success' : 'fail'`.
  5. Build the `SkillCheckFramePayload` (characterName = PC name for DM / `npcName` for NPC; `skill` = the canonical skill for DM / `'(knowledge)'`-style label for NPC; `context` = the topic; roll/roll2/rollType/modifier/total/dc/outcomeTier/constraint = `table.outcomes[outcomeTier]`).
  6. Return `outcome: 'pass'` when `outcomeTier !== 'fail'`, else `outcome: 'fail'` carrying `failConstraint = table.outcomes.fail`.
  - **Determinism note:** the NPC fabricated modifier uses sha256(entityId) — no DB write (D1), stable across lookups in a session.
- [ ] **Run / PASS:** `pnpm vitest run backend/src/session/__tests__/world-lookup-gate.test.ts backend/src/llm/schemas/__tests__/world-lookup-gate.test.ts`
- [ ] **Commit:** `feat(MYT-72): contextual world-lookup skill-gate (public-standing DC + roll)`

---

## T4a — `ai.ts` rawTextSnippet suppression opt (§5)

The ST-vet is the one Mythrun LLM call whose raw output reasons over secrets. `ai.ts`'s `logRepair` (pino) + `attachDiagnostic` (rethrown error → world-gen → `pipeline_runs.error`/SSE) both capture `rawTextSnippet` (first 2048 chars). Add an opt that redacts it so a malformed-JSON ST-vet response can't spill a secret.

**Files:**
- Modify: `backend/src/llm/ai.ts`
- Test: `backend/src/llm/__tests__/ai.test.ts` (extend)

**Steps:**

- [ ] **Write failing test** in `ai.test.ts` (model on the existing repair-path scaffold there). Drive a `generateObject({ ..., redactRawText: true })` where the SDK's `generateText` rejects with a `LlmStructuredOutputError` whose `cause.text` contains the string `"SECRET-PLOT"` and which fails repair (terminal). Assert:
  - The rethrown error's `.diagnostic.rawTextSnippet` is `null` (not the secret).
  - The captured pino WARN line's `rawTextSnippet` is `undefined`/absent (spy on `logger.warn`; assert no arg JSON contains `"SECRET-PLOT"`).
  - Without `redactRawText`, the snippet IS captured (the existing behavior — keep a control case).
- [ ] **Run / FAIL.**
- [ ] **Implement.** Add `readonly redactRawText?: boolean` to `GenerateObjectOpts<T>`. Thread it into the `RepairContext<T>` (add `readonly redactRawText: boolean`). In `attemptRepair`, `logRepair`, and `buildDiagnostic`, when `ctx.redactRawText` is true, emit `rawTextSnippet: null`/`undefined` instead of `snippet(rawText)`. Smallest surface: in `generateObject`'s `ctx` construction set `redactRawText: opts.redactRawText ?? false`; in the three capture sites gate the snippet on it. Keep `zodIssues` too — Zod issues are *paths + messages* on the schema, not raw model output, so they're safe to keep (they don't carry secret prose). (Confirm by inspection: `safe.error.issues[].message` is Zod's own validation text, not the model's content.) If any issue message could echo a model value, redact `zodIssues` under the flag too — pick the conservative read: **redact both** `rawTextSnippet` and `zodIssues` under the flag, since Zod's `invalid_type`/`too_small` messages can be safe but `custom`-refine messages could echo input. The ST-vet schema has no `.refine`, so `zodIssues` is structurally safe, but redacting both is the airtight choice.
- [ ] **Run / PASS:** `pnpm vitest run backend/src/llm/__tests__/ai.test.ts`
- [ ] **Commit:** `feat(MYT-72): redactRawText opt on generateObject — suppress snippet for secret-bearing calls`

---

## T4b — The ST-vet-and-relay call (`llm/st-lookup-vet.ts`, §5)

A new synchronous Opus `generateObject`+repair wrapper. The single tier-safety gate. Holds `sd_playbook`, sees tier-annotated results + recent narrative + channel + `resolver_degraded` + tone, and emits `{mode, text, tier}`. Discards on `repairAttempted` (caller fail-softs). Suppresses `rawTextSnippet` via T4a.

**Files:**
- Create: `backend/src/llm/schemas/st-lookup-vet.ts`
- Create: `backend/src/llm/prompts/session/st-lookup-vet.txt`
- Create: `backend/src/llm/st-lookup-vet.ts`
- Modify: `backend/src/session/world-lookup-config.ts` (append `ST_LOOKUP_VET_MODEL`, `ST_LOOKUP_VET_TIMEOUT_MS`, `ST_LOOKUP_VET_MAX_OUTPUT_TOKENS`)
- Test: `backend/src/llm/schemas/__tests__/st-lookup-vet.test.ts`, `backend/src/llm/__tests__/st-lookup-vet.test.ts`

**Steps:**

- [ ] **Write the schema** `llm/schemas/st-lookup-vet.ts` (flat; `text` `.min(1)` NO `.max()`; `tier` is the existing `AccessLevel`; **NO `.refine`** — like `st-director.ts`, the repair chain must not be able to author a "valid" tree, and the mode/text coupling is code-checked):
  ```ts
  import { z } from 'zod'

  // Flat object (no root union). mode is the trichotomy; text is the player-
  // facing relay/invention prose (verbatim to the player — authoritative like
  // st-director's `direction`, so .min(1) floor, NO .max()); tier is the ST's
  // provenance tag for the relayed/invented content (emitted now, consumed by
  // MYT-73's Scribe). NO .refine — a refine lets the repair chain author a
  // "valid" tree, which defeats the single-gate guarantee.
  export const StLookupVetResultSchema = z.object({
    mode: z.enum(['relay', 'none', 'invent']),
    text: z.string().min(1),
    tier: z.enum(['known', 'discoverable', 'secret']),
  })
  export type StLookupVetResult = z.infer<typeof StLookupVetResultSchema>
  ```
- [ ] **Schema test** `llm/schemas/__tests__/st-lookup-vet.test.ts`: accepts each `mode`; rejects empty `text`; accepts long `text`; rejects an unknown `tier`/`mode`.
- [ ] **Append config** to `session/world-lookup-config.ts`:
  ```ts
  import { OPUS } from '../llm/models.js'

  /** The ST-vet is a full-sd_playbook Opus call, mid-turn, per lookup (§17.4). */
  export const ST_LOOKUP_VET_MODEL = OPUS
  /** Pinned WELL UNDER the FT turn budget (FT_TURN_TIMEOUT_MS = 180_000) so the
   *  vet's own timeout → fail-soft fires BEFORE the FT-turn abort would
   *  terminal-fail the turn. Budget arithmetic (§7): a Sonnet FT step + Haiku
   *  gate + resolver + this Opus vet + a Sonnet narration must fit in 180s; 45s
   *  leaves the gate (~30s) + resolver + two Sonnet passes room. NOT the 120s
   *  async ST_EVAL_TIMEOUT_MS. */
  export const ST_LOOKUP_VET_TIMEOUT_MS = 45_000
  /** A relay/invention is 1–3 sentences; an Opus default won't truncate, but pin
   *  it modestly so a runaway can't eat the turn budget. */
  export const ST_LOOKUP_VET_MAX_OUTPUT_TOKENS = 1_200
  ```
- [ ] **Write the prompt** `llm/prompts/session/st-lookup-vet.txt`. The 3-mode trichotomy + never-surface-secret + NPC bounded-knowledge + secret-aware standing. Structure (verbatim-grade):
  ```
  You are the Slow Thinker, the narrative director and the single safety gate for a world-knowledge lookup. A player asked about world state; a resolver over-pulled the world store across ALL access tiers (secrets included). You — and only you — decide what is safe to surface, then write the answer the player will read. The player NEVER learns you were involved; your "text" is returned to the narrator as if it were the result of their own recollection.

  HARD RULE — enforced ignorance: you see secret-tier content so you can GATE it, never so you can reveal it. Content tagged "secret" (and any secret you know from the playbook below) must NEVER appear, paraphrased or implied, in your "text". Surfacing a secret is a product-breaking bug.

  World tone: {{world_tone}}
  Channel: {{channel}}   (dm = objective world truth, as the asking player character would recall it; npc = what THIS non-player character would convey, bounded by what they plausibly know — partial, biased, or wrong is fine and good)
  {{npc_framing}}        (present only for the npc channel: the NPC's public identity + their playbook-bounded knowledge)

  The player's question, as the narrator framed it:
  {{question}}

  Recent narration (so an invented answer stays consistent with what was just said this session — not only with tone):
  {{recent_narrative}}

  Over-pulled results, each tagged with its access tier:
  {{results}}

  Resolver health: {{resolver_degraded}}   (if "degraded", the empty/thin result may be an infrastructure blip masquerading as emptiness — do NOT confidently invent over it; prefer "none" or a hedged recollection)

  Secret playbook (your private knowledge — for GATING and for secret-aware standing only; never to be surfaced):
  {{sd_playbook}}

  Secret-aware standing: the pre-roll gate saw only PUBLIC standing, so it could not know that a foregone-conclusion or an implausibility hinges on a SECRET role. Using the playbook, you MAY treat the asker as obviously knowing (or obviously not knowing) when a hidden role makes it so — but still never reveal WHY.

  Choose exactly one mode and write "text":
  - "relay": the results contain a tier-SAFE answer (or your playbook supplies a safe one). Surface it as in-world recollection. tier = the access tier of what you surfaced.
  - "none": the gap is genuinely empty (after gating) — there is nothing to tell. Write a truthful "you find nothing / they don't know" beat. tier = "known".
  - "invent": there is a real gap and the resolver is healthy — fabricate a tone- and thread-consistent answer that becomes canon for this session (play-is-canon). Keep it consistent with the recent narration. tier = the tier you intend this invented fact to hold (usually "known"; "discoverable"/"secret" if it should stay quiet).

  Respond as JSON:
  { "mode": "relay" | "none" | "invent", "text": "<the player-facing answer>", "tier": "known" | "discoverable" | "secret" }
  ```
- [ ] **Write failing test** `llm/__tests__/st-lookup-vet.test.ts` (model on `st-director.test.ts` — mock `'ai'`'s `generateText`). Cases:
  - Happy path: `generateText` resolves `{ output: {mode:'relay', text:'…', tier:'known'}, usage }` → `runStLookupVet` returns `{ mode, text, tier, repairAttempted: false }`; assert the prompt vars are threaded (spy on the call's `prompt` containing the question/results substrings).
  - `repairAttempted` path: first `generateText` rejects with a structured error whose `cause.text` parses but fails Zod → repair model fires (per the `ai.test.ts` repair scaffold) → `runStLookupVet` surfaces `repairAttempted: true` (caller fail-softs).
  - Secret-suppression: drive the terminal-failure path with `cause.text` containing `"SECRET"` → assert the thrown error's `.diagnostic.rawTextSnippet` is `null` (T4a's `redactRawText` is set) and the pino WARN spy carries no `"SECRET"` substring.
  - Each `mode` value round-trips.
- [ ] **Run / FAIL.**
- [ ] **Implement** `llm/st-lookup-vet.ts` (copy `st-director.ts`'s shape; add `redactRawText`):
  ```ts
  import { generateObject, type LanguageModelUsage } from './ai.js'
  import { loadPrompt } from './prompts.js'
  import { StLookupVetResultSchema, type StLookupVetResult } from './schemas/st-lookup-vet.js'
  import {
    ST_LOOKUP_VET_MODEL, ST_LOOKUP_VET_TIMEOUT_MS, ST_LOOKUP_VET_MAX_OUTPUT_TOKENS,
  } from '../session/world-lookup-config.js'

  export interface StLookupVetInput {
    readonly question: string
    readonly recentNarrative: string
    readonly channel: 'dm' | 'npc'
    /** Present only for the NPC channel: the NPC's public identity + playbook-
     *  bounded knowledge framing. Empty string for DM. */
    readonly npcFraming: string
    /** Pre-rendered, tier-annotated results block (the orchestrator formats the
     *  LoreHit/KnownCharacter/FactionNode shapes into text, each line tagged with
     *  its accessLevel). */
    readonly results: string
    readonly resolverDegraded: boolean
    readonly sdPlaybook: string
    readonly worldTone: string
    readonly abortSignal?: AbortSignal
  }

  export interface StLookupVetOutput {
    readonly result: StLookupVetResult
    readonly usage: LanguageModelUsage
    readonly repairAttempted: boolean
  }

  export async function runStLookupVet(input: StLookupVetInput): Promise<StLookupVetOutput> {
    const r = await generateObject({
      model: ST_LOOKUP_VET_MODEL,
      schema: StLookupVetResultSchema,
      schemaName: 'StLookupVetResultSchema',
      prompt: loadPrompt('session', 'st-lookup-vet', {
        question: input.question,
        recent_narrative: input.recentNarrative,
        channel: input.channel,
        npc_framing: input.npcFraming,
        results: input.results,
        resolver_degraded: input.resolverDegraded ? 'degraded' : 'healthy',
        sd_playbook: input.sdPlaybook,
        world_tone: input.worldTone,
      }),
      callSite: 'st-lookup-vet',
      repairStrategy: 'haiku-then-sonnet',
      timeoutMs: ST_LOOKUP_VET_TIMEOUT_MS,
      maxOutputTokens: ST_LOOKUP_VET_MAX_OUTPUT_TOKENS,
      // §5: this is the one call whose RAW OUTPUT reasons over secrets — suppress
      // the rawTextSnippet/zodIssues egress so a malformed JSON response can't
      // spill a secret into logs / pipeline_runs.error / SSE.
      redactRawText: true,
      ...(input.abortSignal !== undefined ? { abortSignal: input.abortSignal } : {}),
    })
    return { result: r.output, usage: r.usage, repairAttempted: r.repairAttempted }
  }
  ```
- [ ] **Run / PASS:** `pnpm vitest run backend/src/llm/__tests__/st-lookup-vet.test.ts backend/src/llm/schemas/__tests__/st-lookup-vet.test.ts`
- [ ] **Commit:** `feat(MYT-72): ST-vet-and-relay Opus call (single tier-safety gate, snippet-suppressed)`

---

## T5 — The orchestrator (`session/world-fact-lookup.ts`, §10)

The shared `gate → resolve → ST-vet → relay` spine the three tools call with their per-substrate resolver closure. Returns `{ relayText, skillGateFrame }`. Owns every fail-soft arm.

**Files:**
- Create: `backend/src/session/world-fact-lookup.ts`
- Test: `backend/src/session/__tests__/world-fact-lookup.test.ts`

**Steps:**

- [ ] **Write failing test** `session/__tests__/world-fact-lookup.test.ts`. Inject a fake gate (returns `auto_success`/`pass`/`fail`), a fake resolver closure (returns results / throws / returns `[]`), and a fake vet (`runStLookupVet`-shaped). Cases:
  - **gate fail** → returns `{ relayText: <gate fail constraint>, skillGateFrame: <the fail frame> }`; the resolver + vet are NOT called (cost skipped, §7).
  - **gate auto_success** → resolver + vet run; `skillGateFrame` is **absent** (no frame on auto-success per §4.1); `relayText` = the vet relay.
  - **gate pass** → resolver + vet run; `skillGateFrame` present; `relayText` = the vet relay.
  - **resolver throws** (graph DB error) → caught here → `resolverDegraded: true` passed to the vet; vet leans `none`/fail-soft; never an unvetted leak. Assert the vet's `resolverDegraded` arg is true.
  - **resolver returns `[]`** (searchLore total-swallowed) → `resolverDegraded` is the closure's reported flag (searchLore can't distinguish degraded-empty from genuine-empty by itself; the closure surfaces a degraded boolean — see the closure contract below).
  - **vet error / timeout / repairAttempted** → fail-soft relay (a channel-appropriate "you can't quite recall" / "they don't seem to know"); never raw error, never unvetted result, never repair-authored text.
  - **vet `mode:'invent'`** → `relayText` = the invention; **`mode:'none'`** → the truthful "nothing found" relay text (both surface the vet's `text`, but the orchestrator does not re-author).
- [ ] **Run / FAIL.**
- [ ] **Implement** `session/world-fact-lookup.ts`:
  ```ts
  import { resolveWorldLookupGate, type WorldLookupGateInput, type WorldLookupGateDeps } from './world-lookup-gate.js'
  import { runStLookupVet, type StLookupVetInput } from '../llm/st-lookup-vet.js'
  import type { SkillCheckFramePayload } from './tiers/types.js'

  /** A per-substrate resolver closure: over-pull the store and report whether the
   *  pull was DEGRADED (an infra blip swallowed to empty) vs genuinely empty.
   *  searchLore is total (throws → []) so its closure reports degraded by
   *  catching nothing but flagging when the embedder failed; the graph closures
   *  catch their throws and report degraded:true. The `results` string is the
   *  tier-annotated, pre-rendered block the ST-vet reads. */
  export interface ResolverResult {
    readonly results: string
    readonly degraded: boolean
    readonly empty: boolean
  }
  export type SubstrateResolver = () => Promise<ResolverResult>

  /** The vet-bound context the orchestrator needs (the opaque vet closure
   *  captures sdPlaybook; the orchestrator never sees the raw playbook). */
  export interface WorldFactLookupVet {
    (input: Omit<StLookupVetInput, 'sdPlaybook'>): Promise<{ mode: 'relay'|'none'|'invent'; text: string; repairAttempted: boolean }>
  }

  export interface WorldFactLookupInput {
    readonly gate: WorldLookupGateInput
    readonly question: string
    readonly recentNarrative: string
    readonly npcFraming: string
    readonly resolve: SubstrateResolver
  }

  export interface WorldFactLookupDeps {
    readonly gateDeps: WorldLookupGateDeps
    readonly vet: WorldFactLookupVet
    readonly worldTone: string
    readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
  }

  export interface WorldFactLookupResult {
    readonly relayText: string
    readonly skillGateFrame?: SkillCheckFramePayload
    readonly rollHidden: boolean
  }

  export async function runWorldFactLookup(
    deps: WorldFactLookupDeps,
    input: WorldFactLookupInput,
  ): Promise<WorldFactLookupResult> { /* gate → (skip on fail) → resolve (catch) → vet (catch) → relay */ }
  ```
  Body shape:
  1. `const gate = await resolveWorldLookupGate(deps.gateDeps, input.gate)`.
  2. `if (gate.outcome === 'fail')` → return `{ relayText: gate.failConstraint, skillGateFrame: gate.frame, rollHidden: gate.rollHidden }`. (Resolver + vet skipped.)
  3. Determine `skillGateFrame`/`rollHidden`: `auto_success` → omit the frame; `pass` → carry `gate.frame`/`gate.rollHidden`.
  4. `let resolved: ResolverResult; try { resolved = await input.resolve() } catch (err) { deps.logger?.warn(...); resolved = { results: '', degraded: true, empty: true } }`.
  5. `let vetOut; try { vetOut = await deps.vet({ question, recentNarrative, channel, npcFraming, results: resolved.results, resolverDegraded: resolved.degraded, worldTone }) } catch (err) { deps.logger?.warn(...); return failSoft(...) }`.
  6. `if (vetOut.repairAttempted) return failSoft(...)` (§5 discard-on-repair).
  7. Else `return { relayText: vetOut.text, ...(skillGateFrame ? {skillGateFrame} : {}), rollHidden }`.
  8. `failSoft` returns a channel-appropriate relay (`input.gate.channel === 'npc' ? "They don't seem to know." : "You can't quite bring it to mind."`), carrying the same `skillGateFrame`/`rollHidden`.
- [ ] **Run / PASS:** `pnpm vitest run backend/src/session/__tests__/world-fact-lookup.test.ts`
- [ ] **Commit:** `feat(MYT-72): world-fact-lookup orchestrator (gate→resolve→ST-vet→relay, fail-soft)`

---

## T6 — The three FT tools + `FtToolDeps` (`ft-tools.ts`, §3/§10)

`search_lore`/`characters_known_to`/`faction_tree` tool entries (flat schemas, `channel` discriminator, DM knowledge-skill enum). `FtToolDeps` gains the search resolvers + graph deps + `worldId` + the name→id resolver + an **opaque `vet` closure** (NOT the raw `sd_playbook`). Each tool's `execute` builds its substrate closure (which renders the tier-annotated results block) and calls `runWorldFactLookup`, returning the relay as a data-only `tool_result`.

**Files:**
- Modify: `backend/src/session/tiers/ft-tools.ts`
- Test: `backend/src/session/tiers/__tests__/ft-tools.test.ts`

**Steps:**

- [ ] **Write failing tests** in `ft-tools.test.ts` (model on the existing skill-check/ledger tool tests). With a mocked `runWorldFactLookup` (or mocked resolvers + vet), assert:
  - `search_lore` execute routes `{ channel:'dm', skill:'history', topic:'…' }` → builds a search closure (asserts `searchLore(worldId, topic, {})` called) → returns `{ result: <relayText> }` shape (a data-only tool result; the relay text the FT narrates).
  - `characters_known_to` execute resolves `character` name → id via `findIdByWorldAndNormalizedName`; a name that resolves to `null` → a clean "no such character" relay (NOT an error; vet not called).
  - `faction_tree` execute resolves `faction` name → id → `factionTree` closure.
  - **DM skill enum:** the `inputSchema` constrains `skill` to `KNOWLEDGE_SKILLS` (assert the Zod schema rejects `'athletics'`).
  - **Flat root:** assert each `inputSchema` `toJSONSchema` (or the Zod shape) is a root `z.object` (no `discriminatedUnion`).
  - **Enforced-ignorance leak (mocked):** the `vet` closure captures `sdPlaybook`; assert `FtToolDeps` has no `sdPlaybook` field and `ft-tools.ts` never references a raw playbook string — the tool only ever receives `{relayText, skillGateFrame}` from the orchestrator (a structural assertion: the tool result equals the relay text, never the over-pulled results).
- [ ] **Run / FAIL.**
- [ ] **Implement.** Add to `FtToolDeps`:
  ```ts
  export type FtToolDeps = Omit<SkillCheckDeps, 'abortSignal'> & {
    readonly ledger: LedgerOps
    readonly runInTx: LedgerTxRunner
    readonly turnId: string
    // ── MYT-72 lookup surface ──
    readonly worldId: string
    readonly search: SearchResolvers                 // createSearchResolvers(...)
    readonly graph: GraphDeps                          // { repo: Pick<Repo,'worldRetrieval'> }
    readonly resolveEntityId: (name: string) => Promise<string | null>  // repo.entities.findIdByWorldAndNormalizedName(worldId, name)
    readonly recentNarrative: () => string             // recent-exchanges slice for the vet (thread-consistency, §5)
    /** OPAQUE: the ST-vet with sdPlaybook captured inside. NEVER the raw playbook.
     *  ft-tools.ts / fast-thinker.ts never hold a secret string by construction. */
    readonly vet: WorldFactLookupVet
    /** Build the public asker summary for the gate (DM: PC sheet/ft_context;
     *  NPC: entity public identity). Public-only by construction. */
    readonly askerSummary: (channel: 'dm'|'npc', detail: { skill?: KnowledgeSkill; npcName?: string; topic: string }) => Promise<string>
  }
  ```
  The three input schemas (flat, `channel` discriminator):
  ```ts
  const CHANNEL = z.enum(['dm', 'npc'])
  const DM_SKILL = z.enum(KNOWLEDGE_SKILLS)
  export const SEARCH_LORE_INPUT = z.object({
    channel: CHANNEL, topic: z.string().min(1),
    skill: DM_SKILL.optional(),       // required-per-channel (dm); resolver-enforced
    npc_name: z.string().min(1).optional(),  // required-per-channel (npc)
  })
  export const CHARACTERS_KNOWN_TO_INPUT = z.object({
    channel: CHANNEL, character: z.string().min(1), name: z.string().min(1).optional(),
    skill: DM_SKILL.optional(), npc_name: z.string().min(1).optional(),
  })
  export const FACTION_TREE_INPUT = z.object({
    channel: CHANNEL, faction: z.string().min(1),
    skill: DM_SKILL.optional(), npc_name: z.string().min(1).optional(),
  })
  ```
  Each tool's `execute` (TOTAL — never throws into the FT):
  - Build the gate input: `channel`; `topic` = the topic/character/faction; `askerSummary` via `deps.askerSummary(...)`; DM → `{ character, skill, skills }` (resolve the PC via `deps.mech.findSessionParticipantCharacterByName` — reuse the skill-check `mech`; on not-found, a clean blank relay); NPC → `{ entityId, npcName }` (resolve the NPC entity id via `deps.resolveEntityId(npc_name)`; null → clean "no such NPC" relay).
  - Build the substrate closure that over-pulls + renders the tier-annotated `results` block:
    - `search_lore`: `const hits = await deps.search.searchLore(deps.worldId, topic, {})` → render each `LoreHit` as `[tier=${h.accessLevel}] ${h.entityName}: ${h.content}`; `degraded` = false unless the closure detects an embedder failure (searchLore swallows to []; surface a degraded flag by probing — simplest: searchLore can't report degraded, so for v1 treat `[]` as `degraded: false, empty: true` and rely on the ST-vet's `none` arbitration; the **graph** closures are the ones that catch throws → `degraded: true`). Document this asymmetry inline (searchLore's degraded-empty is the known v1 gap the spec §7 names; the boolean is wired but searchLore's own total-swallow can't set it — only the graph throws can).

      > **Plan resolution (searchLore degraded signal).** searchLore is TOTAL and cannot distinguish embed-failure-empty from genuine-empty. To honor §7's `resolver_degraded`, the search closure calls `deps.search.searchLore` and, on a returned `[]`, does a cheap secondary probe is NOT worth it — instead, the closure wraps the call so an embedder throw (if searchLore ever surfaced one) maps to degraded. Since searchLore never throws, the search-channel `degraded` is always false in v1; the graph channels carry the real degraded signal. This matches the spec's framing that the graph path is the leak-critical one and searchLore's degraded-empty is an accepted v1 edge. Note this limitation in the closure comment.
    - `characters_known_to`: `try { const res = await charactersKnownTo(deps.graph, entityId, name ? { nameFilter: name } : {}) ; render each KnownCharacter as [tier=${c.accessLevel}] ${c.name} (depth ${c.depth}) } catch { degraded: true }`.
    - `faction_tree`: `try { const { nodes, truncated } = await factionTree(deps.graph, entityId); render each FactionNode as [tier=${n.accessLevel}] ${n.name} (parent ${n.parentId ?? 'root'}, depth ${n.depth}); note truncated } catch { degraded: true }`.
  - `const out = await runWorldFactLookup({ gateDeps, vet: deps.vet, worldTone: deps.worldTone, logger }, { gate, question, recentNarrative: deps.recentNarrative(), npcFraming, resolve })`.
  - **Return data-only:** `return { result: out.relayText }` — the relay text only. The skill-gate frame rides a side channel: since tools can't emit, the result also carries `__skillGateFrame` / `__rollHidden` keys the consume loop reads (T7). **Decision:** carry the frame in the tool output under reserved keys (e.g. `{ result: out.relayText, skill_gate: out.skillGateFrame ?? null, roll_hidden: out.rollHidden }`), and T7 maps `skill_gate` → a skill-check frame in `emitFrameForResult`. The relay text is the only field the FT narrates from; the frame keys are consumed by the emitter, not the model (the model sees the whole tool result, but the frame payload is mechanical metadata — keep it secret-free, which it is: it's roll numbers + a public constraint, never `sd_playbook`).
- [ ] **Run / PASS:** `pnpm vitest run backend/src/session/tiers/__tests__/ft-tools.test.ts`
- [ ] **Commit:** `feat(MYT-72): search_lore / characters_known_to / faction_tree FT tools + opaque vet dep`

---

## T7 — Frame emission (`fast-thinker.ts`, `types.ts`, §10)

An `emitFrameForResult` branch mapping the lookup result's `skill_gate` sub-payload to a skill-check frame; an NPC roll-hidden `TurnEmitter`/payload variant that omits the roll fields and renders identically to a hidden pass (no metagame tell, §4.2). Corrects §2's "no new emitter method needed."

**Files:**
- Modify: `backend/src/session/tiers/fast-thinker.ts`
- Modify: `backend/src/session/tiers/types.ts`
- Test: `backend/src/session/tiers/__tests__/fast-thinker.test.ts`

**Steps:**

- [ ] **Write failing test** in `fast-thinker.test.ts` (model on the existing skill-check frame-emission tests). Drive a fake stream whose `tool-result` part is a `search_lore` output `{ result: 'relay…', skill_gate: { characterName, skill, roll, dc, total, outcomeTier, constraint, ... }, roll_hidden: false }`. Assert `emit.emitSkillCheck` fires with the mapped frame. Then a `roll_hidden: true` (NPC) variant → assert the emitted payload omits/zeroes the roll fields (a hidden-pass variant) via a new `emitWorldLookupCheck` (or a `rollHidden` flag on the existing `emitSkillCheck` payload). Also: a result with `skill_gate: null` (auto-success) → NO frame emitted.
- [ ] **Run / FAIL.**
- [ ] **Implement.**
  - In `types.ts`: extend `SkillCheckFramePayload` is risky (it's persisted + shared). Instead add a sibling payload that the publisher can render identically when `rollHidden`:
    ```ts
    /** §4.2 NPC roll-hidden world-lookup check. Renders identically to a hidden
     *  skill pass — the player never sees the roll (a visible instant-vs-rolled
     *  difference would leak the NPC's hidden standing). Carries the public
     *  outcome only. */
    export interface WorldLookupCheckFramePayload {
      readonly characterName: string
      readonly skill: string
      readonly context: string
      readonly outcomeTier: 'fail' | 'success' | 'great_success'
      readonly constraint: string
      readonly rollHidden: true
    }
    ```
    Add to `TurnEmitter`: `emitWorldLookupCheck(payload: SkillCheckFramePayload | WorldLookupCheckFramePayload): Promise<void>`. **Simpler alternative (pick this):** reuse `emitSkillCheck` with a `rollHidden?: boolean` added to `SkillCheckFramePayload` (optional, defaults absent) and let the **publisher** omit roll fields when `rollHidden`. This avoids a second emitter method and keeps the latched-emitter (`makeLatchedEmitter`, turn-worker.ts) untouched. **Decision: add `readonly rollHidden?: boolean` to `SkillCheckFramePayload`** and have the NPC path set it true; the DM path leaves it absent. The publisher (out of scope for this task — note it for T9/wiki) reads it.
  - In `fast-thinker.ts` `emitFrameForResult`: add a branch for the three lookup tool names. Map the `out.skill_gate` record (when non-null) to a `SkillCheckFramePayload` (reuse `toSkillCheckFrame`, plus the `rollHidden` flag from `out.roll_hidden`). When `skill_gate` is `null` (auto-success or fail-soft-with-no-frame) → emit nothing.
    ```ts
    const LOOKUP_TOOL_NAMES: ReadonlySet<string> = new Set(['search_lore','characters_known_to','faction_tree'])
    // in emitFrameForResult, before the ledger branch:
    if (LOOKUP_TOOL_NAMES.has(toolName)) {
      const gate = out.skill_gate
      if (gate === null || gate === undefined) return        // auto-success / no-frame fail-soft
      await emit.emitSkillCheck({ ...toSkillCheckFrame(asRecord(gate)), ...(out.roll_hidden === true ? { rollHidden: true } : {}) })
      return
    }
    ```
    Note: `emitFrameForResult`'s existing guard `if ('error' in out) return` would suppress a frame — but lookup tools never return an `error` key (they're TOTAL via relay), so the guard is a no-op for them. Confirm the lookup output shape never has an `error` key.
- [ ] **Run / PASS:** `pnpm vitest run backend/src/session/tiers/__tests__/fast-thinker.test.ts`
- [ ] **Commit:** `feat(MYT-72): emit skill-gate frame for lookups (NPC roll-hidden variant)`

---

## T8 — Transcript-codec mapping (`transcript-codec.ts`, §6)

The three new tool names are not in `TOOL_TO_KIND` — `assistantToRows` throws `TranscriptCorruptError` on an unknown tool. **Decision (resolves §6/§11):** **PERSIST** the lookup tool-result (add the mapping), because the FT's full-transcript memory is the only continuity mechanism in v1 (D1 — no working set), so stripping the relay would make the FT forget what it just told the player mid-session. The persisted relay is therefore durable public canon and **must be provably secret-free** — which the ST-vet guarantees (the relay is the vet's sanctioned output; the over-pulled results never enter the tool result). The persisted row content is the canonical `{toolCallId, input, output}` JSON, exactly like the roll rows; `output` is `{ result: <relayText>, skill_gate: …, roll_hidden: … }` — all secret-free.

**Files:**
- Modify: `backend/src/session/transcript-codec.ts`
- Test: `backend/src/session/__tests__/transcript-codec.test.ts`

**Steps:**

- [ ] **Write failing test** in `transcript-codec.test.ts`: an `AssistantMessage` with a `search_lore` tool_call+tool_result pair → `assistantToRows` produces a `world_fact_lookup` row (not a throw); `rowsToConversation` round-trips it back to a tool_call+tool_result pair with the same `toolCallId`/`input`/`output`. Mirror for `characters_known_to` and `faction_tree`. Assert the round-trip is byte-stable (the §3.9 cache requirement).

  > **Decision (one kind for all three vs three kinds).** Use ONE `world_fact_lookup` `DmMessageType` for all three tools (they share the read-only no-mutation semantics and a single relay-shaped output), with the **tool name preserved in the row JSON** so the round-trip restores the exact `toolName`. This avoids three near-identical kinds. The `KIND_TO_TOOL` direction needs the tool name — so the row JSON gains a `toolName` field, and `appendDmRowParts` reads it back. Update `RollRowJson` handling for this kind to carry `toolName`.

- [ ] **Run / FAIL** (`TranscriptCorruptError: unknown tool name … search_lore`).
- [ ] **Implement.** Add `'world_fact_lookup'` to `DM_MESSAGE_TYPES`. The three tools map to it in `TOOL_TO_KIND`:
  ```ts
  const TOOL_TO_KIND: Record<string, Exclude<DmMessageType, 'dm_text'>> = {
    roll_skill_check: 'skill_check',
    roll_dice: 'dice_roll',
    cast_spell: 'cast_spell', spend_resource: 'spend_resource', acquire_resource: 'acquire_resource',
    adjust_hp: 'adjust_hp', update_condition: 'update_condition', take_rest: 'take_rest',
    // MYT-72 — all three lookup tools persist as one kind; toolName rides the row JSON.
    search_lore: 'world_fact_lookup', characters_known_to: 'world_fact_lookup', faction_tree: 'world_fact_lookup',
  }
  ```
  For the reverse direction, `KIND_TO_TOOL['world_fact_lookup']` can't be a single tool name (three map in). So: in `assistantToRows`, for a lookup tool, write the row JSON **with `toolName`** included: `{ toolCallId, toolName: part.toolName, input, output }`. In `appendDmRowParts`/`parseRollRow`, when `messageType === 'world_fact_lookup'`, read `toolName` from the parsed JSON (fall back to `'search_lore'` only if absent, with a corrupt-guard). Adjust `RollRowJson` to carry an optional `toolName`, and `parseRollRow` to surface it. Keep the existing roll rows unchanged (they don't write `toolName`; `KIND_TO_TOOL` still resolves theirs).
- [ ] **Run / PASS:** `pnpm vitest run backend/src/session/__tests__/transcript-codec.test.ts`
- [ ] **Commit:** `feat(MYT-72): persist + round-trip world_fact_lookup transcript rows (secret-free relay)`

---

## T9 — Boot/turn wiring (`turn-worker.ts`, `worker.ts`, §6)

Thread the boot-probed `VoyageEmbedder` + `voyageApiKey` into `buildSessionTurnWorker`; resolve+cache `worldId` on the `:state` blob; add a SEPARATE narrow `sdPlaybook` read (NOT widening `{ftContext}`); construct `createSearchResolvers` + graph deps + the opaque `vet` closure in `makeTiers`; pin the timeout under the FT budget.

> **Plan note (one call site, not two).** The brainstorm hypothesized "likely TWO `buildSessionTurnWorker` sites (worker.ts + server.ts)." **Verified:** there is exactly ONE — `worker.ts:160`. `server.ts` only enqueues turns; it does not build the turn worker. So T9 touches `worker.ts` + `turn-worker.ts` only. (The embedder is already boot-probed in `worker.ts:78` via `probeVoyageAtBoot(createVoyageEmbedder({ apiKey: env.voyageApiKey }), logger)` — but that instance is currently discarded after the probe; capture it and pass it through.)

**Files:**
- Modify: `backend/src/session/turn-worker.ts` (`buildSessionTurnWorker` signature + `makeTiers` + `TurnWorkerRepo` gains a `worldId` resolution + a narrow `lookupVet` repo surface; `:state` worldId cache)
- Modify: `backend/src/worker.ts` (capture the probed embedder; pass `embedder` + `env.voyageApiKey` into `buildSessionTurnWorker`)
- Test: `backend/src/session/__tests__/turn-worker.test.ts`

**Steps:**

- [ ] **Write failing test** in `turn-worker.test.ts` (model on the existing converge-path builder tests, which don't spend tokens). Two unit-testable seams:
  - **`worldId` cache:** a new exported helper `resolveWorldId(repo, sessionState, campaignId, sessionId)` that reads the `:state` blob, returns `state.worldId` when present, else `repo.campaigns.getWorldId(campaignId)` and re-writes the blob with `worldId` set. Test: blob has `worldId` → no `getWorldId` call; blob lacks it → `getWorldId` called once + blob re-written. (Add `worldId?: string` to `SessionStateBlob` in `session-state.ts` — a one-line additive change; mirror the `ftContext`/`worldTone` pass-through in `getState`.)
  - **Narrow `sdPlaybook` read:** add a `LookupVetRepo` interface (its OWN `sessionPreps.getBy → {sdPlaybook}` surface, like `StEvalRepo`) — NOT widening `TurnWorkerRepo.sessionPreps`. Assert the FT-side `TurnWorkerRepo.sessionPreps.getBy` return type stays `{ftContext}` (a type-level assertion / a fake that only provides `{ftContext}` still satisfies `TurnWorkerRepo`).
- [ ] **Run / FAIL.**
- [ ] **Implement.**
  - `session-state.ts`: add `readonly worldId?: string` to `SessionStateBlob`; pass it through in `getState` (`...(typeof blob.worldId === 'string' ? { worldId: blob.worldId } : {})`).
  - `turn-worker.ts`:
    - `buildSessionTurnWorker(redisBatch, redisRealtime, redisKeyPrefix, logger, pool, embedder: VoyageEmbedder, voyageApiKey: string)` — append the two params (the boot-probed embedder + the key; the key is unused if the embedder is passed, but keep it for symmetry / a future per-turn rebuild — **decision: pass only the probed `embedder`; drop `voyageApiKey`** since the embedder is already constructed + probed at boot and per-turn reconstruction is wasteful + un-probed, §6. If the signature must carry the key for a future need, mark it `readonly` and unused — but prefer the embedder-only signature).

      > **Resolved:** pass the **probed `embedder` only** (not the raw key). The §6 rationale is explicit that per-turn embedder construction is the silent-degradation bug; the boot-probed instance is the correct shared dependency.
    - In the fresh-run arm of `processTurnJob`, resolve `worldId` via the new `resolveWorldId(...)` helper (cached on `:state`), and thread it into `TierTurnArgs`.
    - Add `worldId` to `TierTurnArgs`.
    - In `makeTiers`, construct the lookup deps:
      ```ts
      const search = createSearchResolvers({ embedder, repo: { transaction: (fn, o) => repo.transaction(fn, o) }, logger })
      const graph: GraphDeps = { repo }
      const vet: WorldFactLookupVet = async (vetInput) => {
        // Capture sdPlaybook INSIDE the closure (the secret never escapes here).
        // BOUNDARY-CRITICAL: read it via a DEDICATED narrow surface, NOT the FT-side
        // TurnWorkerRepo.sessionPreps.getBy (which stays {ftContext}-only — the MYT-69
        // split). Mirror StEvalRepo: define a LookupVetRepo with its OWN
        // sessionPreps.getBy → {sdPlaybook} read (a new narrow repo method, e.g.
        // `getSdPlaybookBy(campaignId, sessionNumber)`), constructed here and referenced
        // ONLY by this closure. The raw `sdPlaybook` string is never a field on
        // FtToolDeps or visible to ft-tools.ts / fast-thinker.ts.
        const sdPlaybook = (await lookupVetRepo.getSdPlaybookBy(campaignId, sessionNumber)) ?? ''
        const r = await runStLookupVet({ ...vetInput, sdPlaybook })
        return { mode: r.result.mode, text: r.result.text, repairAttempted: r.repairAttempted }
      }
      ```
      (`lookupVetRepo` is the dedicated narrow surface — add a `getSdPlaybookBy` read on a repo namespace whose result is ONLY consumed in this closure; confirm the exact `session_preps` SQL against `sessionPreps`'s existing reads. Resolve `sessionNumber` the same way `reloadFtContext` does — `repo.sessions.getById(sessionId).sessionNumber`. The spec-compliance review for T9 MUST verify `TurnWorkerRepo.sessionPreps.getBy`'s return type is unchanged `{ftContext}` and that no raw `sdPlaybook` reaches `FtToolDeps`.)
      Pass `worldId`, `search`, `graph`, `resolveEntityId: (name) => repo.entities.findIdByWorldAndNormalizedName(worldId, name)`, `recentNarrative`, `vet`, `askerSummary` into `buildFtTools({ ...existing, worldId, search, graph, resolveEntityId, recentNarrative, vet, askerSummary })`.
      - `recentNarrative`: the controller already reconstructs `ftHistory`; for the vet's thread-consistency slice, render the last N exchanges (reuse the `formatExchanges` pattern from `st-evaluation-worker.ts` or pass a thunk that reads the controller's loaded history). Simplest v1: thread the last few `ftHistory` text parts as a string thunk.
      - `askerSummary`: DM → the PC's public sheet line (name/class/level/background — already available via the skill-check `mech` read) + a slice of `ftContext`; NPC → the entity's public name + type. Public-only.
  - `worker.ts`: capture the probed embedder — `const embedder = createVoyageEmbedder({ apiKey: env.voyageApiKey }); await probeVoyageAtBoot(embedder, logger);` then `buildSessionTurnWorker(redisBatch, redisRealtime, env.redisKeyPrefix, logger, pg, embedder)`.
- [ ] **Run / PASS:** `pnpm vitest run backend/src/session/__tests__/turn-worker.test.ts`
- [ ] **Run** `pnpm typecheck` (the signature change ripples to `worker.ts` + any test builders).
- [ ] **Commit:** `feat(MYT-72): wire boot-probed embedder + worldId cache + opaque vet into the turn worker`

---

## T10 — Controller: full leak-test matrix + gated real-LLM constructed smoke (§9)

**Controller-run** (like MYT-71's T12/T13). The leak matrix is the load-bearing enforced-ignorance proof; the smoke is the real-Opus/real-Voyage E2E that the dev-tool-E2E rule requires before handing back.

**Files:**
- Create: `backend/src/session/__tests__/world-lookup-leak.test.ts` (real PG, mocked LLM where deterministic; real LLM only in the smoke)
- Create: `scripts/smoke/myt-72-world-lookup-smoke.ts` (or wire into the existing dev-tool smoke harness — check `scripts/smoke/` for the MYT-71/68 precedent)

**Steps (leak matrix — vitest, real PG + mocked/forced vet output):**

- [ ] **(a) secret FACT via `search_lore`:** seed a `secret`-tier fact relevant to a query; run the search closure → assert the over-pulled `secret` fact REACHES the vet input (`results` block contains it, tier-tagged) but the vet relay (with a forced `mode:'relay'` returning only public content) → the `tool_result` NEVER contains the secret string.
- [ ] **(b) secret ENTITY via `faction_tree` + `characters_known_to`:** seed a `secret`-tier child entity in a faction subtree (and a relationship); assert its name reaches the **tier-annotated** vet input (T1) and NEVER the relay.
- [ ] **(c) malformed ST-vet output carrying a secret:** force the vet's `generateText` to reject with `cause.text` containing a secret → assert (via `logger.warn` spy + the rethrown `.diagnostic`) the secret appears in NO log / diagnostic / `pipeline_runs.error` / SSE frame (T4a's `redactRawText`), AND the tool fail-softs to a generic relay.
- [ ] **(d) persistence round-trip:** drive a lookup turn through the codec (T8) → assert the persisted `world_fact_lookup` DM row + the replayed `tool_result` carry no secret.
- [ ] **Skill-gate matrix:** DM pass/fail → resolve/blank; DM auto-success → no roll, no frame; mis-picked non-knowledge skill → rejected by the enum (not an `Unknown skill` blank); NPC pass/fail with `entityId`-seeded fab; NPC renders identically auto-success vs hidden-pass (assert the emitted frame is roll-hidden in both).
- [ ] **Miss → invent/none/degraded:** empty + healthy → `invent`; genuine empty → `none`; `resolver_degraded` empty → biases to `none`/fail-soft, NOT `invent` (force the graph closure to throw → degraded → assert the vet got `resolverDegraded: true`).
- [ ] **Repair → fail-soft:** a `repairAttempted` vet result → discarded to the fail-soft relay (never repair-authored text); vet timeout/error → fail-soft, never raw error or unvetted leak.
- [ ] **Run:** `pnpm vitest run backend/src/session/__tests__/world-lookup-leak.test.ts`

**Steps (gated real-LLM constructed smoke — controller drives manually):**

- [ ] Seed a world with both PUBLIC and SECRET facts/entities on one topic (a public faction with a secret sub-faction; a secret fact on a public NPC), embed them (real Voyage), and a session_prep `sd_playbook` carrying the secret.
- [ ] Drive a real `search_lore` AND a real `faction_tree` (DM channel) through the real resolver + the **real Opus ST-vet**; assert the relay surfaces the PUBLIC content and NEVER the secret string.
- [ ] Exercise **all three modes against real Opus** — `relay` (hit), `none` (genuine empty topic), `invent` (a real gap) — plus the NPC channel and the secret-aware auto-success (a PC who SECRETLY heads the org → the ST-vet upgrades to a confident relay using `sd_playbook`, while the public Haiku gate would have set a high DC).
- [ ] Inspect at the WIRE LEVEL (curl/SSE/psql): the SSE skill-gate frame (roll-hidden on NPC), the persisted `world_fact_lookup` row (secret-free), `pipeline_runs`/logs (no secret snippet). NEVER via browser automation.
- [ ] Only after the smoke passes: hand back. (Per `feedback_dev_tool_e2e_smoke_required` / `feedback_manual_smoke_is_not_optional`.)
- [ ] **Commit:** `test(MYT-72): enforced-ignorance leak matrix + real-LLM constructed smoke`

---

## Self-review

**Spec § → task coverage map:**

| Spec § | Requirement | Task(s) |
|---|---|---|
| §1 / §1.1 D1 | relay-only, no durable writes | T5 (no write primitive), T8 (persist relay only), primer #2 |
| §1.1 D2 | both DM + NPC channels | T3 (gate channels), T6 (tool channel arg), T7 (NPC roll-hidden) |
| §1.1 D3 | family of 3 per-substrate tools, flat schemas | T6 |
| §1.1 D4 | ST-vet = new sync Opus, st-director pattern | T4b |
| §1.1 D5 / §4.1 | contextual DC + auto-success | T3 |
| §2 / §3 | deterministic flow inside tool; 3 tools | T5, T6 |
| §4 / §4.1 | skill-gate, flat `{auto_success,dc,outcomes}`, public-standing | T3 |
| §4.2 | DM knowledge enum; NPC entityId-seeded fab; no metagame tell | T3, T6 (enum), T7 (roll-hidden) |
| §5 | ST-vet input/output, discard-on-repair, secret-aware override | T4b, T5 (repair fail-soft) |
| §5 snippet suppression | redact rawTextSnippet | T4a, T4b |
| §5.1 | graph results tier-annotated | T1 |
| §6 wiring | embedder, worldId cache, opaque vet, narrow sdPlaybook read | T9 |
| §6 codec | world_fact_lookup mapping (persist chosen) | T8 |
| §6 leak invariant | all egresses secret-free | T10 (matrix) |
| §7 | TOTAL/fail-soft arms, degraded≠empty, timeout ordering | T5, T9 (timeout pin) |
| §8 | relay-only + accepted v1 cross-lookup-divergence limit | T5, primer #2 (noted, not closed — MYT-73) |
| §9 | full test suite | T3/T4/T5/T6/T7/T8 unit + T10 matrix + smoke |
| §10 | every interface contract | T1–T9 (each contract has a task) |
| §11 name→id | exact normalized match (resolved) | T2 |
| §11 persist-vs-strip | persist (resolved) | T8 |
| §11 NPC playbook slice | npcFraming passed to vet; sd_playbook carries it | T4b (npcFraming var), T6/T9 (build it) |

**Open questions resolved inline:** (1) name→id = exact normalized match, not fuzzy (T2 rationale — a wrong fuzzy id walks the wrong subtree). (2) persist (not strip) the lookup tool-result (T8 — the FT's transcript is the only v1 continuity, so the relay must persist; secret-free by the ST-vet's guarantee). (3) NPC playbook slice = `npcFraming` var threaded into the vet prompt, sourced from `sd_playbook` + the entity's public identity.

**Ambiguities surfaced + how resolved:** (a) The brainstorm assumed TWO `buildSessionTurnWorker` sites — **verified only ONE** (`worker.ts`); `server.ts` only enqueues. Plan updated (T9). (b) The `ai.ts` rawTextSnippet suppression had no existing seam — added a `redactRawText` opt (T4a) rather than a separate `generateObject` clone, the smaller surface; conservatively redacts BOTH snippet + zodIssues under the flag. (c) searchLore is TOTAL and cannot self-report degraded-empty — the `resolver_degraded` signal is carried by the GRAPH closures (which catch throws); searchLore's degraded-empty is the accepted v1 edge the spec §7 names, documented inline (T6). (d) The skill-gate frame can't be emitted by the tool (tools never emit) — carried in the tool output under reserved `skill_gate`/`roll_hidden` keys the consume loop reads (T6/T7); the keys are mechanical + secret-free (roll numbers + a public constraint).

**Placeholder scan:** no `<TODO>` / `...sketch...` left — every schema, prompt, function body, and `pnpm vitest run` command is concrete. The prompt templates carry full verbatim-grade content (3-mode trichotomy, tier-safety, NPC framing, secret-aware standing for the vet; contextual-DC + auto-success + public-standing-only for the gate).

**Type-consistency across tasks:** `AccessLevel` (`'known'|'discoverable'|'secret'`) is the single tier type (T1 adds it to graph results, T4b's `tier` enum mirrors it, T5/T6 render it). `SkillCheckFramePayload` is reused for the gate frame (T3 builds it, T7 emits it) with one additive optional `rollHidden?: boolean` (T7). `KnowledgeSkill` enum is single-sourced in `world-lookup-config.ts` (T3) and consumed by the DM tool schema (T6). The `vet` closure type `WorldFactLookupVet` (`Omit<StLookupVetInput,'sdPlaybook'>` in, `{mode,text,repairAttempted}` out) is consistent between the orchestrator (T5), the tool deps (T6), and the wiring (T9 captures `sdPlaybook` inside). `WorldLookupGateResolution`'s `pass`/`fail`/`auto_success` outcomes are consumed identically by the orchestrator (T5). `SessionStateBlob.worldId?` is additive (T9) and mirrors the existing `ftContext?`/`worldTone?` pass-through.

**Coverage discipline (controller, pre-push):** implementer subagents run only their own test file; before the push the controller runs full `pnpm lint` + scoped coverage (`pnpm vitest run <test> --coverage --coverage.include='<source>'`) on every new/modified file and sweeps lint + coverage debt (per `feedback_implementers_skip_lint_and_coverage`). New prompt `.txt` files don't need coverage; new `.ts` files hit the 100% gate. Then `pnpm typecheck && pnpm lint && pnpm test`, the dev-tool-verifier (no dev-tool panels here, but run it), the wiki subagent LAST, and a single push.
