// backend/src/repo/characters-ledger.ts
//
// MYT-70 §4/§5a/§10 — the atomic-mutation substrate of the shared live
// character ledger. Sibling binder to `charactersNs`, composed into it so the
// methods surface as `repo.characters.*` / `tx.characters.*`. Lives in its own
// module purely to keep `characters.ts` under the 400-line cap.
//
// Every debit is a SINGLE guard-predicate `UPDATE … WHERE <guard> RETURNING`
// (rowcount 0 = adjudicated rejection — NO SELECT-then-UPDATE anywhere, §2/§10);
// the credit upsert is a single `ON CONFLICT`; multi-row ops (HP-write + the
// §5a condition pair, the party-wide rests) run through the bound `c`, which
// the resolver binds to a tx client so the mutation + its `ledger_events`
// journal row commit atomically (§10).
//
// The Rules Lawyer receives the `LedgerOps` projection (not the whole repo) —
// the same scoped-boundary discipline as `MechanicalReads` in skill-check.ts.

import { uuidv7 } from './uuidv7.js'
import { toCharacter } from './mappers.js'
import type { CharacterDbRow } from './mappers.js'
import type { ClientLike } from './_types.js'
import type { Character } from './types.js'
import type { SpellcastingProgression } from '../session/srd/spell-slots.js'

const norm = (s: string): string => s.trim().toLowerCase()

/** The CON modifier the rest math needs, derived from the abilities the
 *  resolver already has on the Character — kept here so callers don't re-derive. */
function conModifier(con: number): number {
  return Math.floor((con - 10) / 2)
}

// ---------------------------------------------------------------------------
// Projections + result discriminators
// ---------------------------------------------------------------------------

/** The live ledger projection returned alongside a resolved character — the
 *  numbers the resolver needs without a second read. */
export interface LedgerCharacterProjection {
  readonly character: Character
  readonly gold: number
  readonly hitDie: number
  readonly hitDiceRemaining: number
  readonly spellcastingProgression: SpellcastingProgression
  /** CON modifier, pre-derived for the rest healing math. */
  readonly conMod: number
}

export type FindLedgerCharacterResult =
  | { readonly outcome: 'found'; readonly projection: LedgerCharacterProjection }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'ambiguous' }

type DebitGoldResult =
  | { readonly outcome: 'debited'; readonly gold: number }
  | { readonly outcome: 'insufficient'; readonly gold: number }

type DebitItemResult =
  | { readonly outcome: 'debited'; readonly quantity: number }
  | { readonly outcome: 'insufficient'; readonly quantity: number }
  | { readonly outcome: 'absent' }

type DebitFeatureUseResult =
  | { readonly outcome: 'debited'; readonly usesRemaining: number; readonly recharge: string }
  | { readonly outcome: 'exhausted'; readonly recharge: string }
  | { readonly outcome: 'untracked' }
  | { readonly outcome: 'absent' }

type DebitSpellSlotResult =
  | { readonly outcome: 'debited'; readonly slotsRemaining: number }
  | { readonly outcome: 'insufficient' }

export interface SpellSlotRow {
  readonly slotLevel: number
  readonly slotsMax: number
  readonly slotsRemaining: number
}

/** A single `character_spells` row — what cast_spell needs to validate
 *  known/castable + select an upcast level. `prepared` is the §3.2 "currently
 *  castable" flag; `ritual` lets a ritual cast skip the slot debit. */
export interface CharacterSpellRow {
  readonly name: string
  readonly level: number
  readonly prepared: boolean
  readonly ritual: boolean
}

export type ConditionName =
  | 'blinded' | 'charmed' | 'deafened' | 'exhaustion' | 'frightened' | 'grappled'
  | 'incapacitated' | 'invisible' | 'paralyzed' | 'petrified' | 'poisoned'
  | 'prone' | 'restrained' | 'stunned' | 'unconscious'

/** apply/clear report whether anything actually changed — an idempotent no-op
 *  (clear-when-absent, apply-identical) emits NO frame (§8). */
type ConditionWriteResult =
  | { readonly outcome: 'changed' }
  | { readonly outcome: 'noop' }

export interface LedgerEventInput {
  readonly characterId: string
  readonly sessionId: string
  readonly turnId: string
  readonly toolCallId: string
  readonly tool: string
  readonly delta: Record<string, unknown>
}

/** The already-rolled per-character short-rest spend the resolver passes in
 *  (Principle #4: the resolver rolls; the repo does pure writes). */
interface ShortRestRequest {
  readonly characterId: string
  /** Dice actually spent (resolver-clamped to hit_dice_remaining). */
  readonly diceSpent: number
  /** Total HP healed by those dice (resolver-summed, per-die floor 0). */
  readonly healTotal: number
}

/** A session participant's rest-relevant numbers — what `take_rest` needs to
 *  roll the short-rest hit-dice heal (per-die `max(0, roll(hitDie) + conMod)`)
 *  and itemize the per-character payload. `conMod` is pre-derived here (the
 *  party snapshot omits CON; the resolver rolls and must not re-derive). */
export interface RestParticipant {
  readonly characterId: string
  readonly name: string
  readonly hitDie: number
  readonly hitDiceRemaining: number
  readonly conMod: number
}

// ---------------------------------------------------------------------------
// §7 party ledger snapshot shape
// ---------------------------------------------------------------------------

interface SnapshotSpell {
  readonly name: string
  readonly level: number
  readonly prepared: boolean
  readonly ritual: boolean
}

interface SnapshotEquipment {
  readonly name: string
  readonly quantity: number
  readonly consumable: boolean
}

interface SnapshotFeature {
  readonly name: string
  readonly maxUses: number
  readonly usesRemaining: number
  readonly recharge: string
}

/** Structurally identical to the contract's `ActiveCondition` (the wire shape
 *  the `ledger_update` frame carries). Kept as its own name because this is the
 *  DB projection; the publisher maps one onto the other. */
export interface SnapshotCondition {
  readonly condition: string
  readonly level: number | null
}

interface PartyLedgerCharacter {
  readonly characterId: string
  readonly name: string
  readonly hitPoints: number
  readonly maxHitPoints: number
  readonly hitDie: number
  readonly hitDiceRemaining: number
  readonly level: number
  readonly gold: number
  readonly slots: readonly SpellSlotRow[]
  readonly conditions: readonly SnapshotCondition[]
  /** Only TRACKED features (max_uses NOT NULL) — untracked ones aren't a
   *  resource the FT narrates a count for. */
  readonly trackedFeatures: readonly SnapshotFeature[]
  readonly spells: readonly SnapshotSpell[]
  readonly equipment: readonly SnapshotEquipment[]
}

export type PartyLedgerSnapshot = readonly PartyLedgerCharacter[]

// ---------------------------------------------------------------------------
// The scoped LedgerOps interface (what the Rules Lawyer receives)
// ---------------------------------------------------------------------------

export interface LedgerOps {
  findLedgerCharacterByName(sessionId: string, name: string): Promise<FindLedgerCharacterResult>
  debitGold(characterId: string, amount: number): Promise<DebitGoldResult>
  creditGold(characterId: string, amount: number): Promise<number>
  debitItem(characterId: string, name: string, amount: number): Promise<DebitItemResult>
  acquireItem(
    characterId: string,
    name: string,
    amount: number,
    consumable: boolean,
  ): Promise<number>
  debitFeatureUse(characterId: string, name: string): Promise<DebitFeatureUseResult>
  debitSpellSlot(characterId: string, slotLevel: number): Promise<DebitSpellSlotResult>
  readSpellSlots(characterId: string): Promise<readonly SpellSlotRow[]>
  readCharacterSpells(characterId: string): Promise<readonly CharacterSpellRow[]>
  writeHp(characterId: string, newHp: number): Promise<{ hp: number; maxHp: number }>
  applyCondition(
    characterId: string,
    condition: ConditionName,
    level: number | null,
  ): Promise<ConditionWriteResult>
  clearCondition(characterId: string, condition: ConditionName): Promise<ConditionWriteResult>
  /** myth-hlydp: the character's CURRENT active-condition set, ordered by name.
   *  A narrow single-query read — the `ledger_update` emit sites on the hot HP
   *  path need exactly this and must not pay for a whole `readPartyLedgerSnapshot`
   *  (which fans out per character across slots / features / spells / equipment).
   *  Sites that ALREADY hold a post-mutation snapshot reuse its `conditions`
   *  instead of calling this. */
  readConditions(characterId: string): Promise<readonly SnapshotCondition[]>
  shortRest(sessionId: string, requests: readonly ShortRestRequest[]): Promise<void>
  longRest(sessionId: string): Promise<void>
  /** The rest-relevant per-participant numbers (incl. pre-derived CON mod) the
   *  `take_rest` resolver rolls its short-rest hit-dice heal from. */
  readRestParticipants(sessionId: string): Promise<readonly RestParticipant[]>
  writeLedgerEvent(input: LedgerEventInput): Promise<string | null>
  /** Idempotency check (§10): has this exact (turn, call, character) already
   *  committed? The resolver checks BEFORE mutating so a BullMQ redelivery
   *  cannot double-apply a debit (the journal alone can't prevent that — the
   *  mutation runs before the journal's ON CONFLICT fires). */
  findLedgerEvent(turnId: string, toolCallId: string, characterId: string): Promise<boolean>
  readPartyLedgerSnapshot(sessionId: string): Promise<PartyLedgerSnapshot>
}

// ---------------------------------------------------------------------------
// The §5a single owner of the HP↔unconscious invariant
// ---------------------------------------------------------------------------

/** Every HP write routes through here — `writeHp`, `shortRest`'s hit-dice
 *  heal, and `longRest`'s HP→max all call this ONE helper (§5a pins a single
 *  owner; inlined copies are a drift hazard). Clamps to [0, max_hit_points]
 *  and syncs the HP-derived `unconscious` condition: →0 applies it
 *  idempotently, positive clears it. `target` selects the new-HP expression:
 *  an absolute value, a delta off the current HP, or max_hit_points. */
async function applyHpAndSyncUnconscious(
  c: ClientLike,
  characterId: string,
  target:
    | { readonly kind: 'set'; readonly value: number }
    | { readonly kind: 'delta'; readonly value: number }
    | { readonly kind: 'max' },
): Promise<{ hp: number; maxHp: number }> {
  const expr =
    target.kind === 'set'
      ? 'LEAST(GREATEST($2, 0), max_hit_points)'
      : target.kind === 'delta'
        ? 'LEAST(GREATEST(hit_points + $2, 0), max_hit_points)'
        : 'max_hit_points'
  const params = target.kind === 'max' ? [characterId] : [characterId, target.value]
  const updated = await c.query<{ hit_points: number; max_hit_points: number }>(
    `UPDATE characters
        SET hit_points = ${expr}, updated_at = now()
      WHERE id = $1
    RETURNING hit_points, max_hit_points`,
    params,
  )
  const row = updated.rows[0]
  if (!row) throw new Error('characters.writeHp: no character row')
  if (row.hit_points === 0) {
    // →0: apply unconscious idempotently.
    await c.query(
      `INSERT INTO character_conditions (id, character_id, condition, level)
       VALUES ($1, $2, 'unconscious', NULL)
       ON CONFLICT (character_id, condition) DO NOTHING`,
      [uuidv7(), characterId],
    )
  } else {
    // positive: clear unconscious (HP-derived).
    await c.query(
      `DELETE FROM character_conditions
        WHERE character_id = $1 AND condition = 'unconscious'`,
      [characterId],
    )
  }
  return { hp: row.hit_points, maxHp: row.max_hit_points }
}

// ---------------------------------------------------------------------------
// The binder
// ---------------------------------------------------------------------------

export function charactersLedgerNs(c: ClientLike): LedgerOps {
  return {
    /** Resolve a session participant + its live ledger projection (HP, gold,
     *  hit dice, progression, CON mod). Same found|not_found|ambiguous outcome
     *  shape as findSessionParticipantCharacterByName; exact normalized match. */
    findLedgerCharacterByName: async (sessionId, name): Promise<FindLedgerCharacterResult> => {
      const matches = await c.query<CharacterDbRow>(
        `SELECT ch.* FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
            AND lower(btrim(ch.name)) = lower(btrim($2))`,
        [sessionId, name],
      )
      const [row, ...rest] = matches.rows
      if (!row) return { outcome: 'not_found' }
      if (rest.length > 0) return { outcome: 'ambiguous' }
      const character = toCharacter(row)
      return {
        outcome: 'found',
        projection: {
          character,
          gold: row.gold,
          hitDie: row.hit_die,
          hitDiceRemaining: row.hit_dice_remaining,
          spellcastingProgression: row.spellcasting_progression as SpellcastingProgression,
          conMod: conModifier(character.con),
        },
      }
    },

    debitGold: async (characterId, amount): Promise<DebitGoldResult> => {
      const res = await c.query<{ gold: number }>(
        `UPDATE characters SET gold = gold - $2, updated_at = now()
          WHERE id = $1 AND gold >= $2
        RETURNING gold`,
        [characterId, amount],
      )
      const row = res.rows[0]
      if (row) return { outcome: 'debited', gold: row.gold }
      // Guard failed (or no such character): read the current balance for the
      // binding constraint. One extra read on the rejection path only — never a
      // SELECT-then-UPDATE on the success path.
      const cur = await c.query<{ gold: number }>(`SELECT gold FROM characters WHERE id = $1`, [
        characterId,
      ])
      return { outcome: 'insufficient', gold: cur.rows[0]?.gold ?? 0 }
    },

    creditGold: async (characterId, amount): Promise<number> => {
      const res = await c.query<{ gold: number }>(
        `UPDATE characters SET gold = gold + $2, updated_at = now()
          WHERE id = $1
        RETURNING gold`,
        [characterId, amount],
      )
      const row = res.rows[0]
      if (!row) throw new Error('characters.creditGold: no character row')
      return row.gold
    },

    /** Guard-predicate debit; row RETAINED at 0 (§5). Discriminates
     *  present-but-insufficient (binding) from absent (informational miss). */
    debitItem: async (characterId, name, amount): Promise<DebitItemResult> => {
      const res = await c.query<{ quantity: number }>(
        `UPDATE character_equipment
            SET quantity = quantity - $3
          WHERE character_id = $1 AND lower(btrim(item_name)) = $2 AND quantity >= $3
        RETURNING quantity`,
        [characterId, norm(name), amount],
      )
      const row = res.rows[0]
      if (row) return { outcome: 'debited', quantity: row.quantity }
      // Guard failed: distinguish absent (no row) from insufficient (row, qty < amount).
      const existing = await c.query<{ quantity: number }>(
        `SELECT quantity FROM character_equipment
          WHERE character_id = $1 AND lower(btrim(item_name)) = $2`,
        [characterId, norm(name)],
      )
      const present = existing.rows[0]
      if (!present) return { outcome: 'absent' }
      return { outcome: 'insufficient', quantity: present.quantity }
    },

    acquireItem: async (characterId, name, amount, consumable): Promise<number> => {
      // Conflict target is the §3.1 FUNCTIONAL index expression, not a column
      // list — `ON CONFLICT (character_id, lower(btrim(item_name)))`.
      const res = await c.query<{ quantity: number }>(
        `INSERT INTO character_equipment (id, character_id, item_name, quantity, consumable)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (character_id, lower(btrim(item_name)))
         DO UPDATE SET quantity = character_equipment.quantity + EXCLUDED.quantity
         RETURNING quantity`,
        [uuidv7(), characterId, name, amount, consumable],
      )
      const row = res.rows[0]
      if (!row) throw new Error('characters.acquireItem: upsert returned no row')
      return row.quantity
    },

    /** Guard debit on a tracked feature. Untracked (max_uses NULL) → no counter
     *  to debit: report 'untracked' (resolver treats as a no-counter success). */
    debitFeatureUse: async (characterId, name): Promise<DebitFeatureUseResult> => {
      const res = await c.query<{ uses_remaining: number; recharge: string }>(
        `UPDATE character_features
            SET uses_remaining = uses_remaining - 1
          WHERE character_id = $1 AND lower(btrim(feature_name)) = $2 AND uses_remaining >= 1
        RETURNING uses_remaining, recharge`,
        [characterId, norm(name)],
      )
      const row = res.rows[0]
      if (row) return { outcome: 'debited', usesRemaining: row.uses_remaining, recharge: row.recharge }
      // Guard failed: existence + tracked-ness read for the discriminated arm.
      const existing = await c.query<{ max_uses: number | null; recharge: string }>(
        `SELECT max_uses, recharge FROM character_features
          WHERE character_id = $1 AND lower(btrim(feature_name)) = $2`,
        [characterId, norm(name)],
      )
      const present = existing.rows[0]
      if (!present) return { outcome: 'absent' }
      if (present.max_uses === null) return { outcome: 'untracked' }
      return { outcome: 'exhausted', recharge: present.recharge }
    },

    debitSpellSlot: async (characterId, slotLevel): Promise<DebitSpellSlotResult> => {
      const res = await c.query<{ slots_remaining: number }>(
        `UPDATE character_spell_slots
            SET slots_remaining = slots_remaining - 1
          WHERE character_id = $1 AND slot_level = $2 AND slots_remaining >= 1
        RETURNING slots_remaining`,
        [characterId, slotLevel],
      )
      const row = res.rows[0]
      if (row) return { outcome: 'debited', slotsRemaining: row.slots_remaining }
      return { outcome: 'insufficient' }
    },

    readSpellSlots: async (characterId): Promise<readonly SpellSlotRow[]> => {
      const res = await c.query<{ slot_level: number; slots_max: number; slots_remaining: number }>(
        `SELECT slot_level, slots_max, slots_remaining FROM character_spell_slots
          WHERE character_id = $1 ORDER BY slot_level ASC`,
        [characterId],
      )
      return res.rows.map((r) => ({
        slotLevel: r.slot_level,
        slotsMax: r.slots_max,
        slotsRemaining: r.slots_remaining,
      }))
    },

    /** All of a character's spell rows (name, level, prepared, ritual) — the
     *  cast_spell resolver matches by normalized name + reads the flags. */
    readCharacterSpells: async (characterId): Promise<readonly CharacterSpellRow[]> => {
      const res = await c.query<{
        spell_name: string
        spell_level: number
        prepared: boolean
        ritual: boolean
      }>(
        `SELECT spell_name, spell_level, prepared, ritual FROM character_spells
          WHERE character_id = $1 ORDER BY spell_level ASC, spell_name ASC`,
        [characterId],
      )
      return res.rows.map((r) => ({
        name: r.spell_name,
        level: r.spell_level,
        prepared: r.prepared,
        ritual: r.ritual,
      }))
    },

    /** The §5a HP↔unconscious invariant via the single-owner helper. Clamps to
     *  [0, max_hit_points]; →0 applies `unconscious`, 0→positive clears it.
     *  Multi-statement — must run on a tx-bound client (the resolver opens it). */
    writeHp: async (characterId, newHp): Promise<{ hp: number; maxHp: number }> =>
      applyHpAndSyncUnconscious(c, characterId, { kind: 'set', value: newHp }),

    applyCondition: async (characterId, condition, level): Promise<ConditionWriteResult> => {
      // Upsert; for exhaustion an apply-when-present updates the level. The
      // conditional ON CONFLICT WHERE makes an identical re-apply a true no-op
      // (no row returned) so it emits no frame (§8). A RETURNING row means the
      // INSERT happened OR the level actually changed — both are 'changed'.
      const res = await c.query<{ id: string }>(
        `INSERT INTO character_conditions (id, character_id, condition, level)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (character_id, condition)
         DO UPDATE SET level = EXCLUDED.level, applied_at = now()
           WHERE character_conditions.level IS DISTINCT FROM EXCLUDED.level
         RETURNING id`,
        [uuidv7(), characterId, condition, level],
      )
      return res.rows[0] ? { outcome: 'changed' } : { outcome: 'noop' }
    },

    clearCondition: async (characterId, condition): Promise<ConditionWriteResult> => {
      const res = await c.query(
        `DELETE FROM character_conditions
          WHERE character_id = $1 AND condition = $2`,
        [characterId, condition],
      )
      return (res.rowCount ?? 0) > 0 ? { outcome: 'changed' } : { outcome: 'noop' }
    },

    /** myth-hlydp: the character's active-condition set. Same projection and
     *  ORDER BY as readPartyLedgerSnapshot's per-character conditions read, so
     *  the two sources of `activeConditions` are byte-identical for a given
     *  character state. */
    readConditions: async (characterId): Promise<readonly SnapshotCondition[]> => {
      const res = await c.query<{ condition: string; level: number | null }>(
        `SELECT condition, level FROM character_conditions
          WHERE character_id = $1 ORDER BY condition ASC`,
        [characterId],
      )
      return res.rows.map((r) => ({ condition: r.condition, level: r.level }))
    },

    /** Party-wide short rest — pure writes from the resolver-rolled totals.
     *  HP heal via writeHp (§5a invariant); pact slots restore; short_rest
     *  features restore; hit dice decrement by diceSpent. One transaction (the
     *  resolver binds `c` to a tx client). */
    shortRest: async (sessionId, requests): Promise<void> => {
      const participants = await c.query<{ character_id: string; hit_points: number }>(
        `SELECT ch.id AS character_id, ch.hit_points FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1`,
        [sessionId],
      )
      const byId = new Map(requests.map((r) => [r.characterId, r]))
      for (const p of participants.rows) {
        const req = byId.get(p.character_id)
        if (req && req.diceSpent > 0) {
          await c.query(
            `UPDATE characters SET hit_dice_remaining = hit_dice_remaining - $2, updated_at = now()
              WHERE id = $1`,
            [p.character_id, req.diceSpent],
          )
          // HP heal through the §5a single owner (clamp + unconscious sync).
          await applyHpAndSyncUnconscious(c, p.character_id, {
            kind: 'delta',
            value: req.healTotal,
          })
        }
        // Pact slots + short_rest features restore for EVERY participant.
        await c.query(
          `UPDATE character_spell_slots s
              SET slots_remaining = s.slots_max
             FROM characters ch
            WHERE s.character_id = ch.id AND ch.id = $1
              AND ch.spellcasting_progression = 'pact'`,
          [p.character_id],
        )
        await c.query(
          `UPDATE character_features
              SET uses_remaining = max_uses
            WHERE character_id = $1 AND max_uses IS NOT NULL AND recharge = 'short_rest'`,
          [p.character_id],
        )
      }
    },

    /** Party-wide long rest — full restore. HP→max (clears unconscious via the
     *  §5a invariant), hit-dice regain max(1, floor(level/2)) up to level, all
     *  slots restore, short+long features restore, exhaustion −1 (DELETE at 1). */
    longRest: async (sessionId): Promise<void> => {
      const participants = await c.query<{ character_id: string; level: number }>(
        `SELECT ch.id AS character_id, ch.level FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1`,
        [sessionId],
      )
      for (const p of participants.rows) {
        const regain = Math.max(1, Math.floor(p.level / 2))
        await c.query(
          `UPDATE characters
              SET hit_dice_remaining = LEAST(hit_dice_remaining + $2, level),
                  updated_at = now()
            WHERE id = $1`,
          [p.character_id, regain],
        )
        // HP→max through the §5a single owner — max_hit_points >= 1 (001), so
        // the sync always clears unconscious.
        await applyHpAndSyncUnconscious(c, p.character_id, { kind: 'max' })
        await c.query(
          `UPDATE character_spell_slots SET slots_remaining = slots_max WHERE character_id = $1`,
          [p.character_id],
        )
        await c.query(
          `UPDATE character_features SET uses_remaining = max_uses
            WHERE character_id = $1 AND max_uses IS NOT NULL
              AND recharge IN ('short_rest', 'long_rest')`,
          [p.character_id],
        )
        // Exhaustion −1; the level-1 row DELETEs (the CHECK forbids 0).
        await c.query(
          `DELETE FROM character_conditions
            WHERE character_id = $1 AND condition = 'exhaustion' AND level = 1`,
          [p.character_id],
        )
        await c.query(
          `UPDATE character_conditions SET level = level - 1
            WHERE character_id = $1 AND condition = 'exhaustion' AND level > 1`,
          [p.character_id],
        )
      }
    },

    /** Rest-relevant per-participant numbers (CON mod pre-derived). Same
     *  participant set + JOIN as the rests; the resolver rolls from these. */
    readRestParticipants: async (sessionId): Promise<readonly RestParticipant[]> => {
      const res = await c.query<{
        character_id: string
        name: string
        hit_die: number
        hit_dice_remaining: number
        con: number
      }>(
        `SELECT ch.id AS character_id, ch.name, ch.hit_die, ch.hit_dice_remaining, ch.con
           FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
          ORDER BY sp.joined_at ASC, sp.id ASC`,
        [sessionId],
      )
      return res.rows.map((r) => ({
        characterId: r.character_id,
        name: r.name,
        hitDie: r.hit_die,
        hitDiceRemaining: r.hit_dice_remaining,
        conMod: conModifier(r.con),
      }))
    },

    /** Append-only journal row, written in the SAME tx as the mutation (§10).
     *  ON CONFLICT DO NOTHING on (turn_id, tool_call_id, character_id):
     *  NULL RETURNING ⟹ this exact call already applied (BullMQ redelivery) ⟹
     *  the resolver returns the journaled payload as idempotent success. */
    writeLedgerEvent: async (input): Promise<string | null> => {
      const res = await c.query<{ id: string }>(
        `INSERT INTO ledger_events
           (id, character_id, session_id, turn_id, tool_call_id, tool, delta)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (turn_id, tool_call_id, character_id) DO NOTHING
         RETURNING id`,
        [
          uuidv7(),
          input.characterId,
          input.sessionId,
          input.turnId,
          input.toolCallId,
          input.tool,
          JSON.stringify(input.delta),
        ],
      )
      return res.rows[0]?.id ?? null
    },

    findLedgerEvent: async (turnId, toolCallId, characterId): Promise<boolean> => {
      const res = await c.query<{ one: number }>(
        `SELECT 1 AS one FROM ledger_events
          WHERE turn_id = $1 AND tool_call_id = $2 AND character_id = $3`,
        [turnId, toolCallId, characterId],
      )
      return res.rows.length > 0
    },

    /** §7 per-turn party ledger snapshot — numbers AND nouns. Deterministic
     *  (joined_at, id) order matching listSessionParticipantCharacters. */
    readPartyLedgerSnapshot: async (sessionId): Promise<PartyLedgerSnapshot> => {
      const chars = await c.query<{
        character_id: string
        name: string
        hit_points: number
        max_hit_points: number
        hit_die: number
        hit_dice_remaining: number
        level: number
        gold: number
      }>(
        `SELECT ch.id AS character_id, ch.name, ch.hit_points, ch.max_hit_points,
                ch.hit_die, ch.hit_dice_remaining, ch.level, ch.gold
           FROM session_participants sp
           JOIN characters ch ON ch.id = sp.character_id
          WHERE sp.session_id = $1
          ORDER BY sp.joined_at ASC, sp.id ASC`,
        [sessionId],
      )
      const result: PartyLedgerCharacter[] = []
      for (const row of chars.rows) {
        // SEQUENTIAL awaits, NOT Promise.all: this read runs on a tx-bound
        // client (replay builders, rest payloads, adjust_hp's pre-read), and
        // node-postgres cannot run concurrent queries on a single client —
        // deprecated today, a hard throw in pg@9.
        const slots = await c.query<{ slot_level: number; slots_max: number; slots_remaining: number }>(
          `SELECT slot_level, slots_max, slots_remaining FROM character_spell_slots
            WHERE character_id = $1 ORDER BY slot_level ASC`,
          [row.character_id],
        )
        const conditions = await c.query<{ condition: string; level: number | null }>(
          `SELECT condition, level FROM character_conditions
            WHERE character_id = $1 ORDER BY condition ASC`,
          [row.character_id],
        )
        const features = await c.query<{ feature_name: string; max_uses: number; uses_remaining: number; recharge: string }>(
          `SELECT feature_name, max_uses, uses_remaining, recharge FROM character_features
            WHERE character_id = $1 AND max_uses IS NOT NULL ORDER BY feature_name ASC`,
          [row.character_id],
        )
        const spells = await c.query<{ spell_name: string; spell_level: number; prepared: boolean; ritual: boolean }>(
          `SELECT spell_name, spell_level, prepared, ritual FROM character_spells
            WHERE character_id = $1 ORDER BY spell_level ASC, spell_name ASC`,
          [row.character_id],
        )
        const equipment = await c.query<{ item_name: string; quantity: number; consumable: boolean }>(
          `SELECT item_name, quantity, consumable FROM character_equipment
            WHERE character_id = $1 ORDER BY item_name ASC`,
          [row.character_id],
        )
        result.push({
          characterId: row.character_id,
          name: row.name,
          hitPoints: row.hit_points,
          maxHitPoints: row.max_hit_points,
          hitDie: row.hit_die,
          hitDiceRemaining: row.hit_dice_remaining,
          level: row.level,
          gold: row.gold,
          slots: slots.rows.map((s) => ({
            slotLevel: s.slot_level,
            slotsMax: s.slots_max,
            slotsRemaining: s.slots_remaining,
          })),
          conditions: conditions.rows.map((cd) => ({ condition: cd.condition, level: cd.level })),
          trackedFeatures: features.rows.map((f) => ({
            name: f.feature_name,
            maxUses: f.max_uses,
            usesRemaining: f.uses_remaining,
            recharge: f.recharge,
          })),
          spells: spells.rows.map((sp) => ({
            name: sp.spell_name,
            level: sp.spell_level,
            prepared: sp.prepared,
            ritual: sp.ritual,
          })),
          equipment: equipment.rows.map((e) => ({
            name: e.item_name,
            quantity: e.quantity,
            consumable: e.consumable,
          })),
        })
      }
      return result
    },
  }
}
