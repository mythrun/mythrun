# MYT-70 — Rules Lawyer & Shared Live Character Ledger (Design)

> **Linear:** MYT-70 · **Milestone:** Session Runtime + Combat L1
> **Spec refs:** Multiplayer Session Runtime §17.2 (tool belt), §17.3 (Rules Lawyer), §17.7 (write-authority Class 1)
> **Builds on:** MYT-68 (FT tool registry extension point, skill-check resolver pattern, consume-loop frame emission, session lock)
> **Brainstormed:** 2026-06-10 with Miklos. All §14 decisions are his calls at the design gate.

## 1. Goal & posture

Enforce out-of-combat resource use deterministically. Players cast spells, spend gold, drink potions, take damage, and rest outside combat; today the FT narrates all of it and none of it lands in state. MYT-70 ships:

- the **shared live character ledger** — the single per-character mechanical-state record (HP, spell slots, gold, inventory, limited-feature uses, conditions, hit dice) that the Rules Lawyer (exploration) and, later, the combat engine (MYT-72+) both read/write;
- the **Rules Lawyer** — a deterministic, server-authoritative validate→mutate service. **Not an LLM tier.** ZFC: resource math is mechanical computation ("enough gold? subtract it" is subtraction, not judgment);
- **six FT tools** registered at the `ft-tools.ts` extension point, following the established pure-resolver rules.

The division of labor is §17.3's: **interpretation** (player intent → structured action, e.g. `{cast: fireball, slot: 3}`) is the FT's tool call — the FT already interprets all player intent. **Adjudication + mutation** (legality + state change) is the Rules Lawyer: validate against the ledger, mutate on success, or return a structured constraint the FT narrates around. In-turn synchronous — the next tool call may depend on the result (you cannot async-debit a slot and let the FT cast from it again).

**Done when (Linear):** casting a spell decrements the slot, an over-spend is rejected with a constraint the FT narrates, and state persists to the ledger.

## 2. The ledger is PG-direct

**Decision: the PG characters tables ARE the ledger.** No Redis copy, no checkpoint flush, no rebuild path.

§17.3's original text ("a new session-state component… persisted to Postgres on checkpoint/end") predates MYT-68's PG-direct shift and is **amended by this spec**. Three reasons:

1. **Posture consistency.** MYT-68 retired Redis-as-truth for the transcript (rebuild-or-crash). A Redis-live ledger would reintroduce exactly the dual-store class of bugs we just eliminated, on state that is *more* correctness-critical (real resources, not replayable prose).
2. **Resources outlive the session.** Slots persist until a long rest, gold and inventory persist indefinitely — the ledger is **character state, not session state**. PG-direct gives cross-session persistence for free; a session-scoped Redis ledger would need load/store choreography at every session boundary.
3. **Contention is a non-issue.** The session lock makes turns single-flight per session; a turn issues a handful of tool calls at most (hard cap 4–5, §17.2). One small PG transaction per mutation, serialized by construction.

Each mutation is **one atomic PG statement or transaction** with guard predicates in the `WHERE` clause (`remaining >= n`-style); a zero-rowcount update IS the rejection (no read-then-write race, even though the lock already serializes). Multi-row operations (rests) run in a single transaction.

## 3. Schema — migration 025 + prep co-evolution

### 3.1 Migration `025_character_ledger.sql`

```sql
-- Gold: integer gold pieces. Fractional coinage (sp/cp) is out of scope;
-- the FT narrates coin color, the ledger tracks gp.
ALTER TABLE characters ADD COLUMN gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0);

-- Hit dice pool (short-rest healing currency). Die size comes from prep (§3.2).
ALTER TABLE characters ADD COLUMN hit_die SMALLINT NOT NULL DEFAULT 8
  CHECK (hit_die IN (6, 8, 10, 12));
ALTER TABLE characters ADD COLUMN hit_dice_remaining SMALLINT NOT NULL DEFAULT 1
  CHECK (hit_dice_remaining >= 0);

-- Caster progression: structured by prep (§3.2), consumed by the SRD slot
-- derivation (§9.1). Free-text `class` is never string-matched (ZFC).
ALTER TABLE characters ADD COLUMN spellcasting_progression TEXT NOT NULL DEFAULT 'none'
  CHECK (spellcasting_progression IN ('full', 'half', 'third', 'pact', 'none'));

-- Spell slots: one row per (character, slot level) with a current/max pair.
CREATE TABLE character_spell_slots (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  slot_level SMALLINT NOT NULL CHECK (slot_level BETWEEN 1 AND 9),
  slots_max SMALLINT NOT NULL CHECK (slots_max >= 0),
  slots_remaining SMALLINT NOT NULL CHECK (slots_remaining >= 0),
  CHECK (slots_remaining <= slots_max),
  UNIQUE (character_id, slot_level)
);

-- Limited-feature uses. NULL max_uses = unlimited (no tracking).
ALTER TABLE character_features ADD COLUMN max_uses SMALLINT
  CHECK (max_uses IS NULL OR max_uses >= 1);
ALTER TABLE character_features ADD COLUMN uses_remaining SMALLINT
  CHECK (uses_remaining IS NULL OR uses_remaining >= 0);
ALTER TABLE character_features ADD COLUMN recharge TEXT NOT NULL DEFAULT 'none'
  CHECK (recharge IN ('short_rest', 'long_rest', 'none'));
-- Invariants: tracked features carry both counters; uses never exceed max.
ALTER TABLE character_features ADD CONSTRAINT character_features_uses_pair
  CHECK ((max_uses IS NULL) = (uses_remaining IS NULL));
ALTER TABLE character_features ADD CONSTRAINT character_features_uses_bound
  CHECK (uses_remaining IS NULL OR uses_remaining <= max_uses);

-- Consumable flag: structured by prep (§3.2), drives the §7 snapshot's
-- equipment selection. No keyword heuristics (decision §14.7).
ALTER TABLE character_equipment ADD COLUMN consumable BOOLEAN NOT NULL DEFAULT false;

-- Conditions: the closed 5e list. `level` only for exhaustion (1–6).
CREATE TABLE character_conditions (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  condition TEXT NOT NULL CHECK (condition IN (
    'blinded', 'charmed', 'deafened', 'exhaustion', 'frightened', 'grappled',
    'incapacitated', 'invisible', 'paralyzed', 'petrified', 'poisoned',
    'prone', 'restrained', 'stunned', 'unconscious'
  )),
  level SMALLINT CHECK (level BETWEEN 1 AND 6),
  CHECK ((condition = 'exhaustion') = (level IS NOT NULL)),
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (character_id, condition)
);
```

Defaults on the `ALTER TABLE` columns let existing dev rows survive the migration; they regenerate with real values on the next character-creation run (no production users — nothing to backfill).

### 3.2 Prep emits structure (the MYT-53/54 character-sheet stage)

`CharacterSheetOutputSchema` (`backend/src/llm/schemas/character-sheet.ts`) gains, with the prompt (`prompts/prep/character-sheet.txt`) updated **in lockstep** (prompt–schema co-evolution rule):

```ts
starting_gold: z.number().int().min(0).max(500),
hit_die: z.union([z.literal(6), z.literal(8), z.literal(10), z.literal(12)]),
spellcasting_progression: z.enum(['full', 'half', 'third', 'pact', 'none']),
```

`featureEntrySchema` gains:

```ts
max_uses: z.number().int().min(1).max(20).nullable(),   // null = unlimited
recharge: z.enum(['short_rest', 'long_rest', 'none']),
```

and `equipmentEntrySchema` gains:

```ts
consumable: z.boolean(),   // potions, scrolls, rations — drives the §7 snapshot
```

**Why prep, not code:** `class` is free text (`z.string().min(4).max(40)` — "Storm-Touched Sorcerer" is a legal value). String-matching it against SRD class names in code is the local-intelligence pattern ZFC forbids and breaks on every flavored name. The model decides *what kind of caster this character is* once, at generation time, as structured output; code then does pure math (§9.1). Same logic for feature uses: "Second Wind is 1/short-rest" is the model's call, made once, structured.

The character-sheet processor writes the new fields through the characters repo (extended `ReplaceSubTablesInput`), and **initializes the ledger**: gold ← `starting_gold`; hit dice pool ← level; spell-slot rows derived from `(spellcasting_progression, level)` via §9.1, written full. No runtime LLM call ever sits in the Rules Lawyer path.

## 4. The Rules Lawyer service

`backend/src/session/rules-lawyer.ts` — pure functions, one exported resolver per tool, mirroring the skill-check resolver's contract:

- **Total.** Every failure arm returns a structured constraint result; the service never throws on game-rule grounds. (An uncaught throw surfaces as a tool-error part the loop continues past — the model would narrate an outcome with no adjudication.) Infrastructure errors (PG down) follow the skill-check fail-soft precedent: a generic "could not be resolved — do not narrate a definite outcome" constraint, logged.
- **Scoped dependency.** The service receives a `LedgerOps` projection (a new scoped interface over the characters repo namespace), not the whole Repo — same boundary discipline as `MechanicalReads` in `skill-check.ts:42`.
- **Character resolution** reuses `findSessionParticipantCharacterByName` semantics (`found | not_found | ambiguous`); `not_found`/`ambiguous` return the same informational constraint shape the skill-check resolver uses.
- **Name normalization** for spells/items/features: trim + case-fold on both sides before matching (mechanical normalization, not semantic matching — "fire bolt" matches "Fire Bolt"; nothing fuzzier).

Result contract (per call):

```ts
type LedgerResolution =
  | { ok: true; payload: LedgerUpdatePayload }       // mutation applied
  | { ok: false; constraint: string;                  // adjudication outcome
      binding: boolean }                              // §6 semantics
```

`payload` carries the post-mutation values the FT needs to narrate concretely (new HP, slots remaining at that level, gold balance, uses left) — constraint-injection: the resolver owns the outcome, the FT owns the telling.

## 5. Tool surface

Six tools registered in `buildFtTools` (`backend/src/session/tiers/ft-tools.ts`) under the existing pure-resolver rules: `execute` returns data only, never emits frames; all player-visible emission happens in the FT consume loop in stream-part order.

| Tool | Input (Zod, sketch) | Resolver behavior |
|---|---|---|
| `cast_spell` | `{ character_name, spell_name, slot_level? (1–9) }` | Spell must be on `character_spells` and `prepared` (cantrips: level 0 → no slot, always castable if known). `slot_level` defaults to the spell's own level; upcasting = any higher level. Atomic decrement of that slot row; no slot remaining → binding constraint naming the levels that DO have slots. Unknown spell → informational miss (§6). |
| `spend_resource` | `{ character_name, kind: 'gold'\|'item'\|'feature', name?, amount? }` | `gold`: amount required, atomic `gold = gold − n WHERE gold >= n`; insufficient → binding constraint with actual balance. `item`: name + amount (default 1) decrements `character_equipment.quantity`; the row is RETAINED at 0, so a later spend of the same item is a binding "you're out of X" (with the snapshot showing 0), not an unknown-item miss. Covers consumption AND drop/give (any removal). Item with no row at all → informational miss (§6). `feature`: decrements `uses_remaining`; exhausted → binding constraint naming the recharge type; untracked feature (`max_uses` NULL) → success, no counter. |
| `acquire_resource` | `{ character_name, kind: 'gold'\|'item', name?, amount }` | The credit side. Gold increments; items upsert into `character_equipment` (increment quantity on name match, insert otherwise). No game-rule validation — the fiction granted it; shape validation only. |
| `adjust_hp` | `{ character_name, kind: 'damage'\|'heal', amount }` | Clamped to `[0, max_hit_points]`. Hitting 0 auto-applies `unconscious` and the payload says so explicitly — the FT narrates collapse, not death (death saves are combat-engine scope). Healing from 0 auto-clears `unconscious`. |
| `update_condition` | `{ character_name, condition: <5e enum>, action: 'apply'\|'clear', level? }` | Upsert/delete on `character_conditions`. `level` required iff exhaustion. Apply-when-present updates level (exhaustion) or no-ops idempotently; clear-when-absent no-ops idempotently. |
| `take_rest` | `{ type: 'short'\|'long', hit_dice?: [{ character_name, count }] }` | Party-wide (all session participants), single transaction. **Short:** spend hit dice per request — each rolls `d(hit_die) + CON mod` via the deterministic dice engine, sums into healing; pact slots restore; `short_rest` features restore. **Long:** HP → max; hit dice regain `max(1, ⌊level/2⌋)` up to level; all slots restore; `short_rest` + `long_rest` features restore; exhaustion −1 (cleared at 0). Other conditions are NOT auto-cleared — duration is narrative judgment, the FT clears via `update_condition`. |

The per-turn tool-iteration cap (4–5, §17.2) is unchanged; all six resolve in pure code + one PG round-trip, so the latency budget is unaffected.

## 6. Constraint semantics — binding vs informational

The design principle (Miklos's "rock" case: *"I pick up a rock and throw it at the goblin"* must never produce *"Sorry, you don't have a rock in your inventory"*):

**The Rules Lawyer is authoritative about ledger STATE, not about what absence MEANS.** Scarcity is what makes refusal binding.

- **Binding** (`binding: true`) — quantified debits on scarce, tracked state: insufficient gold, no slot of a castable level, feature uses exhausted, a tracked consumable at quantity 0. The constraint is the authoritative outcome; the FT narrates *how* the attempt falls short, never a success. (Identical posture to a failed skill check.)
- **Informational** (`binding: false`) — a ledger *miss*: an item/spell name with no row. The constraint reports `{ found: false, tracked: false }` plus guidance: *if this is a plausibly-at-hand environmental object, narrate freely (no ledger involvement); if the player is asserting ownership of something they'd believe they own, correct gently.* The FT judges — that's interpretation, its job under ZFC.

**Prompt layer (first line of defense):** the tool descriptions and `ft-system.txt` scope the debit tools to *tracked, scarce* resources — "do NOT call `spend_resource` for improvised or environmental objects (a rock, a mug, a plank torn from a fence); narrate those freely; throwing one may still warrant `roll_dice`/`roll_skill_check`." The common case never round-trips the ledger at all. If the player *keeps* an improvised object as something they care about, the FT may `acquire_resource` it into inventory; dropped scenery stays untracked.

## 7. FT visibility — the party ledger block

The turn worker loads a compact **party ledger snapshot** from PG each turn (it already derives the roster per-turn from `session_participants` — same load point) and threads it into `FtTurnContext`; `buildModelMessages` (`fast-thinker.ts:164`) renders it as a clearly-delimited block in the **dynamic context region** alongside the transcript, so static-payload prompt caching is untouched.

Contents per character: current/max HP, hit dice, gold, slot ledger (`L1 2/3 · L2 0/2` style), tracked-feature uses, active conditions, and `consumable`-flagged equipment (§3.1 — potions etc.; the long tail of mundane gear is elided to keep the block to a few hundred tokens for a party of 4–6). A player's own mechanical sheet is public-by-construction — no enforced-ignorance interaction; `FtTurnContext` stays public-only.

The FT narrates from current state by default (no offering a fireball to empty slots; shop scenes know the party's purse). Conditions inform the FT's existing advantage/disadvantage flags on `roll_skill_check` — no resolver change.

## 8. Player-visible frames

A new `ledger_update` server frame (`contract/session-events.ts`), emitted by the FT consume loop **in stream-part order** from tool-result parts — exactly the `skill_check` frame pattern. Payload: `{ character_name, kind: 'hp'|'gold'|'item'|'feature'|'spell_slot'|'condition'|'rest', summary }` plus the post-mutation values from the resolver payload. Persisted as a `session_messages` row (joins `DM_MESSAGE_TYPES`) so reconnect replay rebuilds resource history; the future character-sheet UI updates live off the same frame. Binding rejections do NOT emit a frame — nothing changed; the refusal lives in prose.

## 9. SRD derivation (deterministic code)

### 9.1 Slot tables — `backend/src/session/srd/spell-slots.ts`

Pure lookup: `(progression, level) → { slotLevel: max }[]`, SRD 5e tables for `full` (wizard-style 1–20), `half` (paladin/ranger, slots from L2), `third` (EK/AT, from L3), `pact` (warlock: N slots of a single pact level, all restoring on short rest — the `take_rest` short arm restores exactly the pact rows, identified by `spellcasting_progression = 'pact'`), `none` (no rows). Consumed once at character finalize (§3.2) and by `take_rest` restores. SRD data ports from the prototype's reference JSON per the Backend Core spec's porting rules.

### 9.2 Rest rules

Encoded in the Rules Lawyer per the §5 table — all arithmetic + dice-engine rolls; no model involvement.

## 10. Error handling & idempotency

- **Guard-predicate atomicity:** every debit is a single `UPDATE … WHERE <guard> RETURNING`; rowcount 0 = adjudicated rejection. No SELECT-then-UPDATE anywhere.
- **Totality:** infra failure inside a resolver → fail-soft constraint ("could not be resolved — do not narrate a definite outcome"), `logger.warn`, turn continues. Same posture as the skill-check resolver.
- **Retry safety:** a turn-worker retry after a mid-turn crash can replay tool calls (BullMQ redelivery). Accepted as-is for v1 — the same exposure already shipped for skill checks (a replayed roll re-rolls), the session lock + emitted-anything latch bound the window, and mutations are small. Recorded as a known limitation; a per-turn idempotency key on mutations is the designed escape hatch if the E2E smoke or play-testing shows double-debits.
- **Validation order** in `cast_spell`: character → spell known → prepared → slot — so the constraint names the *first* real problem, not a cascade.

## 11. Config (`ft-config.ts` additions)

| Constant | Value | Why |
|---|---|---|
| `MAX_GOLD_TRANSACTION` | 100000 | shape bound on a single gold credit/debit (fat-finger guard, not an economy rule) |

Per-call hit-dice counts are bounded in the tool input schema itself (`z.number().int().min(1).max(20)` — the largest possible pool); the snapshot's equipment selection is the `consumable` flag (§3.1), not a constant. (Exact constant set is the plan's call; the table records intent: bounds are structural validation, not game rules.)

## 12. File-level change map

| File | Change |
|---|---|
| `migrations/025_character_ledger.sql` | Create — §3.1 |
| `src/llm/schemas/character-sheet.ts` | Extend output schema — §3.2 |
| `src/llm/prompts/prep/character-sheet.txt` | Lockstep prompt update — §3.2 |
| `src/llm/prep/stages/character-sheet.ts` (+ processor) | Write new fields; initialize ledger (slots/gold/hit dice) — §3.2 |
| `src/repo/characters.ts` | Extend `ReplaceSubTablesInput`; add `LedgerOps` namespace methods (atomic debits/credits, slot/condition/feature ops, party snapshot read) — §4 |
| `src/session/rules-lawyer.ts` | Create — the service, §4–§6 |
| `src/session/srd/spell-slots.ts` | Create — §9.1 |
| `src/session/tiers/ft-tools.ts` | Register six tools — §5 |
| `src/session/tiers/fast-thinker.ts` | Render party ledger block — §7 |
| `src/session/tiers/types.ts` | `FtTurnContext.partyLedger`; `LedgerUpdatePayload` — §7/§8 |
| `src/session/turn-worker.ts` | Load snapshot per turn alongside roster — §7 |
| `src/llm/prompts/session/ft-system.txt` | Tool-scoping + improvised-object guidance — §6 |
| `contract/session-events.ts` | `ledger_update` frame — §8 |
| `src/session/transcript-codec.ts` | Persist/replay `ledger_update` rows — §8 |
| `src/session/ft-config.ts` | §11 constants |

**Worktree-collision note:** MYT-70 implements in a worktree in parallel with MYT-69 (main repo). Overlapping files: `fast-thinker.ts`, `turn-worker.ts`, `ft-system.txt`, `types.ts`, `ft-config.ts`. MYT-70's edits to these MUST stay small and additive (new block/field/paragraph, no restructuring) so the serial merge is trivial; the merged HEAD re-runs full verification per the CLAUDE.md worktree flow.

## 13. Testing

- **Rules Lawyer unit tests** — real PG, scoped fixtures per `CONVENTIONS.md`: every binding arm (insufficient gold / no slot / exhausted uses / empty consumable), every informational arm (unknown item/spell, not_found/ambiguous character), upcast + cantrip + pact casting, clamp/auto-unconscious behavior, both rest types, guard-predicate atomicity (rowcount-0 paths), idempotent condition ops.
- **SRD table tests** — slot maxima across progressions × levels, pinned against the SRD.
- **Tool-registry tests** — mocked `'ai'` boundary (never the ai.ts wrapper): input-schema shapes, resolver delegation, informational-vs-binding result mapping.
- **Prep co-evolution** — schema unit tests + a constructed-state smoke for the sheet stage (the natural smoke can't force a caster + a limited feature in one output; seed to just-before and invoke with real LLM — the myth-tt2g lesson).
- **E2E smoke (real Anthropic, wire-level)** — drive: shop purchase (gold debits), `cast_spell` (slot decrements), over-spend (binding rejection narrated, no state change), rock-throw (no spurious inventory rejection), potion drink (item consumed + HP heals), short rest (hit-dice healing + pact restore), long rest (full restore). Assert `ledger_update` frames on the SSE wire AND the PG rows after each step.
- 100% coverage gate; lint error rules (`no-non-null-assertion`, `no-deprecated`) as standard.

## 14. Resolved decisions (design gate, 2026-06-10)

1. **PG-direct ledger** over Redis-live/checkpoint and hybrid-cache — amends §17.3's session-state framing (§2).
2. **Tool surface includes HP/conditions and rests**, not just spec-literal cast+spend — a decrement-only ledger bricks characters; out-of-combat damage/healing is exploration-mode scope (§5).
3. **Prep emits structure** for gold + feature uses (and, by extension during spec drafting: `spellcasting_progression` + `hit_die`, since free-text `class` cannot be string-matched under ZFC) over runtime Haiku structuring and code-only SRD defaults (§3.2).
4. **Credit side ships now** (`acquire_resource`) over Scribe-reconciled-later — inventory is §17.7 Class-1 synchronous state; drift poisons every later debit validation (§5).
5. **Per-turn context block** for FT ledger visibility over query-tool-only (§7).
6. **Improvised-object semantics:** prompt-layer scoping + informational (non-binding) ledger-miss constraints; binding only on scarce quantified debits (§6) — from Miklos's rock requirement.
7. **No keyword heuristics anywhere:** consumable identification, caster progression, feature uses — all either structured-at-generation (prep) or pure math (SRD tables). The only string operation in the Rules Lawyer is trim/case-fold normalization.
8. **Integer gold** (gp only); fractional coinage out of scope (§3.1).
9. **Death saves out of scope** — 0 HP applies `unconscious`, combat engine owns dying (§5).
10. **Replay double-mutation accepted for v1** with the idempotency-key escape hatch documented (§10).
