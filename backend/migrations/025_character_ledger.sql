-- 025_character_ledger.sql — MYT-70 §3.1 Rules Lawyer + shared live character ledger.
-- Adds the mutable per-character ledger substrate the Rules Lawyer debits/credits:
-- gold, hit-dice pool, caster progression, an HP invariant on the most-mutated
-- column, per-level spell slots, limited-feature use counters, consumable +
-- ritual flags, the normalized-name unique indexes the name-keyed mutation path
-- requires, FK indexes for the per-turn §7 snapshot reads, the closed-enum
-- conditions table, and the append-only ledger_events journal (one row per
-- applied mutation, written in the mutation's transaction). Defaults let existing
-- dev rows survive; they regenerate with real values on next character creation.

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
