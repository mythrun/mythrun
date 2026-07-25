// backend/src/session/rules-lawyer-replay.ts
//
// MYT-70 §10 — idempotent-replay payload builders. On a BullMQ redelivery of an
// in-flight turn job, `applyWithJournal` finds the journal row already present
// and short-circuits to one of these builders WITHOUT re-running the guarded
// mutation. Each reads the CURRENT post-mutation state fresh from the tx client
// so the frame the FT consume loop emits stays truthful. Shared by the resource
// resolvers and (T9) the vitals resolvers.

import { norm, type LedgerOps, type LedgerUpdatePayload } from './rules-lawyer.js'

export interface ReplayBuilders {
  /** The current HP/maxHP, for an idempotent `adjust_hp` replay — reports the
   *  post-mutation values without re-applying the delta. */
  hpPayload(tx: LedgerOps, characterId: string, characterName: string): Promise<LedgerUpdatePayload>
  goldPayload(tx: LedgerOps, characterId: string, characterName: string): Promise<LedgerUpdatePayload>
  itemPayload(
    tx: LedgerOps,
    characterId: string,
    characterName: string,
    itemName: string,
  ): Promise<LedgerUpdatePayload>
  featurePayload(
    tx: LedgerOps,
    characterId: string,
    characterName: string,
    featureName: string,
  ): Promise<LedgerUpdatePayload>
  slotPayload(
    tx: LedgerOps,
    characterId: string,
    characterName: string,
    spellName: string,
    slotLevel: number,
  ): Promise<LedgerUpdatePayload>
}

export function makeReplayBuilders(sessionId: string): ReplayBuilders {
  return {
    hpPayload: async (tx, characterId, characterName) => {
      const row = (await tx.readPartyLedgerSnapshot(sessionId)).find(
        (c) => c.characterId === characterId,
      )
      const hp = row?.hitPoints ?? 0
      const maxHp = row?.maxHitPoints ?? 0
      return {
        characterName,
        kind: 'hp',
        summary: `${characterName}'s hit points are already at ${String(hp)}/${String(maxHp)} (no change).`,
        hp,
        maxHp,
        // myth-hlydp: the replayed hp payload states the same authoritative set
        // the live one does, so a redelivery converges on identical client
        // state. Reused from the snapshot already read — no extra query.
        activeConditions: row?.conditions ?? [],
      }
    },
    goldPayload: async (tx, _characterId, characterName) => {
      const r = await tx.findLedgerCharacterByName(sessionId, characterName)
      const gold = r.outcome === 'found' ? r.projection.gold : 0
      return {
        characterName,
        kind: 'gold',
        summary: `${characterName}'s gold is already at ${String(gold)} (no change).`,
        gold,
      }
    },
    itemPayload: async (tx, characterId, characterName, itemName) => {
      const row = (await tx.readPartyLedgerSnapshot(sessionId)).find(
        (c) => c.characterId === characterId,
      )
      const item = row?.equipment.find((e) => norm(e.name) === norm(itemName))
      return {
        characterName,
        kind: 'item',
        summary:
          `${characterName}'s "${itemName}" is already at ${String(item?.quantity ?? 0)} ` +
          `(no change).`,
        itemName,
        quantity: item?.quantity ?? 0,
      }
    },
    featurePayload: async (tx, characterId, characterName, featureName) => {
      const row = (await tx.readPartyLedgerSnapshot(sessionId)).find(
        (c) => c.characterId === characterId,
      )
      const feat = row?.trackedFeatures.find((f) => norm(f.name) === norm(featureName))
      return {
        characterName,
        kind: 'feature',
        summary: `${characterName}'s ${featureName} was already used this turn (no change).`,
        featureName,
        ...(feat !== undefined ? { usesRemaining: feat.usesRemaining } : {}),
      }
    },
    slotPayload: async (tx, characterId, characterName, spellName, slotLevel) => {
      const slots = await tx.readSpellSlots(characterId)
      const slotRow = slots.find((s) => s.slotLevel === slotLevel)
      return {
        characterName,
        kind: 'spell_slot',
        summary: `${characterName} already cast ${spellName} this turn (no change).`,
        slotLevel,
        slotsRemaining: slotRow?.slotsRemaining ?? 0,
      }
    },
  }
}
