# MYT-70 — Rules Lawyer & Shared Live Character Ledger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce out-of-combat resource use deterministically. Ship the **shared live character ledger** (HP / spell slots / gold / inventory / limited-feature uses / conditions / hit dice — the single per-character mechanical-state record, PG-direct), the **Rules Lawyer** (a deterministic, server-authoritative validate→mutate service — NOT an LLM tier), and **six FastThinker tools** (`cast_spell`, `spend_resource`, `acquire_resource`, `adjust_hp`, `update_condition`, `take_rest`) registered at the `ft-tools.ts` extension point. Done when: casting a spell decrements the slot, an over-spend is rejected with a constraint the FT narrates, and state persists to the ledger.

**Architecture:** ZFC-clean orchestration. **Interpretation** (player intent → structured action) is the FT's tool call; **adjudication + mutation** (legality + state change) is the Rules Lawyer — a set of pure resolvers mirroring `skill-check.ts`'s contract (TOTAL, fail-soft, scoped `LedgerOps` projection). The PG characters tables ARE the ledger (no Redis copy, no checkpoint flush — §2). Every debit is a single guard-predicate `UPDATE … WHERE <guard> RETURNING`; rowcount 0 = adjudicated rejection. Every applied mutation writes a `ledger_events` journal row in the same transaction (observability + idempotent same-call replay — §10). The FT sees a per-turn **party ledger snapshot** (numbers AND nouns) rendered as a render-time ModelMessage AFTER the last cache breakpoint (§7), and emits a `ledger_update` frame per successful tool result in stream-part order (§8). Caster progression / feature uses / consumable / ritual flags are **structured at character generation** by prep (§3.2) — never keyword-matched in code.

**Tech Stack:** Node 24 + TypeScript strict, Fastify, `ai@6` + `@ai-sdk/anthropic`, Postgres (`pg`), Redis (`ioredis`), BullMQ, Vitest. Repo/ledger tests target `mythrun_test` (`DATABASE_URL_TEST`) via the scoped-fixture pattern (`backend/src/__tests__/CONVENTIONS.md`); LLM-adjacent tests mock the `'ai'` boundary (`vi.mock('ai')`), NEVER `ai.ts`; the dice engine is injected an `Rng` for determinism.

**Spec:** `docs/superpowers/specs/2026-06-10-myt-70-rules-lawyer-design.md` (§ references below point there). The §12 file-level change map is the decomposition backbone; the §14 resolved decisions and §15 blind-review record are BINDING — the two showstopper fixes (prepared-semantics §3.2; snapshot-nouns §7) and every folded NIT cluster are implemented here, not re-litigated.

---

## Context primer (read first)

- **The ledger is PG-direct, never Redis (§2).** No Redis copy, no checkpoint, no rebuild path. Each mutation is ONE atomic PG statement (debit = guard-predicate `UPDATE`; credit = `INSERT … ON CONFLICT DO UPDATE`) or, for multi-row ops (rests, the HP-write + condition pair), ONE transaction. **No SELECT-then-UPDATE anywhere** — a zero-rowcount update IS the rejection. The session lock makes turns single-flight, so contention is a non-issue; the lock is coordination, not the safety guarantee (the guard predicate is).
- **ZFC is a hard boundary (§7 §14.7).** The ONLY string operation in the Rules Lawyer is trim + case-fold normalization (`lower(btrim(...))` on both sides — mechanical, not semantic; "fire bolt" matches "Fire Bolt", nothing fuzzier). Caster progression, feature uses, consumable, and ritual are decided ONCE at character generation as structured output (prep §3.2); the live path does pure math (SRD §9.1) + matching. NO keyword heuristics, NO string-matching `class` against SRD names. The §3.1 unique name indexes guarantee at most one row matches a debit; a multi-row match is an invariant violation (log + fail-soft).
- **The Rules Lawyer is TOTAL (§4).** Every game-rule failure arm returns a structured constraint (`{ ok: false, binding, found, constraint }`); the service NEVER throws on game-rule grounds (an uncaught throw becomes a tool-error part the loop continues past — the model would narrate with no adjudication). Infra failure (PG down) → the skill-check fail-soft precedent: a generic "could not be resolved — do not narrate a definite outcome" constraint, `logger.warn`, turn continues. Mirror `skill-check.ts`'s `SkillCheckResolution` shape and its `findSessionParticipantCharacterByName` (`found | not_found | ambiguous`) usage exactly.
- **Binding vs informational (§6) — Miklos's "rock" requirement is load-bearing.** The Rules Lawyer is authoritative about ledger STATE, not about what absence MEANS. **Binding** (`binding:true`): quantified debits on scarce tracked state (insufficient gold, no castable slot, known-but-unprepared spell, exhausted feature uses, tracked consumable at qty 0) — the constraint is the authoritative outcome, the FT narrates HOW it falls short. **Informational** (`binding:false, found:false`): a ledger MISS (item/spell name with no row) — three-branch guidance (environmental object → narrate freely; transcript shows the fiction granted it → call `acquire_resource` NOW then proceed; never-established ownership → correct gently). Unknown SPELLS always take branch 3 (no environmental fireball). The sanctioned narrow gold-recovery rule (§6) lives in the prompt only.
- **prepared = "currently castable" (§3.2 SHOWSTOPPER 1, BINDING).** `cast_spell` gates on `character_spells.prepared`. The prep prompt MUST pin: spontaneous/known casters (sorcerers, bards, warlocks, rangers) emit ALL known spells `prepared:true`; prepare-casters (clerics, druids, wizards, paladins) emit a sensible daily set `true` and the rest `false`; cantrips always `true`. Without this, a model bricks every sorcerer/bard/warlock at generation. Known-but-unprepared is a defined **binding** arm.
- **The snapshot carries the NOUNS (§7 SHOWSTOPPER 2, BINDING).** The party ledger block carries per character: current/max HP, hit dice, gold, slot ledger (`L1 2/3 · L2 0/2`), active conditions, tracked-feature names + uses, **the spell list grouped by level with castable/ritual flags**, and **the full equipment list (names + quantities, consumables flagged)**. Names-only — eliding them makes `cast_spell` undrivable from paraphrase and silently defeats slot enforcement. The FT maps player intent → canonical name (the model's job, ZFC); code does exact matching.
- **Snapshot placement is pinned for cache-correctness (§7).** The block changes EVERY turn, so it renders as a NON-PERSISTED ModelMessage AFTER the last cache breakpoint (current batch, last position) in `buildModelMessages`, injected from `ctx.partyLedger` — NEVER written to `session_messages`, NEVER pushed into `ftHistory`. Following the roster precedent into the system template (`{{party_roster}}`) would bust the static-payload cache every turn (a silent ~10× input-token regression no test catches). Staleness rule: the block is turn-START state; post-mutation truth within the turn comes from the tool-result payloads.
- **Worktree + MYT-69 collision (read the dedicated section below).** This issue implements in a worktree in parallel with MYT-69 landing on main. The overlapping files get SMALL, ADDITIVE edits only.
- **Tools are PURE RESOLVERS (`ft-tools.ts` header rules).** `execute` returns DATA ONLY, NEVER emits a frame; ALL frame emission is in the FT consume loop in stream-part order. Inputs are `z.discriminatedUnion('kind', …)` where a `kind` exists. Tool **descriptions are load-bearing prompt surface** (the `roll_skill_check` precedent) — each debit tool's description carries "the returned constraint is the authoritative outcome — narrate HOW it happens, never whether"; `spend_resource`'s carries the §6 improvised-object scoping.
- **Principle #4 holds (§5 `adjust_hp`/`take_rest`).** Dice-expression heals and hit-dice rolls are rolled by the deterministic dice engine INSIDE the resolver (`rollDice`/`rollD20WithType` from `dice/engine.ts`) — code rolls, never the LLM.
- **Worker rules:** there is a separate dev server — never kill it. Implementer subagents run ONLY their own test file (`pnpm --filter @mythrun/backend vitest run <path>`); the controller runs lint + scoped coverage after each wave (feedback_implementers_skip_lint_and_coverage). Implementers do NOT `git add`/`commit`/`push` — the controller commits each task's files serially (feedback_parallel_agent_commits).
- **Lint gotchas (error-level):** `@typescript-eslint/no-non-null-assertion` (guard, not `!`), `@typescript-eslint/no-deprecated`, `max-lines` 400/module, `max-lines-per-function` 100. 100% coverage gate — budget SCOPED coverage per task (`pnpm vitest run <test> --coverage --coverage.include='<source>'`; never full `test:coverage` during iteration). NO `.max()` on LLM free-prose fields (feedback_no_max_on_llm_prose_fields); `.max()` is fine on short labels + DB-CHECK mirrors (names, gold caps, slot levels).
- **Run tests:** `cd backend && pnpm vitest run src/<path>` (DATABASE_URL_TEST → `mythrun_test`; inspect `mythrun_test` not `mythrun_dev` on a DB-row test failure — reference_tests_target_mythrun_test_db).
- **dev-tool typecheck is separate** (reference_dev_tool_typecheck_separate). This issue touches no `backend/dev-tool/**` sources, so the dev-tool verifier is NOT in scope; `ws-session.ts` / `routes/**` are NOT in the pre-push `dev-tool:verify` trigger list, so the pre-push backend gate is the usual one.
- **UUIDv7 for all PKs:** `import { uuidv7 } from '../repo/uuidv7.js'` (or the relative path) — every new table row id and every `ledger_events` row id. Never `randomUUID` for a PK.
- **SDK / codebase deviation rule:** where the installed `ai@6` types or `exactOptionalPropertyTypes` force a deviation from the sketches below, `pnpm typecheck` is the authority — adjust property reads / generic shapes, keep the structure, never loosen to `any` or add a type assertion.

## Worktree bring-up & MYT-69 collision (BINDING — read before Wave A)

MYT-70 implements in a WORKTREE, in parallel with MYT-69 landing on main. The bring-up flow (CLAUDE.md "Parallel Implementation via Worktrees"):

1. From the main repo: `bd worktree create .worktrees/myt-70` (NOT `git worktree add` — `bd` sets up the `.beads/redirect`).
2. `cd .worktrees/myt-70`
3. `../../scripts/worktree-setup.sh` (symlinks `.env.development`, provisions `mythrun_myt-70` DB, writes `.env.worktree`). Requires `pnpm db:up` first.
4. `pnpm install`
5. `pnpm db:migrate` (applies through 024 + this issue's 025 to the worktree DB).

**Overlapping files with MYT-69 (these get SMALL, ADDITIVE edits ONLY — a new block/field/paragraph, no restructuring — so the serial merge back to main is trivial):**

- `backend/src/session/tiers/fast-thinker.ts` — MYT-69 appends a standing-directive tail message AFTER the breakpoints in `buildModelMessages`; MYT-70 appends the party-ledger snapshot message in the SAME region. **Both are render-time, post-breakpoint, non-persisted tails.** On merge they coexist as two appended messages; pin the ORDER (ledger snapshot first, then standing directive, or vice-versa) so the merged `buildModelMessages` is deterministic — see Task 11's implementer note. The breakpoint-index logic is untouched by both.
- `backend/src/session/turn-worker.ts` — MYT-69 adds the st-eval enqueue + one-shot take on the fresh-run arm; MYT-70 adds the per-turn party-ledger snapshot load alongside the existing roster load. Distinct lines; additive.
- `backend/src/llm/prompts/session/ft-system.txt` — MYT-69 adds the DM-Direction-Protocol/standing paragraph; MYT-70 adds the tool-scoping / improvised-object / gold-recovery / actor-scoping / sub-gp / rest-cadence paragraphs. Append distinct sections; no overwrite.
- `backend/src/session/tiers/types.ts` — MYT-69 retires `StEvaluation`/`SlowThinker` + adds `FtTurnContext.standingDirective?`; MYT-70 adds `FtTurnContext.partyLedger` + `LedgerUpdatePayload`. Distinct new fields. **Do NOT touch the `StEvaluation`/`SlowThinker` retirement** — leave whatever is on main alone; only ADD the MYT-70 fields.
- `backend/src/session/ft-config.ts` — MYT-69 is in `st-config.ts` (no collision there); MYT-70 adds `MAX_GOLD_TRANSACTION` (+ the §11 bounds) to `ft-config.ts`. Additive constant block.

**Merge-back (controller, Wave D, after the issue is fully done):** from the MAIN repo path — `git checkout main && git pull` (catch MYT-69's landed commits), `git merge <worktree-branch>`, resolve the additive collisions above, **re-run full verification on the merged HEAD** (`pnpm typecheck && pnpm lint && pnpm test`), then ONE `git push origin main`. Do NOT `git push` from inside the worktree. `bd worktree remove myt-70` after.

---

## File map / task ownership (non-overlapping per wave)

| Task | Files (Create/Modify) |
|---|---|
| T1 | C: `backend/migrations/025_character_ledger.sql` (+ a migration-applies test if the suite has one; else verified in Wave-B repo tests) |
| T2 | C: `backend/src/session/srd/spell-slots.ts` + test |
| T3 | M: `backend/src/llm/schemas/character-sheet.ts` + extend `backend/src/llm/schemas/__tests__/character-sheet.test.ts`; M: `backend/src/llm/prompts/prep/character-sheet.txt` + (prompt var-contract test if one exists) |
| T4 | M: `backend/src/session/ft-config.ts` + extend its test (§11 constants) |
| T5 | M: `backend/src/contract/session-events.ts` + extend `backend/src/contract/__tests__/session-events.test.ts` (the `ledger_update` frame) |
| T6 | M: `backend/src/repo/characters.ts` (`ReplaceSubTablesInput` extension + the new `LedgerOps`-shaped methods) + extend `backend/src/repo/__tests__/characters.test.ts` |
| T7 | M: `backend/src/llm/prep/stages/character-sheet.ts` (+ processor: dedupe-merge, coherence validation, ledger-init-in-transaction) + extend `backend/src/llm/prep/stages/__tests__/character-sheet.test.ts` |
| T8 | C: `backend/src/session/rules-lawyer.ts` (cast/spend/acquire resolvers) + test |
| T9 | M: `backend/src/session/rules-lawyer.ts` (hp/condition/rest resolvers — SAME file as T8, sequenced after it) + extend the test |
| T10 | M: `backend/src/session/tiers/ft-tools.ts` (register six tools) + extend `backend/src/session/tiers/__tests__/ft-tools.test.ts` |
| T11 | M: `backend/src/session/tiers/types.ts` (`FtTurnContext.partyLedger`, `LedgerUpdatePayload`); M: `backend/src/session/tiers/fast-thinker.ts` (render the snapshot tail) + extend `backend/src/session/tiers/__tests__/fast-thinker.test.ts` |
| T12 | M: `backend/src/session/turn-worker.ts` (load the snapshot per turn) + extend `backend/src/session/__tests__/turn-worker.test.ts` |
| T13 | M: `backend/src/session/transcript-codec.ts` (six per-tool message types in the kind↔tool maps) + extend its test; M: `backend/src/repo/session-messages.ts` (`listFtContextRows` IN-list) + extend its test |
| T14 | M: `backend/src/routes/ws-session.ts` (replay: `ok:true` rows → `ledger_update`; silent-skip `ok:false`; per-character rest frames) + extend the replay test |
| T15 | M: `backend/src/session/tiers/fast-thinker.ts` consume-loop frame emission for the six tools; M: `backend/src/session/turn-publisher.ts` (`ledgerUpdate` + `emitFor`); M: `backend/src/session/tiers/types.ts` (`TurnEmitter.emitLedgerUpdate`) + extend the fast-thinker / publisher tests |
| T16 | M: `backend/src/llm/prompts/session/ft-system.txt` (tool-scoping, 3-branch miss, gold-recovery, actor-scoping, sub-gp, rest cadence) + extend `backend/src/llm/prompts/__tests__/ft-system.test.ts` |
| T17 | Controller: full lint + scoped-coverage sweep (budgeted, NOT optional) |
| T18 | Controller: real-Anthropic E2E smoke (§13, in the worktree, against the worktree DB) → wiki subagent → merge-to-main → single push → Linear Done |

**Waves:**

- **Wave A (parallel — pairwise-disjoint):** T1 (migration), T2 (SRD slot tables), T3 (prep schema + prompt co-evolution), T4 (ft-config), T5 (contract frame). Fully non-overlapping. T2/T3/T4/T5 build against pinned signatures; T1's migration is the schema the Wave-B repo tests run against (so T1 must LAND — be migrated into `mythrun_test` — before Wave B's repo tests pass; the controller applies it after T1 commits).
- **Wave B (parallel):** T6 (`LedgerOps` repo namespace — depends on T1 schema + T2 slot tables for the init derivation it does NOT own, but reads the slot rows), T7 (prep stage processor — depends on T2 slot tables + T3 schema + T6's extended `ReplaceSubTablesInput`). T6 and T7 touch DISJOINT files (`characters.ts` vs `character-sheet.ts` stage); T7 imports T6's binder input shape (build against the pinned `ReplaceSubTablesInput` extension; typecheck is the authority once T6 lands).
- **Wave C (sequenced — `rules-lawyer.ts` is one file):** T8 (cast/spend/acquire) → T9 (hp/condition/rest) on the SAME file, serial. Then T10 (ft-tools registration, imports T8/T9 + T4), T13 (codec + session-messages), T14 (ws replay), T16 (ft-system prompt) can run in PARALLEL with each other (disjoint files) once T8/T9 land. T11 (types + fast-thinker snapshot) and T15 (emit seam: types + fast-thinker consume loop + publisher) BOTH touch `fast-thinker.ts` and `types.ts` — **sequence T11 → T15** (T11 adds `partyLedger`/`LedgerUpdatePayload` + the render tail; T15 adds `emitLedgerUpdate` + the consume-loop emission). T12 (turn-worker snapshot load) runs after T11 (consumes `FtTurnContext.partyLedger` + T6's snapshot read).
- **Wave D (controller-run):** T17 lint + scoped coverage → T18 smoke + wiki + merge-to-main + push + close.

---

### Task 1: migration `025_character_ledger.sql` (§3.1)

**Files:**
- Create: `backend/migrations/025_character_ledger.sql`

025 is the next free number (024 is the highest — verified at draft time). Author the migration VERBATIM from spec §3.1: the `characters` ALTER COLUMNs (`gold`, `hit_die`, `hit_dice_remaining`, `spellcasting_progression`, the one-time HP clamp UPDATE + `characters_hp_bounds` CHECK, the `characters_hit_dice_bound` CHECK), `character_spell_slots` table, the `character_features` ALTER COLUMNs (`max_uses`, `uses_remaining`, `recharge`) + its three CHECK constraints, the `character_equipment` `consumable` column + `character_equipment_quantity_floor` CHECK, the `character_spells` `ritual` column, the three functional UNIQUE name indexes (`idx_character_equipment_name` / `_features_name` / `_spells_name` on `(character_id, lower(btrim(...)))`), the `idx_character_skills_character` FK index, the `character_conditions` table (closed 5e enum + exhaustion-level coupling CHECK + `UNIQUE (character_id, condition)`), and the `ledger_events` journal table (`UNIQUE (turn_id, tool_call_id, character_id)`). Defaults on the ALTER COLUMNs let existing dev rows survive (no backfill — no prod users).

- [ ] **Step 1: Write the migration** exactly as §3.1 specifies. Cross-check every CHECK and UNIQUE against the spec text — these are correctness-critical (the guard-predicate atomicity and the name-keyed mutation substrate both depend on them).
- [ ] **Step 2: Apply + verify** against the worktree DB AND `mythrun_test`: `pnpm db:migrate` (worktree), then confirm the columns/tables/indexes exist (`\d characters`, `\d character_spell_slots`, `\d character_conditions`, `\d ledger_events`, `\di idx_character_*_name`). Run a fresh-DB apply if the suite has a migrations test (warm-vs-fresh, reference_warm_local_vs_fresh_ci_db).
- [ ] **Step 3:** Report DONE with the verified object list. **Flag if 024 is no longer the highest at draft time** (another worktree may have claimed 025) — do NOT silently renumber; check in.

---

### Task 2: SRD spell-slot tables — `backend/src/session/srd/spell-slots.ts` (§9.1)

**Files:**
- Create: `backend/src/session/srd/spell-slots.ts`
- Test: `backend/src/session/srd/__tests__/spell-slots.test.ts`

**IMPORTANT (spec ambiguity — see the §"Spec ambiguities" section):** §9.1 says "SRD data ports from the prototype's reference JSON." It does NOT. The prototype's `backend/src/data/srd/classes.json` carries only `{spellcasting: {ability, at_level}}` per class — NO slot-progression tables anywhere in the prototype. Author the full/half/third/pact/none progressions DIRECTLY from the public SRD 5e tables (this is reference data, not code — porting rules satisfied). Pin every row against the SRD in the test.

Pure lookup: `(progression: SpellcastingProgression, level: number) → readonly { slotLevel: number; max: number }[]`.
- `full` (wizard/cleric/druid/sorcerer/bard) — the standard PHB full-caster table, L1–20.
- `half` (paladin/ranger) — slots from character level 2.
- `third` (EK/AT) — slots from character level 3.
- `pact` (warlock) — N slots of a SINGLE pact-slot level (1 slot L1, then the warlock progression), all restoring on short rest; the resolver identifies pact rows by `spellcasting_progression = 'pact'`, not by slot level.
- `none` — empty array.

Levels outside 1–20 THROW (`spellSlotsFor` is called at character finalize + by `take_rest` restores + by the §3.2 coherence validation — an out-of-range level is a generation-time data error, not a runtime arm). Add a `maxSlotLevel(progression, level): number` helper (0 when no slots) the §3.2 coherence validation uses.

- [ ] **Step 1: Failing test** — assert slot maxima across `{full, half, third, pact} × {1, 2, 3, 5, 11, 17, 20}` pinned to the SRD; `none` → `[]`; level 0 and level 21 THROW; `maxSlotLevel` returns the right ceiling per progression/level.
- [ ] **Step 2: Run — FAIL** (`Cannot find module`).
- [ ] **Step 3: Implement** the lookup tables + `spellSlotsFor` + `maxSlotLevel`. Export `SPELLCASTING_PROGRESSIONS = ['full','half','third','pact','none'] as const` and `type SpellcastingProgression`.
- [ ] **Step 4: Run — PASS.** Report DONE.

---

### Task 3: prep schema + prompt co-evolution (§3.2)

**Files:**
- Modify: `backend/src/llm/schemas/character-sheet.ts` + extend `backend/src/llm/schemas/__tests__/character-sheet.test.ts`
- Modify: `backend/src/llm/prompts/prep/character-sheet.txt`

Schema additions (top-level `CharacterSheetOutputSchema`): `starting_gold: z.number().int().min(0).max(500)`, `hit_die: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)])`, `spellcasting_progression: z.enum(['full','half','third','pact','none'])`. `featureEntrySchema` gains `max_uses: z.number().int().min(1).max(20).nullable()` and `recharge: z.enum(['short_rest','long_rest','none'])`. `equipmentEntrySchema` gains `consumable: z.boolean()`. `spellEntrySchema` gains `ritual: z.boolean()`. (`prepared` already exists — its SEMANTICS change via the prompt, not the schema.) These are short-label / structured fields — `.max()` is fine; do NOT add `.max()` to any prose field.

Prompt (`character-sheet.txt`) updates IN LOCKSTEP (feedback_prompt_schema_co_evolution — the schema gained required fields, so the prompt's "Produce N fields" framing must list each new field as a first-class output):
- Add output requirements for `starting_gold` (class/background starting wealth), `hit_die` (the class hit die), `spellcasting_progression` (instruct: pick `full`/`half`/`third`/`pact`/`none` for THIS character's caster type — the model decides what KIND of caster it is, ZFC §3.2), feature `max_uses`/`recharge` (limited features carry both; unlimited → `max_uses: null, recharge: 'none'`), equipment `consumable` (potions/scrolls/rations true; durable gear false), spell `ritual`.
- **PIN `prepared` (SHOWSTOPPER 1):** add an explicit paragraph — `prepared` means "currently castable." Known/spontaneous casters (sorcerer, bard, warlock, ranger — any class that doesn't prepare) → ALL known leveled spells `prepared: true`; prepare-casters (cleric, druid, wizard, paladin) → a sensible daily prepared set `true`, rest `false`; cantrips always `prepared: true`.
- Add a steer AWAY from emitting slot-restoration features (Arcane Recovery, Font of Magic) as TRACKED features (no tool credits a slot — §14.13); the FT narrates around them.

- [ ] **Step 1: Failing schema test** — assert the schema accepts a full valid sheet incl. the new fields; rejects `starting_gold: -1` / `601`, a non-{6,8,10,12} `hit_die`, an unknown `spellcasting_progression`, a `max_uses: 0`, an unknown `recharge`; accepts `max_uses: null`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the schema additions + the prompt edits.
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE. (The prompt's behavioral correctness — does a sorcerer actually emit all-`prepared:true`? — is asserted by the T18 constructed-state smoke, not here; mocked tests can't catch prompt drift.)

---

### Task 4: `ft-config.ts` — the §11 shape bounds

**Files:**
- Modify: `backend/src/session/ft-config.ts` + extend `backend/src/session/__tests__/ft-config.test.ts` (create the test file if absent)

Add `export const MAX_GOLD_TRANSACTION = 100_000` (a fat-finger shape guard on a single gold credit/debit, NOT an economy rule — §11) and a short comment. Per-call hit-dice counts and `amount` floors are bounded in the TOOL input schemas (T10), not here; this is the one shared constant. (ADDITIVE block — no collision with MYT-69, which lives in `st-config.ts`.)

- [ ] **Step 1: Failing test** — `expect(MAX_GOLD_TRANSACTION).toBe(100_000)`.
- [ ] **Step 2: Implement.**
- [ ] **Step 3: Run — PASS.** Report DONE.

---

### Task 5: `ledger_update` server frame (§8)

**Files:**
- Modify: `backend/src/contract/session-events.ts` + extend `backend/src/contract/__tests__/session-events.test.ts`

Add `'ledger_update'` to `SERVER_FRAME_TYPES` (server→client only — NOT a client frame) and a `ServerFrame` member. Follow the `skill_check`/`dice_roll` precedent: live-streamed during a turn (NO seq) AND replayed from `session_messages` rows on reconnect (then carrying the row's `seq?: number`). Payload (§8): `{ type: 'ledger_update'; turnId: string; seq?: number; characterName: string; kind: 'hp'|'gold'|'item'|'feature'|'spell_slot'|'condition'|'rest'; summary: string }` PLUS the post-mutation values the resolver returns (model the concrete value fields — e.g. `hp?`, `maxHp?`, `gold?`, `slotLevel?`, `slotsRemaining?`, `itemName?`, `quantity?`, `featureName?`, `usesRemaining?`, `condition?`, `diceRolled?` — pin the exact union member field set against what the T8/T9 `LedgerUpdatePayload` carries; keep it ONE flat member, optional concrete fields). Build it field-by-field in the publisher (T15) so the wire shape is compile-checked. Update the module header comment listing the newly-present frame. Do NOT touch `CLIENT_FRAME_TYPES` or `classifyClientFrame`.

- [ ] **Step 1: Failing test** — extend the contract test asserting `'ledger_update'` ∈ `SERVER_FRAME_TYPES`, ∉ `CLIENT_FRAME_TYPES`, and `classifyClientFrame('ledger_update') === false`.
- [ ] **Step 2: Implement** the allowlist entry + the `ServerFrame` member.
- [ ] **Step 3: Run — PASS** + typecheck. Report DONE.

**Implementer note:** the `LedgerUpdatePayload` (T11, in `tiers/types.ts`) and this wire frame are a coupled pair — pin the field set ONCE here and reuse it; the publisher (T15) maps payload → frame field-by-field. If the frame and payload drift, typecheck catches it at the publisher.

---

### Task 6: `repo/characters.ts` — the `LedgerOps` namespace (§4, §5a, §10)

**Files:**
- Modify: `backend/src/repo/characters.ts` (extend `ReplaceSubTablesInput`; add the ledger methods)
- Extend: `backend/src/repo/__tests__/characters.test.ts` (real PG, scoped fixtures per `CONVENTIONS.md`)

This is the atomic-mutation substrate. Extend `ReplaceSubTablesInput` so the prep stage (T7) can write the new fields: add `startingGold`, `hitDie`, `spellcastingProgression`, and per-`features` `maxUses`/`recharge`, per-`equipment` `consumable`, per-`spells` `ritual`. Extend `replaceSubTables`' INSERT columns + the UPDATE for the new `characters` columns; **`character_spell_slots` JOINS the DELETE+re-INSERT set** (§3.2 — a retried stage must converge, not terminal-fail on the slot unique index), as do the new `character_conditions` rows if any (prep inits none, but the delete-set must be clean). The caller (T7) passes the derived slot rows in.

Add a scoped `LedgerOps` interface + methods on `charactersNs` (the Rules Lawyer receives `LedgerOps`, NOT the whole repo — same boundary as `MechanicalReads`). Pin the interface in this file and export it; the resolver imports it. Methods (every debit is a single guard-predicate `UPDATE … RETURNING`; the credit upsert a single `ON CONFLICT`; multi-row ops a single transaction via the bound `c`/`tx` client):

- `findLedgerCharacterByName(sessionId, name)` — reuse `findSessionParticipantCharacterByName` semantics (`found | not_found | ambiguous`), returning the character + its current ledger projection (HP, gold, hit dice, con mod source, progression). (May delegate to the existing method + a projection read, or a new query — implementer's call; keep the outcome shape identical.)
- `debitGold(characterId, amount)` → `UPDATE characters SET gold = gold - $2 WHERE id = $1 AND gold >= $2 RETURNING gold`; rowcount 0 = insufficient (return the current balance via a follow-up read in the SAME tx OR a `RETURNING` on a guard-failed path — implementer: a zero-row update returns no row, so read the balance for the binding constraint; keep it one tx).
- `creditGold(characterId, amount)` → `UPDATE … SET gold = gold + $2 … RETURNING gold` (shape-bounded by `MAX_GOLD_TRANSACTION` at the resolver).
- `debitItem(characterId, normalizedName, amount)` → guard-predicate `UPDATE character_equipment SET quantity = quantity - $3 WHERE character_id = $1 AND lower(btrim(item_name)) = $2 AND quantity >= $3 RETURNING quantity` (row RETAINED at 0 — §5). No matching row → distinguishable (rowcount 0 but row absent vs row present-but-insufficient — the resolver needs both; return a discriminated result or expose a tiny existence read).
- `acquireItem(characterId, name, amount, consumable)` → `INSERT … ON CONFLICT (character_id, lower(btrim(item_name))) DO UPDATE SET quantity = character_equipment.quantity + EXCLUDED.quantity RETURNING quantity` (the §3.1 functional index is the conflict target).
- `debitFeatureUse(characterId, normalizedName)` → guard `UPDATE character_features SET uses_remaining = uses_remaining - 1 WHERE … AND uses_remaining >= 1 RETURNING uses_remaining, recharge`; untracked (`max_uses IS NULL`) → a no-counter success (the resolver branches on the existence read).
- `debitSpellSlot(characterId, slotLevel)` → guard `UPDATE character_spell_slots SET slots_remaining = slots_remaining - 1 WHERE character_id = $1 AND slot_level = $2 AND slots_remaining >= 1 RETURNING slots_remaining`.
- `readSpellSlots(characterId)` → all slot rows (the resolver does the lowest-available-≥-level selection in pure math; the DB just returns the rows).
- `writeHp(client, characterId, newHp)` — clamps to `[0, max_hit_points]` and ENFORCES THE §5a HP↔unconscious INVARIANT AT THE HP WRITE: HP→0 applies `unconscious`; HP 0→positive clears `unconscious`. This is the ONE owner; `adjust_hp`, short-rest hit-dice healing, and long-rest HP→max all route through it. Multi-statement → one transaction.
- `applyCondition` / `clearCondition` — upsert/delete on `character_conditions`; exhaustion carries `level`; idempotent.
- `shortRest(client, sessionId, hitDiceRequests)` / `longRest(client, sessionId)` — party-wide single transaction (all session participants); see §5 for the exact arithmetic (hit-dice clamp + per-die floor 0 + pact restore + short_rest features for short; HP→max + hit-dice regain + all slots + features + exhaustion−1/delete-at-1 for long). The dice rolls happen in the RESOLVER (T9) and the rolled totals are passed in, OR the repo method takes an injected roller — pin: the **resolver rolls** (Principle #4 lives in the dice engine; the repo does pure writes), so `shortRest` takes the already-rolled per-character heal totals + dice-spent counts.
- `writeLedgerEvent(client, {characterId, sessionId, turnId, toolCallId, tool, delta})` → `INSERT … ON CONFLICT (turn_id, tool_call_id, character_id) DO NOTHING RETURNING id` — written in the SAME transaction as every applied mutation; a conflict (NULL RETURNING) means this exact call already applied (BullMQ redelivery) → the resolver returns the journaled payload as idempotent success.
- `readPartyLedgerSnapshot(sessionId)` (§7) → per session-participant character: HP, hit dice, gold, slot rows, conditions, tracked-feature names+uses, the spell list (name, level, prepared, ritual), the full equipment list (name, quantity, consumable). Deterministic order (joined_at, id — match `listSessionParticipantCharacters`). FK-indexed reads (the 025 indexes). Shape it as a typed `PartyLedgerSnapshot` the FT renderer (T11) formats.

- [ ] **Step 1: Failing tests** (real PG, scoped fixtures) — seed a character via `replaceSubTables` with the new fields + slot rows; assert each debit's guard-predicate (sufficient → rowcount 1 + decrement; insufficient → rowcount 0, value unchanged), the credit upsert (new row + merge-into-existing), `writeHp` clamp + both §5a transitions, condition upsert/delete idempotency, `writeLedgerEvent` conflict → no second row, `readPartyLedgerSnapshot` shape + order, `replaceSubTables` slot-set convergence on re-run.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Keep each method small; if `replaceSubTables` exceeds the line budget, the existing `eslint-disable max-lines-per-function` precedent applies (coupled SQL). Use the bound `c` for single-statement methods and accept an explicit `client`/`tx` for the multi-statement ones (mirror `create`'s `tx`-first precedent) so the resolver runs them inside one `repo.transaction`.
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

**Implementer note:** the §3.1 unique name indexes guarantee at most one row per debit — but defensively, a debit `UPDATE` with rowcount > 1 is an invariant violation; the RESOLVER (T8/T9) logs + fail-softs on it, the repo just returns the rowcount. Do NOT add a SELECT-then-UPDATE to "check first."

---

### Task 7: prep stage processor — dedupe-merge, coherence validation, ledger init (§3.2)

**Files:**
- Modify: `backend/src/llm/prep/stages/character-sheet.ts`
- Extend: `backend/src/llm/prep/stages/__tests__/character-sheet.test.ts`

The processor between the Sonnet output and the `replaceSubTables` write gains three responsibilities (all ZFC-clean — mechanical aggregation + structural validation):

1. **Dedupe-merge** name-collisions (POST-normalization, `lower(btrim(name))`) within each array BEFORE the write — SUM quantities for equipment, KEEP-FIRST for features/spells. Required by the §3.1 unique indexes (LLM duplicates would terminal-fail the insert otherwise).
2. **Coherence validation** (structural — squarely inside the ZFC exceptions): every leveled spell's level ≤ `maxSlotLevel(progression, level)` (T2); leveled spells present ⟹ `progression ≠ 'none'` (cantrip-only lists with `'none'` stay legal). Violation → throw into the stage's existing repair/retry path (`generateObject`'s `maxRetries`), NOT a silent write. (Pin: a thrown coherence error inside the stage triggers a regenerate; confirm the stage's retry semantics — if `generateObject` only repairs JSON, a coherence throw must re-run the stage, so throw a typed error the stage catches + retries, or fold the check into a `maxRetries` re-prompt. Implementer: read the stage's current error path; the cleanest is a typed `CharacterSheetCoherenceError` the stage loops on up to N times, then terminal-fails LOUD.)
3. **Ledger init in the SAME transaction as the sheet write:** gold ← `starting_gold`; `hit_dice_remaining` ← level; `hit_die` ← the emitted die; `spellcasting_progression` ← emitted; spell-slot rows derived from `spellSlotsFor(progression, level)` (T2), written FULL (max = remaining). Pass these through the extended `ReplaceSubTablesInput` (T6) so `character_spell_slots` joins the binder's delete+re-insert set. Map the new feature `max_uses`/`recharge`, equipment `consumable`, spell `ritual` fields through too.

Also address the **legacy `characters.create` path** (`repo/characters.ts:62`, POST /characters — does NOT init slots): the plan verifies it is DEAD for play (everything routes through the concept→sheet pipeline) OR ledger-inits it too. **Pin: verify it's dead for play** — grep the routes; if POST /characters never produces a playable session character, leave `create` untouched + note it in the self-review; if it CAN, add ledger init. (Likely dead — `replaceSubTables` is the pipeline write — but confirm, don't assume.)

- [ ] **Step 1: Failing tests** — dedupe-merge (two "Healing Potion"/"healing potion" equipment rows → one qty-summed; two same-name features → keep-first); coherence (a leveled spell above the max slot level → throws/retries; cantrip-only + `'none'` → passes); ledger-init (the `ReplaceSubTablesInput` carries `startingGold`, derived slot rows, the new sub-table fields). Mock the `'ai'` boundary for the LLM call; the dedupe/coherence/init are pure functions testable without it.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Keep `renderPrompt` updated for any new `{{vars}}` the T3 prompt added (none required by §3.2 — the new fields are OUTPUT, the inputs are unchanged; confirm).
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

**Implementer note:** the coherence validation needs CON modifier for nothing here (that's `take_rest`'s job at runtime); it only needs `(progression, level, spell levels)`. Keep the pure helpers exported for the unit tests.

---

### Task 8: `rules-lawyer.ts` — cast / spend / acquire resolvers (§4, §5, §6)

**Files:**
- Create: `backend/src/session/rules-lawyer.ts`
- Test: `backend/src/session/__tests__/rules-lawyer.test.ts`

Pure functions, one exported resolver per tool, mirroring `skill-check.ts`'s contract. Define the result type FIRST (it's the §4 contract):

```ts
export type LedgerResolution =
  | { readonly ok: true; readonly payload: LedgerUpdatePayload }
  | { readonly ok: false; readonly binding: boolean; readonly found: boolean; readonly constraint: string }
```

`LedgerUpdatePayload` is defined in `tiers/types.ts` (T11) — for Wave C ordering, T8 may define a LOCAL pinned shape and T11 re-homes it / re-exports; pin: **`LedgerUpdatePayload` lives in `tiers/types.ts`**, T8 imports it (build against the pinned shape; typecheck is the authority once T11 lands). It carries `{ characterName, kind, summary, …concrete post-mutation values }` matching the T5 frame.

Scoped deps: `interface RulesLawyerDeps { readonly ledger: LedgerOps; readonly sessionId: string; readonly rng?: Rng; readonly logger?: {...} }` (NO whole-repo; same boundary as `SkillCheckDeps.mech`). Character resolution via `ledger.findLedgerCharacterByName` (`found | not_found | ambiguous`); `not_found`/`ambiguous` → the same informational constraint shape the skill-check resolver uses. Name normalization: trim + case-fold both sides; a multi-row match is an invariant violation (log + fail-soft `UNRESOLVED`). Wrap every infra-failure path in try/catch → the generic fail-soft constraint (skill-check precedent).

This task implements `resolveCastSpell`, `resolveSpendResource`, `resolveAcquireResource` per the §5 table:
- **`cast_spell`** — validation ORDER (§10): character → spell known → castable (`prepared`) → slot. Slot selection: explicit `slot_level` = exact row (deliberate upcast); omitted → the LOWEST available slot level ≥ the spell's level (pure math over `readSpellSlots`); cantrip (level 0) → no slot. Binding ONLY when no slot ≥ spell level remains. `ritual:true` + spell's `ritual` flag → no slot debit; `ritual:true` on a non-ritual → informational correction; `slot_level` on a cantrip → ignored, noted in payload. Known-but-unprepared → BINDING, constraint names the currently-castable spells. Unknown spell → informational miss (always branch 3). Writes the `ledger_events` journal row in the same tx as the slot debit.
- **`spend_resource`** (discriminated on `kind`) — `gold`: `debitGold` (insufficient → binding with actual balance); `item`: `debitItem` default amount 1, row retained at 0 (binding "you're out of X" when present-but-0; informational miss when no row); `feature`: `debitFeatureUse` (exhausted → binding naming the recharge type; untracked → success no counter). Journal row per applied mutation.
- **`acquire_resource`** (discriminated on `kind`) — credit side, NO game-rule validation: `gold` increments (shape-bounded by `MAX_GOLD_TRANSACTION`); `item` → `acquireItem` upsert. Journal row.

- [ ] **Step 1: Failing tests** (real PG via the scoped fixture + a seeded character; OR a `LedgerOps` fake — pin: REAL PG, since the guard predicates are the behavior under test and a fake re-implements them, defeating the test; CONVENTIONS.md scoped fixtures). Cover every §13 arm for these three tools: insufficient gold (binding + balance), item-at-0 (binding) vs unknown item (informational miss), feature exhausted (binding) vs untracked (success), gold/item credit, no-castable-slot (binding empty-set), known-but-unprepared (binding + names castable set), lowest-available-≥-level selection, explicit upcast, pact-level cast, cantrip + spurious slot_level, ritual no-debit, ritual flag mismatch, unknown spell (branch-3 informational), not_found/ambiguous character, journal idempotent-replay (same toolCallId twice → one row, second returns journaled payload), multi-row-match invariant fail-soft.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the three resolvers + the shared `findCharacter` / fail-soft / normalization helpers. Each resolver runs its mutation + journal write inside ONE `repo.transaction` (the resolver receives `LedgerOps` bound to a tx client, OR opens the tx — pin: the resolver opens the transaction via an injected tx-runner so the mutation + journal are atomic; mirror how T6's multi-statement methods take a client). Keep the module < 400 lines — if cast+spend+acquire+hp+condition+rest exceeds it (T9 adds three more), SPLIT into `rules-lawyer.ts` (the contract types + shared helpers + re-exports) + `rules-lawyer-resources.ts` (cast/spend/acquire) + `rules-lawyer-vitals.ts` (hp/condition/rest). **Pin: if the combined file would exceed ~350 lines, split NOW in T8** so T9 lands cleanly; the file map's "same file" assumption yields to the 400-line lint gate. Decide at T8 implementation time and note it for T9.
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE with whether you split the module (T9 needs to know).

---

### Task 9: `rules-lawyer.ts` — adjust_hp / update_condition / take_rest resolvers (§5, §5a, §9.2)

**Files:**
- Modify: `backend/src/session/rules-lawyer.ts` (or `rules-lawyer-vitals.ts` if T8 split) + extend the test

Sequenced AFTER T8 (same module, or the split sibling T8 created). Implements:
- **`adjust_hp`** — exactly one of `amount` (fixed) or `dice` (e.g. `"2d4+2"`, ROLLED by the dice engine INSIDE the resolver — parse the expression to (count, sides, modifier), call `rollDice`, sum). Clamp to `[0, max_hit_points]` via `writeHp` (which owns the §5a invariant). Hitting 0 auto-applies `unconscious` (in `writeHp`'s tx); payload says so (FT narrates collapse, not death). Journal row.
- **`update_condition`** — `apply`/`clear` on the 5e enum; `level` required iff exhaustion. Apply-when-present updates level (exhaustion) / no-ops idempotently; clear-when-absent no-ops. **Clearing `unconscious` while HP is 0 → binding** ("unconscious is HP-derived; heal them first"). Idempotent no-ops return a result the FT/consume-loop maps to NO frame (§8) — distinguish "changed" vs "no-op" in the payload/result.
- **`take_rest`** — party-wide (all session participants), single transaction. Short: spend hit dice clamped to `hit_dice_remaining` (`min(count, remaining)`), each die heals `max(0, roll(hit_die) + CON mod)` via the dice engine, pact slots restore, `short_rest` features restore; an unknown/ambiguous `character_name` in `hit_dice` rejects the WHOLE call (informational, no partial state). Long: HP→max, hit dice regain `max(1, ⌊level/2⌋)` up to level, all slots restore, short+long features restore, exhaustion −1 (DELETE the row at level 1 — the CHECK forbids 0); other conditions NOT auto-cleared. Payload itemizes per-character (the consume loop emits one `ledger_update` per character — §8). All dice ROLLED in the resolver; `shortRest`/`longRest` repo methods (T6) do pure writes with the rolled totals passed in. Journal row per affected character.

A parse error on the `dice` expression → fail-soft `UNRESOLVED` (infra-class, not a game rule). The dice engine rejects non-standard dice — wrap and fail-soft.

- [ ] **Step 1: Failing tests** — `adjust_hp` damage/heal with `amount` and with `dice` (deterministic via injected `rng`), clamp at both ends, auto-unconscious at 0 + clear on heal-from-0 via ALL THREE HP-raising paths (`adjust_hp` heal, short-rest hit-dice, long-rest HP→max — §13 requires all three); `update_condition` apply/clear idempotency, exhaustion level, clear-unconscious-at-0 binding; short rest (hit-dice clamp, per-die floor 0 on a CON−2 char, pact restore, short_rest features, unknown name rejects whole call), long rest (full restore, hit-dice regain, exhaustion delete-at-1, slots+features restore, unconscious cleared at full HP), journal idempotent replay for each.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Add a small dice-expression parser (`/^(\d+)d(\d+)([+-]\d+)?$/`, validated against `STANDARD_DICE`; out-of-shape → fail-soft) — pure, ZFC-exempt (mechanical computation). Watch the 400-line gate.
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

---

### Task 10: register the six tools in `ft-tools.ts` (§5)

**Files:**
- Modify: `backend/src/session/tiers/ft-tools.ts`
- Extend: `backend/src/session/tiers/__tests__/ft-tools.test.ts`

Add six entries to the `ToolSet` returned by `buildFtTools`, following the EXACT `tool({description, inputSchema, execute})` shape + pure-resolver rules. `buildFtTools` gains the Rules Lawyer's scoped deps alongside the existing skill-check deps — pin the new signature: `buildFtTools(deps: Omit<SkillCheckDeps, 'abortSignal'> & { ledger: LedgerOps; rulesLawyerSessionId: string /* or reuse deps.sessionId */ }, rng?)`. (Reuse `deps.sessionId` — the resolver's `sessionId` is the same as the skill-check one; just add `ledger: LedgerOps` to the deps object.) Each tool's `execute` calls the matching T8/T9 resolver and returns the result as DATA (the `{ ok, payload }` / `{ ok:false, binding, found, constraint }` shape) — NEVER emits a frame. Map `ok:false` to a `{ constraint }`-bearing tool output the model narrates (parallel to skill-check's `{ error }`). Descriptions are load-bearing (the invariant sentence on debit tools; `spend_resource`'s improvised-object scoping). Inputs:
- `cast_spell`: `z.object({ character_name, spell_name, slot_level: z.number().int().min(1).max(9).optional(), ritual: z.boolean().optional() })`.
- `spend_resource`: `z.discriminatedUnion('kind', [ gold{amount}, item{name, amount?}, feature{name} ])`, all `character_name`; `amount` = `z.number().int().min(1).max(MAX_GOLD_TRANSACTION)` for gold, sane max for item.
- `acquire_resource`: `z.discriminatedUnion('kind', [ gold{amount}, item{name, amount?, consumable?} ])`.
- `adjust_hp`: `z.object({ character_name, kind: z.enum(['damage','heal']), amount: z.number().int().min(1).optional(), dice: z.string().optional() })` (the exactly-one-of is enforced in the resolver, not the schema — discriminated unions can't express XOR cleanly; or use a discriminated union on a fixed-vs-dice kind — implementer's call, typecheck the authority).
- `update_condition`: `z.object({ character_name, condition: z.enum([<5e list>]), action: z.enum(['apply','clear']), level: z.number().int().min(1).max(6).optional() })`.
- `take_rest`: `z.object({ type: z.enum(['short','long']), hit_dice: z.array(z.object({ character_name, count: z.number().int().min(1).max(20) })).optional() })`.

- [ ] **Step 1: Failing tests** (mock the `'ai'` boundary; the resolvers are real or faked-LedgerOps — pin: use a fake `LedgerOps` here since this task tests REGISTRATION + delegation + input-schema shape, not the guard predicates (those are T6/T8/T9's real-PG tests)). Assert: each tool registers with the right `inputSchema` discriminator; `execute` delegates to the resolver with the mapped input; an `ok:false` resolver result surfaces as a `{ constraint }` tool output (no throw); dice-expression `adjust_hp` delegates (the resolver rolls). Keep the existing `roll_dice`/`roll_skill_check` tests green.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Construct the Rules Lawyer deps inside `execute` from the closed-over `deps.ledger` + `deps.sessionId` + the SDK-threaded `abortSignal` (forward it like skill-check does, if the resolver supports cancellation; if not, omit).
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

**Implementer note:** `buildFtTools` is constructed in `turn-worker.ts`'s `makeTiers` (the `/* c8 ignore */` real-FT block) — adding `ledger` to its deps means the worker must build a `LedgerOps` from `repo.characters` there (T12 territory; coordinate the deps shape). Pin the deps shape here; T12 wires the construction.

---

### Task 11: `FtTurnContext.partyLedger` + the snapshot render tail (§7)

**Files:**
- Modify: `backend/src/session/tiers/types.ts` (add `partyLedger?: PartyLedgerSnapshot`, `LedgerUpdatePayload`)
- Modify: `backend/src/session/tiers/fast-thinker.ts` (render the snapshot tail in `buildModelMessages`)
- Extend: `backend/src/session/tiers/__tests__/fast-thinker.test.ts`

Add to `tiers/types.ts` (ADDITIVE — do NOT touch MYT-69's `StEvaluation` retirement / `standingDirective` if already merged): `LedgerUpdatePayload` (the §4/§8 shape — `{ characterName; kind: 'hp'|'gold'|'item'|'feature'|'spell_slot'|'condition'|'rest'; summary: string; …optional concrete values }`); `PartyLedgerSnapshot` (the typed per-character block from T6's `readPartyLedgerSnapshot`); and `FtTurnContext.partyLedger?: PartyLedgerSnapshot`. `partyLedger` is **public-by-construction** (a player's own mechanical sheet — no enforced-ignorance interaction; §7) — document it as such, exactly like the existing public fields.

In `fast-thinker.ts` `buildModelMessages`: after the breakpoint placement and BEFORE the return, if `ctx.partyLedger` is set, format it into a single render-time user ModelMessage (`[Party ledger: …]` — the numbers AND nouns per §7: HP, hit dice, gold, slot ledger `L1 2/3` style, conditions, tracked features + uses, spells grouped by level with castable/ritual flags, full equipment with consumable flags) and append it AFTER the last breakpoint (rides the always-uncached zone). NEVER persisted, NEVER pushed into `ftHistory`. Add a pure `formatPartyLedger(snapshot): string` helper (exported for the test).

**MERGE-ORDER PIN (worktree collision with MYT-69):** MYT-69 appends a `standingDirective` tail in this same region. On the merged HEAD both append. Pin the order: **party-ledger snapshot FIRST, then the standing-directive tail LAST** (the standing directive is the most recent "DM instruction" and should be closest to the generation point). T11 appends the ledger; the merge places the MYT-69 standing-tail append AFTER it. Note this in the commit + re-verify on merge.

- [ ] **Step 1: Failing tests** (extend the suite): `buildModelMessages` with `partyLedger` set → the LAST message is the formatted `[Party ledger: …]` user message carrying NO `providerOptions` (uncached tail); the breakpoint is STILL on the second-to-last HISTORY message (the ledger tail does NOT shift the breakpoint index); no `partyLedger` → unchanged shape; the formatted block contains a spell name + an equipment name + a slot string (the nouns showstopper-fix assertion); a render with `partyLedger` set → the block is in the `streamText` messages and NOT in the returned `AssistantMessage.parts`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

---

### Task 12: `turn-worker.ts` — load the party-ledger snapshot per turn (§7)

**Files:**
- Modify: `backend/src/session/turn-worker.ts`
- Extend: `backend/src/session/__tests__/turn-worker.test.ts`

On the fresh-run arm, alongside the existing `listSessionParticipantCharacters` roster load, load the party-ledger snapshot: `const partyLedger = await deps.repo.characters.readPartyLedgerSnapshot(sessionId)` and thread it into the controller's `FtTurnContext` (the controller's `buildContext` carries it through — conditional-spread for `exactOptionalPropertyTypes`). Extend `TurnWorkerRepo.characters` with `readPartyLedgerSnapshot`. Also wire the `LedgerOps` the FT tools need: extend `makeTiers`'s deps so `buildFtTools` receives `ledger` built from `repo.characters` (a scoped `LedgerOps` projection — same pattern as the `mech` projection in the `/* c8 ignore */` block). ADDITIVE edits only (worktree collision — MYT-69 adds the st-eval enqueue + one-shot take to distinct lines).

The controller (`session-controller.ts`) `buildContext` adds `partyLedger` to the `FtTurnContext` it builds — a small additive edit. If MYT-69 has reshaped the controller deps on main, leave that; only add the `partyLedger` pass-through.

- [ ] **Step 1: Failing tests** (extend, in-memory deps): a fresh run calls `readPartyLedgerSnapshot(sessionId)` and the controller is constructed with `partyLedger` set (assert via the controller-deps/tiers capture seam); the converge / latch-terminal / contention paths do NOT load the snapshot (it's a fresh-run-only read — though loading it harmlessly is acceptable; pin: load it only on the fresh-run arm, matching the roster load placement).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** Add `readPartyLedgerSnapshot` to the `TurnWorkerRepo` interface + the `LedgerOps` construction in `makeTiers`. The `/* c8 ignore */` real-FT block extends to build `ledger`.
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

**Implementer note:** the `session-controller.ts` `buildContext` + `FtTurnContext` pass-through is a tiny edit owned here (T12) to keep the worktree-collision surface minimal; if MYT-69 already touched `buildContext` on main, this is an additive field add.

---

### Task 13: codec + `listFtContextRows` — six per-tool message types (§8)

**Files:**
- Modify: `backend/src/session/transcript-codec.ts` + extend `backend/src/session/__tests__/transcript-codec.test.ts`
- Modify: `backend/src/repo/session-messages.ts` + extend its test

The codec's `KIND_TO_TOOL`/`TOOL_TO_KIND` maps are a strict 1:1 bijection; an unknown tool name throws `TranscriptCorruptError`. Add SIX new message types — one per tool — to `DM_MESSAGE_TYPES` and both maps: `cast_spell`, `spend_resource`, `acquire_resource`, `adjust_hp`, `update_condition`, `take_rest` (the kind === the tool name here — simplest bijection). They persist the standard `{toolCallId, input, output}` row JSON via the existing `assistantToRows` path — no codec structural change beyond the maps. **Rejection (`ok:false`) rows persist too** (§8 — the FT's rebuilt history needs the rejection for coherence; they're expected, not corruption). The codec round-trips them like any roll row.

**CRITICAL (spec §8 implies it, the file makes it explicit):** `session-messages.ts:70-71` `listFtContextRows` filters `message_type IN ('dm_text','skill_check','dice_roll')` — the FT-context rebuild query. **Add the six new types to that IN-list** or the rebuilt history won't include the ledger tool calls/results (the FT would lose its own mutation record mid-session — a coherence break). This is a real, easy-to-miss decomposition point.

- [ ] **Step 1: Failing tests**: codec — each of the six message types round-trips (`assistantToRows` → `rowsToConversation` reconstructs the tool_call + tool_result pair); an `ok:false` output row round-trips (persists + rebuilds); an unknown tool name still throws `TranscriptCorruptError`. session-messages — `listFtContextRows` returns rows of all six new types (seed rows of each `message_type`, assert they're in the result).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the map additions + the IN-list extension.
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

---

### Task 14: ws-session replay — `ledger_update` frames (§8)

**Files:**
- Modify: `backend/src/routes/ws-session.ts`
- Extend: the reconnect-replay test (`backend/src/routes/__tests__/ws-session.integration.test.ts` or `.test.ts` — whichever holds the `rowToReplayFrame` tests)

In `rowToReplayFrame`, add six `case` arms (one per new `messageType`) that reconstruct a `ledger_update` frame from the row's JSON `{toolCallId, input, output}` — but ONLY for `ok:true` outputs. **Replay rules (§8):** map `ok:true` rows → `ledger_update` frames (carrying the row's `seq`); **silently skip `ok:false` rows** (discriminate on the output's `ok` field — distinct from the corrupt-blob warn path: a rejection is EXPECTED, not corrupt, so NO warn log). `take_rest` persists one row but affects multiple characters — the output payload carries per-character entries; replay emits ONE `ledger_update` frame per affected character (per §8: players watch their own row). A malformed blob still drops + warns (the existing posture). Add a `parseLedgerUpdateRow` helper mirroring `parseSkillCheckRow`/`parseDiceRollRow` (narrow field validation, drop-graceful).

- [ ] **Step 1: Failing tests**: an `ok:true` `cast_spell` row → a `ledger_update` frame with `kind:'spell_slot'`, the right `characterName`, `seq`; an `ok:false` row → SILENTLY skipped (no frame, no warn — assert the log was NOT called for it); a `take_rest` row affecting two characters → two `ledger_update` frames; a corrupt blob → dropped + warned.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

---

### Task 15: emit seam — `TurnEmitter.emitLedgerUpdate`, consume-loop emission, publisher (§8)

**Files:**
- Modify: `backend/src/session/tiers/types.ts` (`TurnEmitter.emitLedgerUpdate`)
- Modify: `backend/src/session/tiers/fast-thinker.ts` (consume-loop emission for the six tools)
- Modify: `backend/src/session/turn-publisher.ts` (`ledgerUpdate` + `emitFor` wiring)
- Extend: the fast-thinker + publisher tests

Sequenced after T11 (both touch `fast-thinker.ts` + `types.ts`). Add `emitLedgerUpdate(payload: LedgerUpdatePayload): Promise<void>` to the `TurnEmitter` interface. In `fast-thinker.ts`'s `emitFrameForResult`, add: for the six ledger tool names, if the output is `ok:true`, emit `emitLedgerUpdate` from the resolver payload (in stream-part order, exactly the `skill_check`/`dice_roll` pattern); `ok:false` and idempotent no-ops emit NO frame (§8 — `take_rest` emits one frame per affected character: iterate the payload's per-character entries). The `'error' in out` fail-soft fast-path already returns early — extend the filter so `ok:false` ledger outputs also emit nothing. In `turn-publisher.ts`, add a `ledgerUpdate(campaignId, turnId, payload)` method (build the wire frame field-by-field from `LedgerUpdatePayload` per the T5 contract — compile-checked) and wire `emitLedgerUpdate` in `emitFor`. The latched emitter (`makeLatchedEmitter` in turn-worker.ts) needs an `emitLedgerUpdate` arm too — ADDITIVE.

- [ ] **Step 1: Failing tests**: fast-thinker — a `cast_spell` `ok:true` tool-result part → `emit.emitLedgerUpdate` called with the mapped payload, in stream-part order relative to text; an `ok:false` part → emitLedgerUpdate NOT called; a `take_rest` payload with two characters → emitLedgerUpdate called twice. publisher — `ledgerUpdate` publishes the right wire frame; `emitFor().emitLedgerUpdate` delegates. latched emitter — `emitLedgerUpdate` marks the latch before the inner publish (set-before-publish, like the other emit arms).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** across the three files + the `makeLatchedEmitter` arm in turn-worker.ts (small additive edit there — coordinate with T12 which also touches turn-worker; sequence T15 after T12, or have T15 own only the `makeLatchedEmitter` line).
- [ ] **Step 4: Run — PASS** + typecheck. Report DONE.

**Implementer note:** `makeLatchedEmitter` is in `turn-worker.ts` (T12's file). To avoid a within-issue collision, T15 owns the `emitLedgerUpdate` ADDITION to `makeLatchedEmitter` + `TurnEmitter`; T12 owns the snapshot-load lines. They touch different regions of turn-worker.ts — but sequence T15 after T12 to be safe (Wave C ordering already does this).

---

### Task 16: `ft-system.txt` — the §6 prompt guidance

**Files:**
- Modify: `backend/src/llm/prompts/session/ft-system.txt`
- Extend: `backend/src/llm/prompts/__tests__/ft-system.test.ts`

Append (ADDITIVE — distinct sections, no overwrite; worktree collision with MYT-69's standing-directive paragraph) the §6 prompt layer (first line of defense):
- **Tool scoping:** the debit tools (`spend_resource`, `cast_spell`, `adjust_hp`, `update_condition`, `take_rest`) are for TRACKED, SCARCE resources — "do NOT call `spend_resource` for improvised or environmental objects (a rock, a mug, a plank torn from a fence); narrate those freely; throwing one may still warrant `roll_dice`/`roll_skill_check`." If a player KEEPS an improvised object they care about, `acquire_resource` it; dropped scenery stays untracked.
- **The three-branch miss guidance** (environmental → narrate freely; transcript shows the fiction granted it → `acquire_resource` NOW then proceed; never-established ownership → correct gently; unknown SPELLS always correct-gently).
- **The sanctioned narrow gold-recovery rule** (§6): the FT MAY respond to a binding gold rejection by `acquire_resource` for a TRANSCRIPT-EVIDENCED grant only (citing its own prior narration — never to fund a purchase the fiction didn't).
- **Actor scoping:** mutate only the ACTING player's character's resources absent clear table consent.
- **Sub-gp posture:** narrate copper-scale purchases as negligible color; the ledger moves only at gp granularity.
- **Rest cadence:** no back-to-back long rests (narrative judgment, not a code rule).
- **§14.15 deferrals:** prepared-spell swapping on long rest, temp HP, and item charges are narrative-only in v1 — honest deferral when asked, not improvised mechanics.

- [ ] **Step 1: Failing test** — extend the ft-system var/content test to assert the new guidance phrases are present (the rock example, the gold-recovery sentence, the actor-scoping line). (The test asserts content presence, not LLM behavior — that's T18's smoke.)
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement** the prompt additions.
- [ ] **Step 4: Run — PASS.** Report DONE.

---

### Task 17 (controller): lint + scoped-coverage sweep — BUDGETED, not optional

Implementers run only their own test files; the debt (lint + the 100% coverage gate) is known (feedback_implementers_skip_lint_and_coverage).

- [ ] `pnpm --filter @mythrun/backend lint` — full list (no head-truncation); dispatch ONE lint-fix subagent for the batch (watch `no-non-null-assertion`, `no-deprecated`, `max-lines` 400, `max-lines-per-function` 100 — the rules-lawyer module split decision from T8 may need revisiting if a file crossed 400).
- [ ] Scoped coverage per new/modified source (feedback_scoped_coverage_for_iteration — NEVER full `test:coverage` during iteration): `pnpm vitest run <tests> --coverage --coverage.include='<source>'` for: `srd/spell-slots.ts`, `rules-lawyer*.ts`, `characters.ts` (the new ledger methods), `character-sheet.ts` schema + stage, `ft-tools.ts`, `fast-thinker.ts`, `turn-worker.ts`, `transcript-codec.ts`, `session-messages.ts`, `ws-session.ts`, `turn-publisher.ts`, `tiers/types.ts`, `ft-config.ts`, `session-events.ts`, the prompt test. Dispatch a coverage-fill subagent for genuine gaps (real tests > c8-ignore; c8-ignore only the v8 finally-boundary + real-LLM construction blocks).
- [ ] Full `pnpm typecheck && pnpm lint && pnpm test` green before T18 (in the worktree, against the worktree DB).

### Task 18 (controller): real-Anthropic E2E smoke → wiki → merge-to-main → single push → close

Wire-level, per spec §13 + feedback_dev_tool_e2e_smoke_required (curl / SSE / psql / redis-cli; NO browser automation). Smoke = plumbing (does the mutation land + the frame fire + the row persist), NOT eval (feedback_smoke_vs_eval). **Run in the worktree, against the worktree DB.** Smoke = plumbing; the §13 authenticity/quality observations (does the FT narrate the constraint well) are acceptable only as wiring smokes, not quality evals.

- [ ] **Fresh characters only (§3.1 smoke note):** seed a real campaign/session and drive FRESHLY GENERATED characters through the concept→sheet pipeline (migrated-but-not-regenerated dev rows carry `progression='none'`, `gold=0` — casting/purchase would trivially reject). Confirm the sheet stage wrote slot rows + gold + the new flags (psql `\d`-and-`SELECT` on `character_spell_slots`, `characters.gold`, `character_features.max_uses`).
- [ ] Start `pnpm dev` + the worker. Walk the §13 scenario over WS/SSE + psql + redis-cli, asserting `ledger_update` frames on the wire AND the PG rows (incl. `ledger_events` journal rows) after EACH step:
  - shop purchase (gold debits — `characters.gold` drops, `ledger_update kind:'gold'` frame);
  - **FT narrates a reward → assert the credit landed** (the highest-risk path: fiction-grants-it → `acquire_resource` → `character_equipment`/`gold` row appears);
  - `cast_spell` by PARAPHRASE against the snapshot (the FT emits the canonical name → slot decrements at the right level → `character_spell_slots.slots_remaining` drops);
  - over-spend (binding rejection narrated, NO state change — assert the row is unchanged);
  - rock-throw (NO spurious inventory rejection — the FT narrates freely, no `spend_resource` call);
  - potion drink (item consumed + dice-expression heal — `character_equipment.quantity` drops, `characters.hit_points` rises);
  - damage to 0 (`unconscious` applied — `character_conditions` row);
  - long rest (full restore + `unconscious` cleared — HP→max, slots restored, condition gone);
  - short rest (hit-dice clamp + pact restore).
- [ ] **Constructed-state smoke (feedback_constructed_state_smoke):** the prep-stage co-evolution — seed/drive a known-caster concept and assert (a) its spells come back all-`prepared:true` and (b) a limited feature carries `max_uses`/`recharge` (the natural smoke can't force both; the myth-tt2g lesson). This catches prompt drift the mocked T3/T7 tests can't.
- [ ] Fix what the smoke finds (it WILL find something — a prompt-var drift, a schema mismatch, a missing IN-list type, an un-emitted frame), re-run.
- [ ] Wiki subagent (AUTHORING.md prompt, parameterized MYT-70) → wiki committed locally in the worktree. **Sync the wiki LAST** (feedback_wiki_sync_comes_after_dev_tool_and_test_fixes) — after any pre-push flaky-test fixes (runtime/index.html watches all of backend/src/). `wiki:build/check` need `DATABASE_URL` sourced.
- [ ] Close all beads.
- [ ] **Merge to main** (CLAUDE.md worktree flow): from the MAIN repo path — `git checkout main && git pull` (catch MYT-69's commits), `git merge <myt-70-branch>`, resolve the additive collisions (fast-thinker.ts tail order, turn-worker.ts, ft-system.txt, types.ts, ft-config.ts — see the worktree section), **re-run full verification on the merged HEAD** (`pnpm typecheck && pnpm lint && pnpm test`). Then ONE `git push origin main` (the pre-push gate runs full coverage/lint/typecheck/test ~5+ min — batch all, push once: feedback_pushes_are_expensive). Do NOT push from the worktree.
- [ ] Flip MYT-70 → Done in Linear (feedback_push_and_close — standing auth). `bd worktree remove myt-70`.

---

## Self-review notes (run before handing to beads)

- **Spec coverage map:** §1 goal → T6+T8+T9+T10 (ledger + Rules Lawyer + tools); §2 PG-direct guard-predicate atomicity → T6 (every debit a single guarded UPDATE, credit ON CONFLICT, multi-row in one tx) + T8/T9 (resolvers open the tx); §3.1 migration → T1; §3.2 prep structure + prepared-pin + dedupe + coherence + ledger-init + slots-join-replaceSubTables → T3 (schema/prompt) + T7 (processor) + T6 (`ReplaceSubTablesInput`); §4 service contract (total, scoped `LedgerOps`, `found/binding/constraint`) → T8 (types + cast/spend/acquire) + T9 (hp/condition/rest); §5 tool table → T8/T9 (resolvers) + T10 (inputs/descriptions); §5a HP↔unconscious single owner → T6 (`writeHp`) exercised via all three paths in T9; §6 binding/informational + 3-branch + gold-recovery + actor/sub-gp scoping → T8 (result shape) + T16 (prompt); §7 snapshot nouns + cache placement + staleness → T6 (`readPartyLedgerSnapshot`) + T11 (render tail) + T12 (per-turn load); §8 frames + codec + replay + ok-filter → T5 (frame) + T13 (codec + IN-list) + T14 (replay) + T15 (emit seam); §9.1 SRD slots → T2, consumed by T7 (init + coherence) + T9 (rest restores); §9.2 rest rules → T9; §10 journal + idempotency + fail-soft + validation order → T6 (`writeLedgerEvent`) + T8/T9 (journal-in-tx, conflict-replay, validation order, fail-soft); §11 config → T4 + T10 (schema bounds); §12 file map → all; §13 testing → every TDD step + T18; §14 decisions + §15 review (both showstoppers + folded NITs) → §3.2 prepared-pin (T3/T7), §7 nouns (T6/T11), journal (T6), unique indexes + dedupe + ON CONFLICT (T1/T6/T7), slot-selection math (T8), §5a invariant (T6/T9), coherence (T7), cache-placement pin (T11), per-tool codec + ok-filter (T13/T14), ritual (T8/T10), 3-branch + gold-recovery (T16), dice-expression adjust_hp (T9), rest clamp/floor/delete-at-1 (T9), CHECKs + FK indexes (T1), discriminated-union inputs + floors (T10), replaceSubTables slot convergence (T6), fresh-character smoke note (T18).
- **Type-consistency chain:** `SpellcastingProgression` + `spellSlotsFor`/`maxSlotLevel` (T2) consumed by T7 (init + coherence) + T9 (rest); the extended `ReplaceSubTablesInput` (T6) consumed by T7; `LedgerOps` (T6) consumed by T8/T9 (resolvers) + T10/T12 (construction); `LedgerResolution`/`LedgerUpdatePayload` (T8 local → T11 homed in `tiers/types.ts`) consumed by T10 (tool execute) + T15 (emit) + T5 (wire frame, field-pinned) + T14 (replay reconstruction); `PartyLedgerSnapshot` (T6) → `FtTurnContext.partyLedger` (T11) → T12 (load) + T11 (render); `TurnEmitter.emitLedgerUpdate` (T15) consumed by fast-thinker + publisher + `makeLatchedEmitter`; the six codec message types (T13) consumed by T14 (replay) + `listFtContextRows` (T13).
- **Known judgment points for implementers (typecheck is the authority):** the `rules-lawyer` module split decision (T8 — split at >350 lines so the 400-gate holds after T9); the `adjust_hp` exactly-one-of `amount`/`dice` encoding (resolver-enforced vs discriminated-union); whether the resolver opens its own tx or receives a tx-bound `LedgerOps` (pin: resolver opens the tx so mutation+journal are atomic); the legacy `characters.create` dead-for-play verification (T7 — confirm, don't assume); the `LedgerUpdatePayload` ⟷ `ledger_update` frame field set (pinned once in T5, reused in T11/T15); the `buildFtTools` deps shape extension (T10 pins, T12 wires).
- **Wave non-overlap verified:** Wave A files {025.sql, srd/spell-slots.ts, character-sheet.ts (schema)+character-sheet.txt, ft-config.ts, session-events.ts} pairwise disjoint. Wave B {characters.ts (T6), character-sheet.ts (stage, T7)} disjoint (T7 imports T6's input TYPE only). Wave C is sequenced where files collide: rules-lawyer.ts T8→T9 (same file); fast-thinker.ts + types.ts T11→T15 (sequenced); turn-worker.ts T12 before T15's `makeLatchedEmitter` arm; ft-tools.ts (T10), transcript-codec.ts+session-messages.ts (T13), ws-session.ts (T14), ft-system.txt (T16) are mutually disjoint and parallel-safe once T8/T9 land. No two tasks in the SAME wave write the same file.
- **Worktree-collision verified:** the five MYT-69-overlapping files (fast-thinker.ts, turn-worker.ts, ft-system.txt, types.ts, ft-config.ts) take only ADDITIVE edits here; the merge-back re-runs full verification (T18). The one ordering decision is the fast-thinker.ts tail order (ledger snapshot then standing directive) — pinned in T11.

## Spec ambiguities / contradictions found while drafting (NOT silently resolved — listed per the dispatch instruction)

1. **SRD slot data does NOT exist in the prototype (§9.1).** §9.1 says "SRD data ports from the prototype's reference JSON per the Backend Core spec's porting rules." I grepped `/Users/miklos/Desktop/Files/Personal/mythrun-v5/` — `backend/src/data/srd/classes.json` carries only `{spellcasting: {ability, at_level}}` per class; there are NO slot-progression tables (full/half/third/pact) anywhere in the prototype. So nothing CAN be ported. I directed T2 to author the progressions DIRECTLY from the public SRD 5e tables (still reference data, not code, so the porting-rules SPIRIT holds — public SRD data, pinned in tests), and to flag this. **Flagging because** the spec's framing implies a port that isn't possible; if Miklos believes there's a slot table elsewhere in the prototype I missed, that changes T2. The pact progression in particular (single-pact-level slots that scale with warlock level) is the easiest to get wrong — the test pins it against the SRD.

2. **File paths in the §12 change map differ from the live tree.** §12 lists `contract/session-events.ts` and `src/server/ws-session.ts`. The live paths are `backend/src/contract/session-events.ts` and `backend/src/routes/ws-session.ts` (there is no `src/server/`). I used the live paths in the task table. Low-risk (the spec was written against a slightly stale mental model of the tree), but flagging so the reviewer isn't surprised by the path drift.

3. **`listFtContextRows` IN-list is a load-bearing edit §8 doesn't name.** §8 specifies the six new per-tool message types in the codec's kind↔tool maps, but does NOT mention that `session-messages.ts:70-71`'s `listFtContextRows` query filters `message_type IN ('dm_text','skill_check','dice_roll')` — the FT-context REBUILD read. If the six new types aren't added to that IN-list, the rebuilt FT history silently omits every ledger tool call/result (the FT loses its own mutation record mid-session — a coherence break invisible to the codec round-trip tests, which test the codec in isolation). I added it to T13 explicitly. **Flagging** because it's a real, easy-to-miss seam the spec's §8 ("no bijection change") could be read to imply nothing else changes — but the rebuild query is a separate surface from the codec.

4. **Where the resolver's transaction boundary sits (§4 / §10).** §4 says the service receives a `LedgerOps` projection; §10 says "every applied mutation inserts a journal row in the same transaction." For the mutation + journal to be atomic, SOMEONE must open the transaction — either the resolver (taking a tx-runner) or `LedgerOps` methods that each open+close their own tx (which would put the mutation and journal in SEPARATE txns — breaking the §10 same-transaction guarantee). I pinned: the resolver opens ONE `repo.transaction` per call and runs the mutation + journal through the tx-bound `LedgerOps`. **Flagging** because §4's "scoped projection" language could be read as "stateless per-method" — but §10's same-transaction journal requirement forces a per-call tx the resolver owns. If the reviewer prefers `LedgerOps` to own the tx internally (each method = mutation + journal in one method's tx), that's also valid and arguably cleaner — but it pushes the journal `delta`/`tool`/`turnId`/`toolCallId` args into every method signature. Either satisfies §10; I chose resolver-owned for a thinner repo surface. Worth a one-line confirmation.

5. **`adjust_hp` exactly-one-of (`amount` XOR `dice`) can't be cleanly expressed in the input schema (§5).** §5 says "exactly one of `amount` or `dice`." A `z.discriminatedUnion` needs a discriminator key; HP adjust has `kind: 'damage'|'heal'` already, orthogonal to amount-vs-dice. Expressing the XOR purely in Zod means a nested union (e.g. `kind × (fixed|dice)`) that complicates the JSON Schema the model sees. I pinned: the schema allows both `amount?` and `dice?` optional, and the RESOLVER enforces exactly-one (fail-soft on neither/both). **Flagging** because the spec's "the JSON Schema itself teaches the model per-kind required fields (no representable-but-invalid shapes)" goal (§5) is slightly weakened here — a both-present input is representable but invalid, caught at resolve time not schema time. The alternative (a 4-way discriminated union) honors §5's letter at the cost of a clunkier model-facing schema. Implementer/reviewer call; I leaned toward the simpler schema + resolver guard.
