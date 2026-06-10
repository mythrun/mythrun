// backend/src/session/turn-publisher.ts
//
// MYT-66 Task 6 / MYT-68 Task 7 — the cross-process turn frame publisher.
//
// The turn worker is a DIFFERENT process from the SessionHub (sse/ws fan-out):
// it has no in-memory socket registry, so it streams a turn by PUBLISHing the
// DM-turn frames to the per-campaign channel. The MYT-66 set is
// `dm_thinking`/`text_delta`/`turn_end`/`turn_error`; MYT-68 adds the
// mechanical frames `skill_check`/`dice_roll` the FastThinker tool loop emits.
// The SessionHub PSUBSCRIBEs the pattern and fans each frame out to the
// locally-registered sockets. Both sides derive the channel string from
// `../contract/session-channel.js` (a re-derived string that drifts would
// silently fan out to nobody).
//
// Every frame carries the `turnId` (H2): it is stable across BullMQ
// redeliveries, so a client dedups a re-streamed turn on it. These live frames
// are intra-turn / control frames and carry NO seq (the seq is assigned only
// on the persisted session_messages row, replayed on reconnect).

import type { Redis } from 'ioredis'
import { sessionChannel } from '../contract/session-channel.js'
import type { ServerFrame } from '../contract/session-events.js'
import type {
  DiceRollFramePayload,
  LedgerUpdatePayload,
  SkillCheckFramePayload,
  TurnEmitter,
} from './tiers/types.js'

/**
 * Publishes the DM-turn streaming + mechanical frames for a turn
 * cross-container. The worker holds one instance for the life of the process;
 * each method targets a specific (campaign, turn). `emitFor` binds a
 * `TurnEmitter` the Fast Thinker streams every player-visible frame through
 * (the FT seam stays frame-agnostic — see `tiers/types.ts`).
 */
export interface TurnPublisher {
  dmThinking(campaignId: string, turnId: string): Promise<void>
  textDelta(campaignId: string, turnId: string, text: string): Promise<void>
  skillCheck(campaignId: string, turnId: string, p: SkillCheckFramePayload): Promise<void>
  diceRoll(campaignId: string, turnId: string, p: DiceRollFramePayload): Promise<void>
  ledgerUpdate(campaignId: string, turnId: string, p: LedgerUpdatePayload): Promise<void>
  turnEnd(campaignId: string, turnId: string): Promise<void>
  turnError(campaignId: string, turnId: string, message: string): Promise<void>
  /** A frame emitter bound to one (campaign, turn) for the Fast Thinker. */
  emitFor(campaignId: string, turnId: string): TurnEmitter
}

export function createTurnPublisher(redis: Redis, keyPrefix: string): TurnPublisher {
  async function publish(campaignId: string, frame: ServerFrame): Promise<void> {
    await redis.publish(sessionChannel(keyPrefix, campaignId), JSON.stringify(frame))
  }

  // Built field-by-field from the payload + turnId — never a spread-with-cast,
  // so the wire frame's exact field list (per contract/session-events.ts) is
  // checked at compile time. Live frames carry NO seq.
  async function skillCheck(
    campaignId: string,
    turnId: string,
    p: SkillCheckFramePayload,
  ): Promise<void> {
    await publish(campaignId, {
      type: 'skill_check',
      turnId,
      characterName: p.characterName,
      skill: p.skill,
      context: p.context,
      roll: p.roll,
      roll2: p.roll2,
      rollType: p.rollType,
      modifier: p.modifier,
      total: p.total,
      dc: p.dc,
      outcomeTier: p.outcomeTier,
      constraint: p.constraint,
    })
  }

  async function diceRoll(
    campaignId: string,
    turnId: string,
    p: DiceRollFramePayload,
  ): Promise<void> {
    await publish(campaignId, {
      type: 'dice_roll',
      turnId,
      count: p.count,
      sides: p.sides,
      results: [...p.results],
      total: p.total,
    })
  }

  // §8 ledger_update. Built field-by-field from the LedgerUpdatePayload — the
  // optional value fields are conditional-spread (only the kind-relevant ones
  // are populated; `exactOptionalPropertyTypes` forbids an explicit `undefined`).
  // A live streamed frame carries NO seq (seq rides only the persisted replay row,
  // reconstructed by ws-session's parseLedgerUpdateRow). Mirrors the replay-side
  // payloadToLedgerFrame field-by-field map.
  async function ledgerUpdate(
    campaignId: string,
    turnId: string,
    p: LedgerUpdatePayload,
  ): Promise<void> {
    await publish(campaignId, {
      type: 'ledger_update',
      turnId,
      characterName: p.characterName,
      kind: p.kind,
      summary: p.summary,
      ...(p.hp !== undefined ? { hp: p.hp } : {}),
      ...(p.maxHp !== undefined ? { maxHp: p.maxHp } : {}),
      ...(p.gold !== undefined ? { gold: p.gold } : {}),
      ...(p.slotLevel !== undefined ? { slotLevel: p.slotLevel } : {}),
      ...(p.slotsRemaining !== undefined ? { slotsRemaining: p.slotsRemaining } : {}),
      ...(p.itemName !== undefined ? { itemName: p.itemName } : {}),
      ...(p.quantity !== undefined ? { quantity: p.quantity } : {}),
      ...(p.featureName !== undefined ? { featureName: p.featureName } : {}),
      ...(p.usesRemaining !== undefined ? { usesRemaining: p.usesRemaining } : {}),
      ...(p.condition !== undefined ? { condition: p.condition } : {}),
      ...(p.diceRolled !== undefined ? { diceRolled: [...p.diceRolled] } : {}),
    })
  }

  async function textDelta(campaignId: string, turnId: string, text: string): Promise<void> {
    await publish(campaignId, { type: 'text_delta', turnId, text })
  }

  return {
    async dmThinking(campaignId, turnId): Promise<void> {
      await publish(campaignId, { type: 'dm_thinking', turnId })
    },
    textDelta,
    skillCheck,
    diceRoll,
    ledgerUpdate,
    async turnEnd(campaignId, turnId): Promise<void> {
      await publish(campaignId, { type: 'turn_end', turnId })
    },
    async turnError(campaignId, turnId, message): Promise<void> {
      await publish(campaignId, { type: 'turn_error', turnId, message })
    },
    emitFor(campaignId, turnId): TurnEmitter {
      return {
        emitText: (text: string): Promise<void> => textDelta(campaignId, turnId, text),
        emitSkillCheck: (p: SkillCheckFramePayload): Promise<void> =>
          skillCheck(campaignId, turnId, p),
        emitDiceRoll: (p: DiceRollFramePayload): Promise<void> => diceRoll(campaignId, turnId, p),
        emitLedgerUpdate: (p: LedgerUpdatePayload): Promise<void> =>
          ledgerUpdate(campaignId, turnId, p),
      }
    },
  }
}
