# MYT-70 — Rules Lawyer & Shared Live Character Ledger (Design)

> **Linear:** MYT-70 · **Milestone:** Session Runtime + Combat L1
> **Spec refs:** Multiplayer Session Runtime §17.2 (tool belt), §17.3 (Rules Lawyer), §17.7 (write-authority Class 1)
> **Builds on:** MYT-68 (FT tool registry extension point, skill-check resolver pattern, consume-loop frame emission, session lock)
> **Brainstormed:** 2026-06-10 with Miklos. All §14 decisions are his calls at the design gate. §15 records blind-review round 1.

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
3. **Contention is a non-issue.** The session lock makes turns single-flight per session; a turn issues a handful of tool calls at most (hard cap 4–5, §17.2). One small PG transaction per mutation, serialized by construction. (The lock is coordination, not a safety guarantee — see §10 for the honest failure-path story.)

Each mutation is **one atomic PG statement or transaction** with guard predicates in the `WHERE` clause (`remaining >= n`-style); a zero-rowcount update IS the rejection (no read-then-write race in any debit path). Multi-row operations (rests, `adjust_hp`'s HP-write + condition pair) run in a single transaction. The credit-side upsert uses `INSERT … ON CONFLICT … DO UPDATE` against the §3.1 functional unique indexes — also a single atomic statement.

## 3. Schema — migration 025 + prep co-evolution

### 3.1 Migration `025_character_ledger.sql`

```sql
-- Gold: integer gold pieces. Fractional coinage (sp/cp) is out of scope;
-- the FT narrates coin color, the ledger tracks gp (§14.8).
ALTER TABLE characters ADD COLUMN gold INTEGER NOT NULL DEFAULT 0 CHECK (gold >= 0);

-- Hit dice pool (short-rest healing currency). Die size comes from prep (§3.2).
ALTER TABLE characters ADD COLUMN hit_die SMALLINT NOT NULL DEFAULT 8
  CHECK (hit_die IN (6, 8, 10, 12));
ALTER TABLE characters ADD COLUMN hit_dice_remaining SMALLINT NOT NULL DEFAULT 1
  CHECK (hit_dice_remaining >= 0);
ALTER TABLE characters ADD CONSTRAINT characters_hit_dice_bound
  CHECK (hit_dice_remaining <= level);

-- Caster progression: structured by prep (§3.2), consumed by the SRD slot
-- derivation (§9.1). Free-text `class` is never string-matched (ZFC).
ALTER TABLE characters ADD COLUMN spellcasting_progression TEXT NOT NULL DEFAULT 'none'
  CHECK (spellcasting_progression IN ('full', 'half', 'third', 'pact', 'none'));

-- HP invariant on the most-mutated ledger column (001 shipped it bare).
-- One-time clamp first: CharacterSheetOutputSchema has no cross-field
-- hit_points <= max_hit_points rule, so existing dev rows can violate it.
UPDATE characters SET hit_points = LEAST(GREATEST(hit_points, 0), max_hit_points);
ALTER TABLE characters ADD CONSTRAINT characters_hp_bounds
  CHECK (hit_points >= 0 AND hit_points <= max_hit_points);

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
-- Invariants: tracked features carry both counters; uses never exceed max;
-- a recharge schedule implies something to recharge.
ALTER TABLE character_features ADD CONSTRAINT character_features_uses_pair
  CHECK ((max_uses IS NULL) = (uses_remaining IS NULL));
ALTER TABLE character_features ADD CONSTRAINT character_features_uses_bound
  CHECK (uses_remaining IS NULL OR uses_remaining <= max_uses);
ALTER TABLE character_features ADD CONSTRAINT character_features_recharge_tracked
  CHECK (max_uses IS NOT NULL OR recharge = 'none');

-- Consumable flag: structured by prep (§3.2). Display metadata for the §7
-- snapshot + future sheet UI (consume-on-use vs durable gear). No keyword
-- heuristics anywhere (decision §14.7).
ALTER TABLE character_equipment ADD COLUMN consumable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE character_equipment ADD CONSTRAINT character_equipment_quantity_floor
  CHECK (quantity >= 0);

-- Ritual flag on spells (§3.2, §5 cast_spell): prep-structured, not name-matched.
ALTER TABLE character_spells ADD COLUMN ritual BOOLEAN NOT NULL DEFAULT false;

-- Name-keyed mutation substrate: the Rules Lawyer matches by normalized name,
-- so normalized names MUST be unique per character — otherwise a debit
-- UPDATE matches N rows and "rowcount 0 = rejection" reads N as success,
-- and the acquire upsert has no conflict target. Prep dedupe-merges before
-- insert (§3.2) so LLM duplicates can't terminal-fail on these.
CREATE UNIQUE INDEX idx_character_equipment_name
  ON character_equipment (character_id, lower(btrim(item_name)));
CREATE UNIQUE INDEX idx_character_features_name
  ON character_features (character_id, lower(btrim(feature_name)));
CREATE UNIQUE INDEX idx_character_spells_name
  ON character_spells (character_id, lower(btrim(spell_name)));

-- FK indexes for the per-turn §7 snapshot reads (PG does not auto-index FKs;
-- the four 001-era sub-tables have none). Also serve getFullCharacter + CASCADEs.
CREATE INDEX idx_character_skills_character ON character_skills (character_id);
-- (equipment/features/spells get theirs via the unique indexes above)

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

-- Ledger journal: append-only, one row per APPLIED mutation, written in the
-- SAME transaction as the mutation. §10 explains what it does and doesn't buy.
CREATE TABLE ledger_events (
  id UUID PRIMARY KEY,
  character_id UUID NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  turn_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  delta JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (turn_id, tool_call_id, character_id)
);
```

Defaults on the `ALTER TABLE` columns let existing dev rows survive the migration; they regenerate with real values on the next character-creation run (no production users — nothing to backfill). **Smoke note:** migrated-but-not-regenerated dev characters carry `progression='none'`, `gold=0` — every §13 smoke must drive freshly generated characters or casting/purchase flows trivially reject.

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

`equipmentEntrySchema` gains:

```ts
consumable: z.boolean(),   // potions, scrolls, rations — consume-on-use metadata
```

and `spellEntrySchema` gains:

```ts
ritual: z.boolean(),       // castable as a ritual (no slot, +10 min) — §5
```

**`prepared` is redefined (existing field, semantics now load-bearing).** `cast_spell` gates on `character_spells.prepared`, so its meaning must be pinned: **`prepared = true` means "currently castable."** The prompt instructs explicitly: spontaneous/known casters (sorcerers, bards, warlocks, rangers — any class that doesn't prepare) emit ALL known spells `prepared: true`; prepare-casters (clerics, druids, wizards, paladins) emit a sensible daily prepared set `true` and the rest `false`; cantrips always `true`. Without this, a model reasonably emits a sorcerer's spells as `prepared: false` ("sorcerers don't prepare") and **bricks every leveled cast that character ever attempts** — the blind review's first showstopper. The prompt also steers prep away from emitting slot-restoration features (Arcane Recovery, Font of Magic) as *tracked* features, since no tool can credit a slot (§14.13).

**Why prep, not code:** `class` is free text (`z.string().min(4).max(40)` — "Storm-Touched Sorcerer" is a legal value). String-matching it against SRD class names in code is the local-intelligence pattern ZFC forbids and breaks on every flavored name. The model decides *what kind of caster this character is* once, at generation time, as structured output; code then does pure math (§9.1). Same logic for feature uses, consumables, and rituals: judgment once at generation, structured forever after.

**The character-sheet processor:**

1. **Dedupe-merges** name-collisions (post-normalization) within each array before writing — sum quantities for equipment, keep-first for features/spells. Mechanical aggregation (ZFC-clean); required by the §3.1 unique indexes.
2. **Validates coherence** (structural validation, squarely inside the ZFC exceptions): every leveled spell's level ≤ the max slot level derivable from `(progression, level)` per §9.1, and leveled spells present ⟹ `progression ≠ 'none'` (cantrip-only lists with `'none'` stay legal). Violation → the stage's existing repair/retry path, not a silent write.
3. **Initializes the ledger in the same transaction as the sheet write:** gold ← `starting_gold`; hit dice pool ← level; spell-slot rows derived from `(spellcasting_progression, level)` via §9.1, written full. `character_spell_slots` **joins `replaceSubTables`' delete+re-insert set** — a retried stage must converge, not terminal-fail on the slot unique index. (Assumption made explicit: sheet re-runs happen pre-play only; a post-play re-run resets the live ledger to starting values. Fine today; any future "regenerate sheet" feature must revisit.)

The legacy `characters.create` path (`repo/characters.ts:62`, POST /characters) does not initialize slots; the plan verifies it is dead for play (everything routes through the concept→sheet pipeline) or ledger-inits it too.

No runtime LLM call ever sits in the Rules Lawyer path.

## 4. The Rules Lawyer service

`backend/src/session/rules-lawyer.ts` — pure functions, one exported resolver per tool, mirroring the skill-check resolver's contract:

- **Total.** Every failure arm returns a structured constraint result; the service never throws on game-rule grounds. (An uncaught throw surfaces as a tool-error part the loop continues past — the model would narrate an outcome with no adjudication.) Infrastructure errors (PG down) follow the skill-check fail-soft precedent: a generic "could not be resolved — do not narrate a definite outcome" constraint, logged.
- **Scoped dependency.** The service receives a `LedgerOps` projection (a new scoped interface over the characters repo namespace), not the whole Repo — same boundary discipline as `MechanicalReads` in `skill-check.ts:42`.
- **Character resolution** reuses `findSessionParticipantCharacterByName` semantics (`found | not_found | ambiguous`); `not_found`/`ambiguous` return the same informational constraint shape the skill-check resolver uses.
- **Name normalization** for spells/items/features: trim + case-fold on both sides before matching (mechanical normalization, not semantic matching — "fire bolt" matches "Fire Bolt"; nothing fuzzier). The §3.1 unique indexes guarantee at most one row matches; a multi-row match is an invariant violation (log + fail-soft).

Result contract (per call):

```ts
type LedgerResolution =
  | { ok: true; payload: LedgerUpdatePayload }   // mutation applied (or §10 idempotent replay)
  | { ok: false;
      binding: boolean;        // §6 semantics
      found: boolean;          // false = ledger miss (informational arm)
      constraint: string }     // the guidance/refusal prose the FT narrates from
```

(The §6 informational guidance lives in `constraint`; `binding`/`found` are the structured discriminators — one shape, no parallel contract.)

`payload` carries the post-mutation values the FT needs to narrate concretely (new HP, slots remaining at the consumed level, gold balance, uses left, dice rolled) — constraint-injection: the resolver owns the outcome, the FT owns the telling.

## 5. Tool surface

Six tools registered in `buildFtTools` (`backend/src/session/tiers/ft-tools.ts`) under the existing pure-resolver rules: `execute` returns data only, never emits frames; all player-visible emission happens in the FT consume loop in stream-part order. Inputs are `z.discriminatedUnion` where a `kind` exists, so the JSON Schema itself teaches the model per-kind required fields (no representable-but-invalid shapes). Tool **descriptions are load-bearing prompt surface** (the `roll_skill_check` precedent); each debit tool's description carries the invariant sentence "the returned constraint is the authoritative outcome — narrate HOW it happens, never whether," and `spend_resource`'s description carries the §6 improvised-object scoping directly (descriptions travel with the tool; the system prompt is further away).

| Tool | Input (Zod, sketch) | Resolver behavior |
|---|---|---|
| `cast_spell` | `{ character_name, spell_name, slot_level? (1–9), ritual? }` | Spell must be on `character_spells` and `prepared` ("currently castable", §3.2; cantrips: level 0 → no slot, always castable if known). **Slot selection:** explicit `slot_level` = deliberate upcast, exact row; omitted → the LOWEST available slot level ≥ the spell's level (pure math — this is what makes pact casters and "L1 empty, L2 available" states cast legally without burning loop iterations); payload reports the level consumed. Binding constraint ONLY when no slot ≥ spell level remains anywhere ("no remaining slots can cast this" — defined message for the empty-set case). `ritual: true` + spell's `ritual` flag → no slot debit; `ritual: true` on a non-ritual spell → informational correction. `slot_level` on a cantrip → ignored, noted in payload (5e: cantrips don't upcast via slots). Known-but-unprepared → **binding**, constraint names the character's currently-castable spells. Unknown spell → informational miss (§6 — always the "correct gently" branch; there is no environmental fireball). |
| `spend_resource` | `discriminatedUnion('kind'):` `{ kind: 'gold', character_name, amount }` · `{ kind: 'item', character_name, name, amount? }` · `{ kind: 'feature', character_name, name }` | `gold`: atomic `gold = gold − n WHERE gold >= n`; insufficient → binding constraint with actual balance. `item`: decrements `quantity` (default 1); the row is RETAINED at 0, so a later spend of the same item is a binding "you're out of X" (snapshot shows 0), not an unknown-item miss. Covers consumption AND drop/give (any removal). No row at all → informational miss (§6). `feature`: decrements `uses_remaining`; exhausted → binding constraint naming the recharge type; untracked feature (`max_uses` NULL) → success, no counter. All `amount`s are `int().min(1)` with sane maxes in the schema — a model-emitted 0/negative can't no-op or credit through a debit path. |
| `acquire_resource` | `discriminatedUnion('kind'):` `{ kind: 'gold', character_name, amount }` · `{ kind: 'item', character_name, name, amount?, consumable? }` | The credit side. Gold increments; items are a single atomic `INSERT … ON CONFLICT (character_id, lower(btrim(item_name))) DO UPDATE SET quantity = quantity + n` against the §3.1 index. No game-rule validation — the fiction granted it; shape validation only. Prompt guidance: reuse names exactly as the §7 snapshot shows them (prevents "Healing Potion" / "potion of healing" fragmentation; the snapshot now carries full inventory, so the canonical names are always in view). |
| `adjust_hp` | `{ character_name, kind: 'damage'\|'heal', amount?: int, dice?: string }` | Exactly one of `amount` (fixed effects) or `dice` (e.g. `"2d4+2"`) — the dice expression is rolled by the **deterministic dice engine inside the resolver** (Principle #4 holds: code rolls; this also collapses potion/trap flows to fewer loop iterations). Clamped to `[0, max_hit_points]`; the HP-write and any condition change are one transaction. Hitting 0 auto-applies `unconscious` and the payload says so explicitly — the FT narrates collapse, not death (death saves are combat-engine scope). |
| `update_condition` | `{ character_name, condition: <5e enum>, action: 'apply'\|'clear', level? }` | Upsert/delete on `character_conditions`. `level` required iff exhaustion. Apply-when-present updates level (exhaustion) or no-ops idempotently; clear-when-absent no-ops idempotently (idempotent no-ops emit NO frame — nothing changed, §8). Clearing `unconscious` while HP is 0 → binding constraint ("unconscious is HP-derived; heal them first") — the HP↔unconscious invariant (§5a) has one owner. |
| `take_rest` | `{ type: 'short'\|'long', hit_dice?: [{ character_name, count: 1–20 }] }` | Party-wide (all session participants; campaign members not present don't rest — recorded), single transaction. **Short:** spend hit dice per request, **clamped to `hit_dice_remaining`** (spend `min(count, remaining)`; payload itemizes per-character dice actually spent — the only RAW-compatible option that keeps the rest atomic); each die heals `max(0, roll(hit_die) + CON mod)` (per-die floor 0 — a CON −2 roll of 1 must not damage) via the deterministic dice engine; pact slots restore (rows where `spellcasting_progression = 'pact'`); `short_rest` features restore. An unknown/ambiguous `character_name` in `hit_dice` rejects the whole call (informational) — no partial party state. **Long:** HP → max; hit dice regain `max(1, ⌊level/2⌋)` up to level; all slots restore; `short_rest` + `long_rest` features restore; exhaustion −1 (at level 1 the row is **DELETEd** — the CHECK forbids level 0). Other conditions are NOT auto-cleared — duration is narrative judgment, the FT clears via `update_condition`. One per-24h cadence is the FT's narrative job (`ft-system.txt` line: no back-to-back long rests), not a code rule. |

**§5a — the HP↔unconscious invariant has one owner.** Any HP transition 0 → positive clears `unconscious`; any transition → 0 applies it. Enforced in `LedgerOps` at the HP write itself, so it holds identically for `adjust_hp`, short-rest hit-dice healing, and long-rest HP→max (a character downed in exploration who long-rests wakes up *not* flagged unconscious at full HP). RAW says a 0-HP character doesn't benefit from a long rest at all; healing them anyway is a **deliberate house rule** given death saves are out of scope (§14.9), not an accident.

**Cap interaction (honest accounting):** single calls are ~0-latency, but composed flows cost iterations — a potion is now `spend_resource` + `adjust_hp(dice)` (2 of the 4–5 cap; the dice-expression input is what keeps it from being 3). `FT_MAX_TOOL_STEPS` stays as shipped and is a smoke-tuned knob; if the E2E shows cap pressure on composed flows, raising it is a config change, not a design change.

## 6. Constraint semantics — binding vs informational

The design principle (Miklos's "rock" case: *"I pick up a rock and throw it at the goblin"* must never produce *"Sorry, you don't have a rock in your inventory"*):

**The Rules Lawyer is authoritative about ledger STATE, not about what absence MEANS.** Scarcity is what makes refusal binding.

- **Binding** (`binding: true`) — quantified debits on scarce, tracked state: insufficient gold, no castable slot, known-but-unprepared spells, feature uses exhausted, a tracked consumable at quantity 0. The constraint is the authoritative outcome; the FT narrates *how* the attempt falls short, never a success. (Identical posture to a failed skill check.)
- **Informational** (`binding: false, found: false`) — a ledger *miss*: an item/spell name with no row. The constraint reports the miss plus guidance with **three branches**:
  1. *Plausibly-at-hand environmental object* (the rock) → narrate freely; no ledger involvement.
  2. **The transcript shows the fiction granted it** → the grant was narrated but never credited; call `acquire_resource` NOW, then proceed. (The FT holds the full session transcript — this is the common miss, and without this branch the guidance instructs pedantry toward items the DM itself handed out.)
  3. *Never-established assertion of ownership* → correct gently.
  Unknown **spells** always take branch 3 — there is no environmental fireball.

**The gold-recovery rule (sanctioned, narrow):** binding gold rejections have no informational tier, so a *missed credit* (the baron's purse narrated in prose, `acquire_resource` never called) would otherwise force the FT to contradict lived fiction with no recovery path. Sanctioned recovery: the FT MAY respond to a binding gold rejection by calling `acquire_resource` for a **transcript-evidenced grant only** (the prompt states this narrowly — citing its own prior narration, never to satisfy a purchase the fiction didn't fund). Cross-session missed credits (granted in session 3's prose, noticed in session 5 when the transcript is gone) are accepted as a v1 gap; the §17.7 Haiku tripwire / session-end Scribe pass is the designed detector if play shows it matters (§14.12).

**Prompt layer (first line of defense):** the tool descriptions and `ft-system.txt` scope the debit tools to *tracked, scarce* resources — "do NOT call `spend_resource` for improvised or environmental objects (a rock, a mug, a plank torn from a fence); narrate those freely; throwing one may still warrant `roll_dice`/`roll_skill_check`." The common case never round-trips the ledger at all. If the player *keeps* an improvised object as something they care about, the FT may `acquire_resource` it into inventory; dropped scenery stays untracked. Two further prompt lines: **actor scoping** (mutate only the acting player's character's resources absent clear table consent — a multiplayer accident/griefing surface) and the **sub-gp posture** (narrate copper-scale purchases as negligible color; the ledger moves only at gp granularity).

## 7. FT visibility — the party ledger block

The turn worker loads a **party ledger snapshot** from PG each turn (it already derives the roster per-turn from `session_participants` — same load point) and threads it into `FtTurnContext.partyLedger`.

**Contents per character — the numbers AND the nouns:** current/max HP, hit dice, gold, slot ledger (`L1 2/3 · L2 0/2` style), active conditions, tracked-feature names + uses, **the spell list grouped by level with castable/ritual flags**, and **the full equipment list (names + quantities, consumables flagged)**. The blind review's second showstopper: eliding the nouns makes `cast_spell` undrivable from player paraphrase ("I cast my fear spell" — the FT must emit the sheet's exact name, which appears nowhere in its context), silently defeats slot enforcement (informational miss → narrate freely → slot never decrements), and turns non-consumable purchases into write-only state the DM forgets across sessions. Names-only costs tens of tokens per character (equipment caps at 40 rows, spells at 60 — typical lists are far shorter); a party of 4–6 lands well under ~1.5k tokens. The FT maps player intent → canonical name (ZFC: interpretation is the model's job); code does exact matching.

**Placement is pinned (cache-correctness, not taste):** `buildModelMessages` (`fast-thinker.ts:164`) has two regions — the system message (where `{{party_roster}}` renders, carrying a cache breakpoint; the roster changes only on join/leave) and the history array (breakpoint on the last settled message). The ledger block changes **every turn**, so it must render as a non-persisted message **after the last cache breakpoint** (with the current batch, last position) — injected at render time from `ctx.partyLedger`, **never written to `session_messages`** (the byte-stable history rebuild is unaffected; next turn's settled prefix is identical because the block was never in it). Following the roster precedent into the system template would bust the static-payload cache every turn — a silent ~10× input-token regression no test catches. **Staleness rule:** the block is turn-start state; post-mutation truth within the turn comes from the tool-result payloads (§4 provides them for exactly this reason).

A player's own mechanical sheet is public-by-construction — no enforced-ignorance interaction; `FtTurnContext` stays public-only. Conditions inform the FT's existing advantage/disadvantage flags on `roll_skill_check` — no resolver change.

## 8. Player-visible frames & persistence

**Wire:** one new `ledger_update` server frame (`contract/session-events.ts`), emitted by the FT consume loop **in stream-part order** from successful (`ok: true`) tool-result parts — exactly the `skill_check` frame pattern. Payload: `{ character_name, kind: 'hp'|'gold'|'item'|'feature'|'spell_slot'|'condition'|'rest', summary }` plus the post-mutation values from the resolver payload. `take_rest` emits **one frame per affected character** (players watch their own row change; a single party-shaped frame fits neither the payload nor the future sheet UI). Binding rejections and idempotent no-ops emit NO frame — nothing changed; the refusal lives in prose.

**Persistence (the codec seam — decided here, not improvised):** the transcript codec's `KIND_TO_TOOL`/`TOOL_TO_KIND` maps are a strict 1:1 bijection and an unknown tool name throws `TranscriptCorruptError`. So: **six new `session_messages` message types, one per tool** (`cast_spell`, `spend_resource`, `acquire_resource`, `adjust_hp`, `update_condition`, `take_rest`), persisting the standard `{toolCallId, input, output}` row JSON — the current pattern, no bijection change. **Rejection (`ok: false`) rows persist too** — the FT's rebuilt history needs the rejection result for coherence; they are an *expected, frequent* outcome, not corruption. Reconnect replay maps `ok: true` rows → `ledger_update` frames and **silently skips** `ok: false` rows (discriminated on the result shape — distinct from the corrupt-blob warn path); the live consume loop's frame filter is `ok === true`.

**Baseline (recorded decision):** frames are deltas; nothing in the frame stream establishes a starting balance for a player who joins/reconnects before any mutation. The future character-sheet UI gets its baseline from a REST read (or a join-preamble snapshot), not from replay — out of MYT-70's scope, recorded so the first sheet UI doesn't ship reading blanks (§14.14).

## 9. SRD derivation (deterministic code)

### 9.1 Slot tables — `backend/src/session/srd/spell-slots.ts`

Pure lookup: `(progression, level) → { slotLevel: max }[]`, SRD 5e tables for `full` (wizard-style 1–20), `half` (paladin/ranger, slots from L2), `third` (EK/AT, from L3), `pact` (warlock: N slots of a single pact level, all restoring on short rest — identified by `spellcasting_progression = 'pact'`), `none` (no rows). Levels outside 1–20 (the column is an unchecked INTEGER from 001) **throw at character finalize** — generation-time data error, not a runtime arm. Consumed at character finalize (§3.2), by `take_rest` restores, and by the §3.2 coherence validation. SRD data ports from the prototype's reference JSON per the Backend Core spec's porting rules.

**Recorded one-way door (§14.11):** a single progression enum per character cannot represent a multiclass caster (warlock 2 / sorcerer 3 needs pact AND leveled slots simultaneously). Multiclass support means a child table and this column becoming derived/dropped — do not build further load-bearing logic on the enum.

### 9.2 Rest rules

Encoded in the Rules Lawyer per the §5 table — all arithmetic + dice-engine rolls; no model involvement. Per-die healing floor 0; exhaustion-at-1 deletes the row; pact restore on short rest.

## 10. Error handling, idempotency & the ledger journal

- **Guard-predicate atomicity:** every debit is a single `UPDATE … WHERE <guard> RETURNING`; rowcount 0 = adjudicated rejection. The credit upsert is a single `ON CONFLICT` statement. No SELECT-then-UPDATE anywhere.
- **Totality:** infra failure inside a resolver → fail-soft constraint ("could not be resolved — do not narrate a definite outcome"), `logger.warn`, turn continues. Same posture as the skill-check resolver.
- **The ledger journal (`ledger_events`, §3.1):** every applied mutation inserts a journal row **in the same transaction**, `INSERT … ON CONFLICT DO NOTHING` on `(turn_id, tool_call_id, character_id)` checked FIRST — a conflict means this exact tool call already applied (BullMQ redelivery of an in-flight job), and the resolver returns the journaled payload as an idempotent success.
- **The honest exposure (what the journal does NOT close):** tools execute at SDK pipeline pace and commit immediately, so (a) a turn that **terminally fails after a mutation** (mid-stream API error → emitted-anything latch → `turn_error`) leaves committed debits behind with no narration and no frame — the player who "tries again" can double-spend; (b) a **full re-render retry** (crash before the latch trips) generates fresh `toolCallId`s, so the journal's conflict key cannot dedupe it. The MYT-68 turn-worker's "never-flush abort leaves PG at the pre-turn snapshot" invariant does NOT hold for ledger tables — this is accepted, eyes open, for v1 (§14.10): the failure paths are bounded by the session lock + latch, the amounts are small, and the journal makes every mutation **observable** (without it, a double-debit on a mutable `gold` column is indistinguishable from a legitimate spend — the escape-hatch trigger "if play shows double-debits" would be unverifiable). The designed escape hatches, in order: compensation (reverse a failed turn's journaled events on the terminal-error path), then a semantic dedupe key. Neither ships in v1.
- **Validation order** in `cast_spell`: character → spell known → castable (`prepared`) → slot — so the constraint names the *first* real problem, not a cascade.

## 11. Config (`ft-config.ts` additions)

| Constant | Value | Why |
|---|---|---|
| `MAX_GOLD_TRANSACTION` | 100000 | shape bound on a single gold credit/debit (fat-finger guard, not an economy rule) |

Per-call hit-dice counts are bounded in the tool input schema (`int().min(1).max(20)` — the largest possible pool, clamped to actual remaining at resolve time); all `amount` fields are `int().min(1)` with schema maxes. Bounds are structural validation, not game rules; the exact constant set is the plan's call.

## 12. File-level change map

| File | Change |
|---|---|
| `migrations/025_character_ledger.sql` | Create — §3.1 (columns, CHECKs, unique/FK indexes, conditions + slots + journal tables) |
| `src/llm/schemas/character-sheet.ts` | Extend output schema (incl. `ritual`, `consumable`, `prepared` doc) — §3.2 |
| `src/llm/prompts/prep/character-sheet.txt` | Lockstep prompt update incl. `prepared`-semantics + slot-restore-feature steer — §3.2 |
| `src/llm/prep/stages/character-sheet.ts` (+ processor) | Dedupe-merge; coherence validation; ledger init in-transaction; slots join replaceSubTables — §3.2 |
| `src/repo/characters.ts` | Extend `ReplaceSubTablesInput`; add `LedgerOps` namespace (atomic debits/credits, slot/condition/feature ops, HP-transition invariant, journal writes, party snapshot read) — §4, §5a, §10 |
| `src/session/rules-lawyer.ts` | Create — the service, §4–§6 |
| `src/session/srd/spell-slots.ts` | Create — §9.1 |
| `src/session/tiers/ft-tools.ts` | Register six tools (discriminated-union inputs, load-bearing descriptions) — §5 |
| `src/session/tiers/fast-thinker.ts` | Render party ledger block after the last cache breakpoint — §7 |
| `src/session/tiers/types.ts` | `FtTurnContext.partyLedger`; `LedgerUpdatePayload` — §7/§8 |
| `src/session/turn-worker.ts` | Load snapshot per turn alongside roster — §7 |
| `src/llm/prompts/session/ft-system.txt` | Tool-scoping, improvised-object 3-branch guidance, gold-recovery rule, actor scoping, sub-gp posture, rest cadence — §6 |
| `contract/session-events.ts` | `ledger_update` frame — §8 |
| `src/session/transcript-codec.ts` | Six per-tool message types in the kind↔tool maps — §8 |
| `src/server/ws-session.ts` (replay path) | `ok:true` rows → frames; silent-skip `ok:false`; per-character rest frames — §8 |
| `src/session/ft-config.ts` | §11 constants |

**Worktree-collision note:** MYT-70 implements in a worktree in parallel with MYT-69 (main repo). Overlapping files: `fast-thinker.ts`, `turn-worker.ts`, `ft-system.txt`, `types.ts`, `ft-config.ts`. MYT-70's edits to these MUST stay small and additive (new block/field/paragraph, no restructuring) so the serial merge is trivial; the merged HEAD re-runs full verification per the CLAUDE.md worktree flow.

## 13. Testing

- **Rules Lawyer unit tests** — real PG, scoped fixtures per `CONVENTIONS.md`: every binding arm (insufficient gold / no castable slot / known-but-unprepared / exhausted uses / consumable at 0), every informational arm (unknown item/spell, not_found/ambiguous character), slot selection (lowest-available-≥-level, explicit upcast, pact-level casting, cantrip + spurious slot_level, ritual no-debit, ritual flag mismatch), clamp/auto-unconscious via ALL THREE HP-raising paths (§5a), both rest types (hit-dice clamp, per-die floor, exhaustion delete-at-1, pact restore), guard-predicate atomicity (rowcount-0 paths), journal idempotent-replay arm, idempotent condition ops, multi-row-match invariant violation.
- **SRD table tests** — slot maxima across progressions × levels, pinned against the SRD; out-of-range level throws.
- **Tool-registry tests** — mocked `'ai'` boundary (never the ai.ts wrapper): discriminated-union input shapes, resolver delegation, ok-filter frame mapping, dice-expression delegation to the engine.
- **Codec/replay tests** — six message types round-trip; `ok:false` rows persist, replay silently skips them; per-character rest frames.
- **Prep co-evolution** — schema unit tests, dedupe-merge + coherence-validation arms, and a constructed-state smoke for the sheet stage with real LLM asserting (a) a known-caster concept yields all-`prepared:true` spells and (b) a limited feature carries uses/recharge (the natural smoke can't force both in one output — the myth-tt2g lesson).
- **E2E smoke (real Anthropic, wire-level, freshly generated characters only — §3.1 smoke note):** shop purchase (gold debits) → **FT narrates a reward → assert the credit landed** (the highest-risk behavior: the fiction-grants-it path) → `cast_spell` by paraphrase against the snapshot (slot decrements at the right level) → over-spend (binding rejection narrated, no state change) → rock-throw (no spurious inventory rejection) → potion drink (item consumed + dice-expression heal) → damage to 0 (unconscious applied) → long rest (full restore + unconscious cleared) → short rest (hit-dice clamp + pact restore). Assert `ledger_update` frames on the SSE wire AND the PG rows (including `ledger_events` journal rows) after each step.
- 100% coverage gate; lint error rules (`no-non-null-assertion`, `no-deprecated`) as standard.

## 14. Resolved decisions (design gate, 2026-06-10)

1. **PG-direct ledger** over Redis-live/checkpoint and hybrid-cache — amends §17.3's session-state framing (§2).
2. **Tool surface includes HP/conditions and rests**, not just spec-literal cast+spend — a decrement-only ledger bricks characters; out-of-combat damage/healing is exploration-mode scope (§5).
3. **Prep emits structure** for gold + feature uses (and, by extension during drafting/review: `spellcasting_progression`, `hit_die`, `consumable`, `ritual`, and the `prepared`-semantics pin) over runtime Haiku structuring and code-only SRD defaults (§3.2).
4. **Credit side ships now** (`acquire_resource`) over Scribe-reconciled-later — inventory is §17.7 Class-1 synchronous state; drift poisons every later debit validation (§5).
5. **Per-turn context block** for FT ledger visibility over query-tool-only (§7) — revised by review to carry the nouns (spells + full inventory), not just the numbers; the original elision reopened the query-tool question by making purchased gear invisible.
6. **Improvised-object semantics:** prompt-layer scoping + informational (non-binding) ledger-miss constraints with the three-branch guidance; binding only on scarce quantified debits (§6) — from Miklos's rock requirement.
7. **No keyword heuristics anywhere:** consumable identification, caster progression, feature uses, rituals — all either structured-at-generation (prep) or pure math (SRD tables). The only string operation in the Rules Lawyer is trim/case-fold normalization.
8. **Integer gold** (gp only); fractional coinage out of scope (§3.1, §6 sub-gp posture line).
9. **Death saves out of scope** — 0 HP applies `unconscious`, combat engine owns dying; long rest healing a 0-HP character is a deliberate house rule (§5a).
10. **Failure-path double-mutation accepted for v1, eyes open** (§10): terminal-failed turns and full re-render retries can leave/duplicate committed mutations; the `ledger_events` journal ships NOW (observability + idempotent same-call replay + the substrate for compensation); compensation and semantic dedupe are the documented escape hatches.
11. **Single progression enum is a recorded one-way door** — multiclass casters need a child table; don't build on the enum (§9.1).
12. **Cross-session missed credits accepted for v1** with the tripwire/Scribe detector as the designed follow-up (§6).
13. **Slot-restoration features (Arcane Recovery, Font of Magic) are not mechanizable in v1** — no tool credits slots; prep prompt steers away from emitting them as tracked features; FT narrates around (§3.2).
14. **Frame stream carries deltas only; baseline is a REST/join-preamble concern** for the future sheet UI (§8).
15. **Prepared-spell swapping on long rest deferred** — fixed castable lists in v1; the FT's posture when asked is honest deferral, not improvised mechanics. Temp HP and item charges likewise narrative-only in v1 (`ft-system.txt` sets expectations).

## 15. Blind-review round 1 record (Coins & currencies, all-Fable)

Four reviewers, lenses: data-integrity/concurrency/schema (Ducat), 5e rules fidelity (Florin), LLM-orchestration/ZFC (Guilder), product/play-feel (Drachma). Strict-rubric outcome: **2 showstoppers, both fixed in this revision; ~30 substantive NITs folded; no second round (stopping rule).**

- **SHOWSTOPPER 1 (Florin C1, convergent Guilder I3 / Drachma I2):** `prepared` had no defined semantics for known casters — prep would brick every sorcerer/bard/warlock at generation time (all leveled casts binding-rejected forever), invisible to tests because it lives in prep-output semantics. Fixed: `prepared` = "currently castable," prompt pins it per caster type (§3.2); known-but-unprepared is a defined binding arm (§5).
- **SHOWSTOPPER 2 (Guilder C1 / Drachma C2, convergent Florin I5):** the §7 snapshot elided spell lists and non-consumable inventory — `cast_spell` was undrivable from paraphrase (silent enforcement no-op: spell narrated, slot never decremented) and purchased gear became write-only across sessions. Fixed: the snapshot carries the nouns (§7).
- Major NIT clusters folded: honest §10 rewrite + `ledger_events` journal (Ducat C1); functional unique name indexes + prep dedupe + ON CONFLICT upsert (Ducat C2/Guilder I4); slot-selection math for pact/partial-depletion casts (Florin I1); the §5a HP↔unconscious single-owner invariant (×4 convergent); prep coherence validation (Florin I3); cache-placement pin + staleness rule (Ducat I4/Guilder I1); per-tool codec message types + ok-filter replay (Guilder I2); ritual casting (Drachma I2); three-branch miss guidance + sanctioned gold recovery + credit E2E step (Drachma C1); dice-expression `adjust_hp` (Guilder I6/Drachma M1); rest clamp/floor/delete-at-1 semantics (Florin I4/M1, Ducat m5); HP/quantity/hit-dice CHECKs + FK indexes (Ducat I3/I5/m1/m2); discriminated-union inputs + amount floors (Guilder M2/Ducat m9); replaceSubTables slot convergence (Ducat I1); fresh-character smoke note (Guilder M8).
