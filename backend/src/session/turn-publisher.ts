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
import type {
  ParticipantSummary,
  ServerFrame,
  SessionProgress,
} from '../contract/session-events.js'
import type {
  CombatResolvedFramePayload,
  CombatStartedFramePayload,
  DiceRollFramePayload,
  DmCorrectionFramePayload,
  LedgerUpdatePayload,
  ModeChangeFramePayload,
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
  modeChange(campaignId: string, turnId: string, p: ModeChangeFramePayload): Promise<void>
  combatStarted(campaignId: string, turnId: string, p: CombatStartedFramePayload): Promise<void>
  combatResolved(campaignId: string, turnId: string, p: CombatResolvedFramePayload): Promise<void>
  dmCorrection(campaignId: string, turnId: string, p: DmCorrectionFramePayload): Promise<void>
  /** myth-nu0hm — `progress` is the OPTIONAL mechanical session-progress
   *  fraction. Omitted when the turn couldn't compute one; the frame still
   *  ships, because turn_end is what tells the client the turn is over. */
  turnEnd(campaignId: string, turnId: string, progress?: SessionProgress): Promise<void>
  turnError(campaignId: string, turnId: string, message: string): Promise<void>
  /** myth-aiiao — the corrected-turn WHOLE-TURN REPLACE: publish a live
   *  `session_reconnect` frame carrying ONE turn's rebuilt replay messages.
   *  The client's transcript reducer already does a per-turnId whole-turn
   *  replace over any reconnect batch (prune items with the batch's turnIds,
   *  re-fold the batch), so the same frame kind repairs a live client whose
   *  streamed attempt 1 diverged from the persisted audit-corrected retry —
   *  no new frame kind, no codec registration. `messages` MUST be the turn's
   *  persisted rows mapped through rowToReplayFrame (seq-bearing), so the
   *  client's high-water mark advances exactly as a real reconnect would. */
  turnReplace(
    campaignId: string,
    messages: readonly ServerFrame[],
    participants: readonly ParticipantSummary[],
    mode: 'exploration' | 'combat',
  ): Promise<void>
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
      // restType rides ONLY the live kind:'rest' frame (myth-lhp99) — the play
      // surface's wind-down signal. Not persisted, so the replay row never
      // reconstructs it (a past rest must not re-pop the offer).
      ...(p.restType !== undefined ? { restType: p.restType } : {}),
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
      // myth-hlydp: copied element-by-element (a fresh object per entry) so the
      // published frame never aliases the resolver's snapshot rows — same rule
      // the combat frames below follow for their array fields.
      ...(p.activeConditions !== undefined
        ? {
            activeConditions: p.activeConditions.map((a) => ({
              condition: a.condition,
              level: a.level,
            })),
          }
        : {}),
      ...(p.diceRolled !== undefined ? { diceRolled: [...p.diceRolled] } : {}),
    })
  }

  // MYT-75 combat L1. Built field-by-field from the payload + turnId — never a
  // spread-with-cast, so the wire frame's exact field list (per
  // contract/session-events.ts) is checked at compile time. Array fields are
  // copied (`.map` to a fresh per-element object) so the published frame never
  // aliases the caller's ReadonlyArray. Live frames carry NO seq.
  async function modeChange(
    campaignId: string,
    turnId: string,
    p: ModeChangeFramePayload,
  ): Promise<void> {
    await publish(campaignId, {
      type: 'mode_change',
      turnId,
      from: p.from,
      to: p.to,
      reason: p.reason,
    })
  }

  async function combatStarted(
    campaignId: string,
    turnId: string,
    p: CombatStartedFramePayload,
  ): Promise<void> {
    await publish(campaignId, {
      type: 'combat_started',
      turnId,
      enemies: p.enemies.map((e) => ({ name: e.name, description: e.description, count: e.count })),
      initiative: p.initiative.map((i) => ({ combatant: i.combatant, roll: i.roll })),
    })
  }

  async function combatResolved(
    campaignId: string,
    turnId: string,
    p: CombatResolvedFramePayload,
  ): Promise<void> {
    await publish(campaignId, {
      type: 'combat_resolved',
      turnId,
      narration: p.narration,
      outcome: p.outcome,
      casualties: p.casualties.map((c) => ({ name: c.name, type: c.type, fate: c.fate })),
      hpChanges: p.hpChanges.map((h) => ({
        combatant: h.combatant,
        hpBefore: h.hpBefore,
        hpAfter: h.hpAfter,
        maxHp: h.maxHp,
      })),
    })
  }

  // myth-d6knq §correction-channel — a structured DM correction. SHARED CONTRACT
  // with the frontend rendering: the wire frame is exactly
  // `{ type: 'dm_correction', turnId, text }` (a live frame carries NO seq — the
  // seq rides only the persisted dm_correction replay row).
  async function dmCorrection(
    campaignId: string,
    turnId: string,
    p: DmCorrectionFramePayload,
  ): Promise<void> {
    await publish(campaignId, { type: 'dm_correction', turnId, text: p.text })
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
    modeChange,
    combatStarted,
    combatResolved,
    dmCorrection,
    async turnEnd(campaignId, turnId, progress): Promise<void> {
      // exactOptionalPropertyTypes — conditionally spread so the key is ABSENT
      // when there is no fraction, never present-with-undefined. Rebuilt
      // field-by-field (not passed through) so the wire shape stays checked.
      await publish(campaignId, {
        type: 'turn_end',
        turnId,
        ...(progress !== undefined ? { progress: { fraction: progress.fraction } } : {}),
      })
    },
    async turnError(campaignId, turnId, message): Promise<void> {
      await publish(campaignId, { type: 'turn_error', turnId, message })
    },
    async turnReplace(campaignId, messages, participants, mode): Promise<void> {
      await publish(campaignId, {
        type: 'session_reconnect',
        messages: [...messages],
        participants: [...participants],
        mode,
      })
    },
    emitFor(campaignId, turnId): TurnEmitter {
      return {
        emitText: (text: string): Promise<void> => textDelta(campaignId, turnId, text),
        emitSkillCheck: (p: SkillCheckFramePayload): Promise<void> =>
          skillCheck(campaignId, turnId, p),
        emitDiceRoll: (p: DiceRollFramePayload): Promise<void> => diceRoll(campaignId, turnId, p),
        emitLedgerUpdate: (p: LedgerUpdatePayload): Promise<void> =>
          ledgerUpdate(campaignId, turnId, p),
        emitModeChange: (p: ModeChangeFramePayload): Promise<void> =>
          modeChange(campaignId, turnId, p),
        emitCombatStarted: (p: CombatStartedFramePayload): Promise<void> =>
          combatStarted(campaignId, turnId, p),
        emitCombatResolved: (p: CombatResolvedFramePayload): Promise<void> =>
          combatResolved(campaignId, turnId, p),
        emitCorrection: (p: DmCorrectionFramePayload): Promise<void> =>
          dmCorrection(campaignId, turnId, p),
      }
    },
  }
}
