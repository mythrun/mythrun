// backend/src/session/rules-lawyer-resources.ts
//
// MYT-70 §5 — the cast / spend / acquire resolvers. The resource side of the
// Rules Lawyer (vitals — hp/condition/rest — live in rules-lawyer-vitals.ts to
// keep both files under the 400-line gate). Each resolver runs its guarded
// mutation + journal write in ONE transaction via `applyWithJournal`; reads
// (character resolution, slot/spell reads) use the pool-bound `deps.ledger`.

import {
  applyWithJournal,
  bindingRejection,
  failSoft,
  informationalMiss,
  norm,
  resolveLedgerCharacter,
  type CharacterSpellRow,
  type LedgerResolution,
  type LedgerUpdatePayload,
  type RulesLawyerDeps,
  type SpellSlotRow,
} from './rules-lawyer.js'
import { makeReplayBuilders } from './rules-lawyer-replay.js'

// ---------------------------------------------------------------------------
// cast_spell
// ---------------------------------------------------------------------------

export interface CastSpellInput {
  readonly character_name: string
  readonly spell_name: string
  /** Deliberate upcast: the exact slot level to consume (1–9). */
  readonly slot_level?: number
  /** Cast as a ritual: skips the slot debit iff the spell is itself a ritual. */
  readonly ritual?: boolean
}

/** The lowest remaining slot level ≥ the spell's level, or null if none. Pure
 *  math over the slot rows — what lets pact casters and "L1 empty, L2 open"
 *  states cast legally without burning loop iterations. */
function lowestCastableSlot(
  slots: readonly SpellSlotRow[],
  spellLevel: number,
): number | null {
  const candidates = slots
    .filter((s) => s.slotLevel >= spellLevel && s.slotsRemaining >= 1)
    .map((s) => s.slotLevel)
    .sort((a, b) => a - b)
  return candidates[0] ?? null
}

/** The currently-castable (prepared) spell names, for the known-but-unprepared
 *  binding constraint. Cantrips are always castable if known. */
function castableList(spells: readonly CharacterSpellRow[]): string {
  const names = spells.filter((s) => s.level === 0 || s.prepared).map((s) => s.name)
  return names.length > 0 ? names.join(', ') : 'none'
}

export async function resolveCastSpell(
  deps: RulesLawyerDeps,
  input: CastSpellInput,
): Promise<LedgerResolution> {
  // 1. character
  const resolved = await resolveLedgerCharacter(deps, input.character_name)
  if (resolved.outcome === 'rejected') return resolved.resolution
  const { character } = resolved.projection
  const characterId = character.id

  // 2. spell known
  let spells: readonly CharacterSpellRow[]
  try {
    spells = await deps.ledger.readCharacterSpells(characterId)
  } catch (err) {
    deps.logger?.warn({ err, characterId }, 'rules-lawyer: readCharacterSpells threw')
    return failSoft()
  }
  const spell = spells.find((s) => norm(s.name) === norm(input.spell_name))
  if (spell === undefined) {
    // Unknown spell → ALWAYS the §6 branch-3 informational miss (there is no
    // environmental fireball).
    return informationalMiss(
      `${character.name} has no spell named "${input.spell_name}" on their sheet. ` +
        `Do not invent a spell; if they never knew it, correct the player gently.`,
    )
  }

  const isCantrip = spell.level === 0

  // 3. castable (prepared) — cantrips always castable; leveled spells must be prepared.
  if (!isCantrip && !spell.prepared) {
    return bindingRejection(
      `${character.name} knows "${spell.name}" but does not have it prepared, so it cannot be ` +
        `cast right now. Currently castable: ${castableList(spells)}.`,
    )
  }

  // 4. ritual handling
  const wantsRitual = input.ritual === true
  if (wantsRitual && !spell.ritual) {
    return informationalMiss(
      `"${spell.name}" is not a ritual spell, so it cannot be cast as a ritual. ` +
        `It can still be cast normally using a spell slot.`,
    )
  }
  const ritualCast = wantsRitual && spell.ritual

  // 5. slot selection
  if (isCantrip) {
    return castNoSlot(deps, characterId, character.name, spell.name, input.slot_level, 'cantrip')
  }
  if (ritualCast) {
    return castNoSlot(deps, characterId, character.name, spell.name, undefined, 'ritual')
  }

  return castWithSlot(deps, characterId, character.name, spell, input.slot_level)
}

/** Select a slot (explicit upcast or lowest-available ≥ spell level) and debit
 *  it + journal in one tx. Split out of resolveCastSpell for the line gate. */
async function castWithSlot(
  deps: RulesLawyerDeps,
  characterId: string,
  characterName: string,
  spell: CharacterSpellRow,
  explicitLevel: number | undefined,
): Promise<LedgerResolution> {
  let slots: readonly SpellSlotRow[]
  try {
    slots = await deps.ledger.readSpellSlots(characterId)
  } catch (err) {
    deps.logger?.warn({ err, characterId }, 'rules-lawyer: readSpellSlots threw')
    return failSoft()
  }

  let targetLevel: number | null
  if (explicitLevel !== undefined) {
    // Explicit upcast: the exact row must have a level ≥ the spell's and a slot left.
    const row = slots.find((s) => s.slotLevel === explicitLevel)
    targetLevel =
      explicitLevel >= spell.level && row !== undefined && row.slotsRemaining >= 1
        ? explicitLevel
        : null
  } else {
    targetLevel = lowestCastableSlot(slots, spell.level)
  }
  if (targetLevel === null) {
    return bindingRejection(
      `${characterName} has no remaining spell slot of level ${String(spell.level)} or higher ` +
        `to cast "${spell.name}".`,
    )
  }

  const debitLevel = targetLevel
  return applyWithJournal(
    deps,
    characterId,
    'cast_spell',
    async (tx) => {
      const res = await tx.debitSpellSlot(characterId, debitLevel)
      if (res.outcome === 'insufficient') {
        // Lost the race between read and debit — treat as binding (no slot left).
        return {
          applied: false,
          resolution: bindingRejection(
            `${characterName} has no remaining level-${String(debitLevel)} spell slot ` +
              `to cast "${spell.name}".`,
          ),
        }
      }
      const payload: LedgerUpdatePayload = {
        characterName,
        kind: 'spell_slot',
        summary:
          `${characterName} casts ${spell.name} using a level-${String(debitLevel)} slot ` +
          `(${String(res.slotsRemaining)} of that level remaining).`,
        slotLevel: debitLevel,
        slotsRemaining: res.slotsRemaining,
      }
      return {
        applied: true,
        payload,
        delta: { spell: spell.name, slotLevel: debitLevel, slotsRemaining: res.slotsRemaining },
      }
    },
    (tx) =>
      makeReplayBuilders(deps.sessionId).slotPayload(
        tx,
        characterId,
        characterName,
        spell.name,
        debitLevel,
      ),
  )
}

/** A cast that consumes no slot (cantrip or ritual). Still journals the cast.
 *  A spurious `slot_level` on a cantrip is ignored and noted in the summary. */
async function castNoSlot(
  deps: RulesLawyerDeps,
  characterId: string,
  characterName: string,
  spellName: string,
  spuriousSlotLevel: number | undefined,
  reason: 'cantrip' | 'ritual',
): Promise<LedgerResolution> {
  const note =
    reason === 'cantrip'
      ? spuriousSlotLevel !== undefined
        ? ` (cantrips do not consume spell slots; the requested slot level was ignored)`
        : ` (cantrips do not consume spell slots)`
      : ` (cast as a ritual — no spell slot consumed)`
  const summary = `${characterName} casts ${spellName}.${note}`
  return applyWithJournal(
    deps,
    characterId,
    'cast_spell',
    () =>
      Promise.resolve({
        applied: true,
        payload: { characterName, kind: 'spell_slot', summary },
        delta: { spell: spellName, slotConsumed: false, reason },
      }),
    () => Promise.resolve({ characterName, kind: 'spell_slot', summary }),
  )
}

// ---------------------------------------------------------------------------
// spend_resource
// ---------------------------------------------------------------------------

export type SpendResourceInput =
  | { readonly kind: 'gold'; readonly character_name: string; readonly amount: number }
  | { readonly kind: 'item'; readonly character_name: string; readonly name: string; readonly amount?: number }
  | { readonly kind: 'feature'; readonly character_name: string; readonly name: string }

export async function resolveSpendResource(
  deps: RulesLawyerDeps,
  input: SpendResourceInput,
): Promise<LedgerResolution> {
  const resolved = await resolveLedgerCharacter(deps, input.character_name)
  if (resolved.outcome === 'rejected') return resolved.resolution
  const { name: characterName, id: characterId } = resolved.projection.character

  if (input.kind === 'gold') return spendGold(deps, characterId, characterName, input.amount)
  if (input.kind === 'item') {
    return spendItem(deps, characterId, characterName, input.name, input.amount ?? 1)
  }
  return spendFeature(deps, characterId, characterName, input.name)
}

async function spendGold(
  deps: RulesLawyerDeps,
  characterId: string,
  characterName: string,
  amount: number,
): Promise<LedgerResolution> {
  return applyWithJournal(
    deps,
    characterId,
    'spend_resource',
    async (tx) => {
      const res = await tx.debitGold(characterId, amount)
      if (res.outcome === 'insufficient') {
        return {
          applied: false,
          resolution: bindingRejection(
            `${characterName} has only ${String(res.gold)} gold and cannot spend ` +
              `${String(amount)}.`,
          ),
        }
      }
      const payload: LedgerUpdatePayload = {
        characterName,
        kind: 'gold',
        summary: `${characterName} spends ${String(amount)} gold (${String(res.gold)} remaining).`,
        gold: res.gold,
      }
      return { applied: true, payload, delta: { spent: amount, gold: res.gold } }
    },
    (tx) => makeReplayBuilders(deps.sessionId).goldPayload(tx, characterId, characterName),
  )
}

async function spendItem(
  deps: RulesLawyerDeps,
  characterId: string,
  characterName: string,
  itemName: string,
  amount: number,
): Promise<LedgerResolution> {
  return applyWithJournal(
    deps,
    characterId,
    'spend_resource',
    async (tx) => {
      const res = await tx.debitItem(characterId, itemName, amount)
      if (res.outcome === 'absent') {
        // §6 informational MISS — no row. The three-branch guidance lets the FT
        // narrate environmental objects / credit a fiction-granted item / correct.
        return {
          applied: false,
          resolution: informationalMiss(
            `${characterName} has no "${itemName}" tracked in their inventory. If it is an ` +
              `improvised or environmental object, narrate it freely. If the fiction already ` +
              `granted it, call acquire_resource first, then proceed. Otherwise correct gently.`,
          ),
        }
      }
      if (res.outcome === 'insufficient') {
        return {
          applied: false,
          resolution: bindingRejection(
            `${characterName} has only ${String(res.quantity)} "${itemName}" and cannot use ` +
              `${String(amount)}.`,
          ),
        }
      }
      const payload: LedgerUpdatePayload = {
        characterName,
        kind: 'item',
        summary:
          `${characterName} uses ${String(amount)} "${itemName}" ` +
          `(${String(res.quantity)} remaining).`,
        itemName,
        quantity: res.quantity,
      }
      return { applied: true, payload, delta: { item: itemName, spent: amount, quantity: res.quantity } }
    },
    (tx) => makeReplayBuilders(deps.sessionId).itemPayload(tx, characterId, characterName, itemName),
  )
}

async function spendFeature(
  deps: RulesLawyerDeps,
  characterId: string,
  characterName: string,
  featureName: string,
): Promise<LedgerResolution> {
  return applyWithJournal(
    deps,
    characterId,
    'spend_resource',
    async (tx) => {
      const res = await tx.debitFeatureUse(characterId, featureName)
      if (res.outcome === 'absent') {
        return {
          applied: false,
          resolution: informationalMiss(
            `${characterName} has no feature named "${featureName}". If it was never an ` +
              `established ability, correct gently.`,
          ),
        }
      }
      if (res.outcome === 'exhausted') {
        return {
          applied: false,
          resolution: bindingRejection(
            `${characterName} has no uses of "${featureName}" left; it recharges on a ` +
              `${rechargeLabel(res.recharge)}.`,
          ),
        }
      }
      if (res.outcome === 'untracked') {
        // No counter — an at-will feature; success, nothing to itemize.
        const summary = `${characterName} uses ${featureName}.`
        return {
          applied: true,
          payload: { characterName, kind: 'feature', summary, featureName },
          delta: { feature: featureName, tracked: false },
        }
      }
      const payload: LedgerUpdatePayload = {
        characterName,
        kind: 'feature',
        summary:
          `${characterName} uses ${featureName} ` +
          `(${String(res.usesRemaining)} use(s) remaining).`,
        featureName,
        usesRemaining: res.usesRemaining,
      }
      return {
        applied: true,
        payload,
        delta: { feature: featureName, usesRemaining: res.usesRemaining },
      }
    },
    (tx) =>
      makeReplayBuilders(deps.sessionId).featurePayload(tx, characterId, characterName, featureName),
  )
}

function rechargeLabel(recharge: string): string {
  return recharge === 'short_rest'
    ? 'short rest'
    : recharge === 'long_rest'
      ? 'long rest'
      : 'rest'
}

// ---------------------------------------------------------------------------
// acquire_resource
// ---------------------------------------------------------------------------

export type AcquireResourceInput =
  | { readonly kind: 'gold'; readonly character_name: string; readonly amount: number }
  | {
      readonly kind: 'item'
      readonly character_name: string
      readonly name: string
      readonly amount?: number
      readonly consumable?: boolean
    }

export async function resolveAcquireResource(
  deps: RulesLawyerDeps,
  input: AcquireResourceInput,
): Promise<LedgerResolution> {
  const resolved = await resolveLedgerCharacter(deps, input.character_name)
  if (resolved.outcome === 'rejected') return resolved.resolution
  const { name: characterName, id: characterId } = resolved.projection.character

  if (input.kind === 'gold') {
    return applyWithJournal(
      deps,
      characterId,
      'acquire_resource',
      async (tx) => {
        const gold = await tx.creditGold(characterId, input.amount)
        const payload: LedgerUpdatePayload = {
          characterName,
          kind: 'gold',
          summary:
            `${characterName} gains ${String(input.amount)} gold (${String(gold)} total).`,
          gold,
        }
        return { applied: true, payload, delta: { gained: input.amount, gold } }
      },
      (tx) => makeReplayBuilders(deps.sessionId).goldPayload(tx, characterId, characterName),
    )
  }

  const amount = input.amount ?? 1
  const consumable = input.consumable ?? false
  return applyWithJournal(
    deps,
    characterId,
    'acquire_resource',
    async (tx) => {
      const quantity = await tx.acquireItem(characterId, input.name, amount, consumable)
      const payload: LedgerUpdatePayload = {
        characterName,
        kind: 'item',
        summary:
          `${characterName} gains ${String(amount)} "${input.name}" ` +
          `(${String(quantity)} total).`,
        itemName: input.name,
        quantity,
      }
      return { applied: true, payload, delta: { item: input.name, gained: amount, quantity } }
    },
    (tx) => makeReplayBuilders(deps.sessionId).itemPayload(tx, characterId, characterName, input.name),
  )
}
