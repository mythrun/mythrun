// backend/src/session/rules-lawyer-vitals.ts
//
// MYT-70 §5/§5a/§9.2 — the adjust_hp / update_condition / take_rest resolvers.
// The vitals side of the Rules Lawyer (resources — cast/spend/acquire — live in
// rules-lawyer-resources.ts; both split off rules-lawyer.ts to stay under the
// 400-line gate). All dice are rolled by the deterministic engine INSIDE the
// resolver (Principle #4); the §5a HP↔unconscious invariant is owned by
// `LedgerOps.writeHp` and the rest writes, so the resolver never touches the
// `unconscious` flag directly. Each mutation + its `ledger_events` journal row
// commit in ONE transaction (§10).

import {
  applyWithJournal,
  failSoft,
  resolveLedgerCharacter,
  type LedgerResolution,
  type LedgerUpdatePayload,
  type RulesLawyerDeps,
} from './rules-lawyer.js'
import { makeReplayBuilders } from './rules-lawyer-replay.js'
import { rollDice, STANDARD_DICE, type Rng } from './dice/engine.js'
import type { ConditionName, LedgerOps, RestParticipant } from '../repo/characters-ledger.js'

// ---------------------------------------------------------------------------
// adjust_hp
// ---------------------------------------------------------------------------

export interface AdjustHpInput {
  readonly character_name: string
  readonly kind: 'damage' | 'heal'
  /** Fixed magnitude. EXACTLY ONE of `amount`/`dice` (resolver-enforced). */
  readonly amount?: number
  /** Dice expression (e.g. "2d4+2"), rolled by the engine in the resolver. */
  readonly dice?: string
}

/** A parsed dice expression. Mechanical computation (ZFC-exempt). */
interface ParsedDice {
  readonly count: number
  readonly sides: number
  readonly modifier: number
}

const DICE_EXPR = /^(\d+)d(\d+)([+-]\d+)?$/

/** Parse "NdM[+/-K]" → {count, sides, modifier} or null (out-of-shape /
 *  non-standard die). A null is an infra-class fail-soft, not a game rule.
 *  The regex guarantees `count` is digits (absurd digit runs overflow to
 *  Infinity and are rejected by the engine's own bounds check). */
function parseDiceExpr(expr: string): ParsedDice | null {
  const m = DICE_EXPR.exec(expr.trim())
  if (!m) return null
  const count = Number(m[1])
  const sides = Number(m[2])
  const modifier = m[3] ? Number(m[3]) : 0
  if (!(STANDARD_DICE as readonly number[]).includes(sides)) return null
  if (count < 1) return null
  return { count, sides, modifier }
}

/** Resolve the signed HP delta from EXACTLY-ONE-OF amount/dice. Returns the
 *  rolled faces (for the payload) or null on any out-of-shape input. */
function resolveHpDelta(
  input: AdjustHpInput,
  rng: Rng | undefined,
): { magnitude: number; diceRolled: readonly number[] } | null {
  const { amount, dice } = input
  if (amount !== undefined && dice !== undefined) return null // both → fail-soft
  if (amount !== undefined) {
    if (!Number.isInteger(amount) || amount < 1) return null
    return { magnitude: amount, diceRolled: [] }
  }
  if (dice === undefined) return null // neither → fail-soft
  const parsed = parseDiceExpr(dice)
  if (!parsed) return null
  let rolled: { results: number[]; total: number }
  try {
    rolled = rollDice(parsed.count, parsed.sides, rng)
  } catch {
    return null // engine rejected (bounds / non-standard) — fail-soft
  }
  const magnitude = Math.max(0, rolled.total + parsed.modifier)
  return { magnitude, diceRolled: rolled.results }
}

export async function resolveAdjustHp(
  deps: RulesLawyerDeps,
  input: AdjustHpInput,
): Promise<LedgerResolution> {
  const resolved = await resolveLedgerCharacter(deps, input.character_name)
  if (resolved.outcome === 'rejected') return resolved.resolution
  const { id: characterId, name: characterName } = resolved.projection.character

  const delta = resolveHpDelta(input, deps.rng)
  if (delta === null) {
    deps.logger?.warn(
      { characterId, kind: input.kind, hasAmount: input.amount !== undefined, hasDice: input.dice !== undefined },
      'rules-lawyer: adjust_hp invalid magnitude (XOR / dice parse)',
    )
    return failSoft()
  }
  const signed = input.kind === 'damage' ? -delta.magnitude : delta.magnitude
  const diceRolled = delta.diceRolled

  return applyWithJournal(
    deps,
    characterId,
    'adjust_hp',
    async (tx) => {
      const before = await readHp(tx, deps.sessionId, characterId)
      const { hp, maxHp } = await tx.writeHp(characterId, before + signed)
      const collapsed = hp === 0
      const verb = input.kind === 'damage' ? 'takes' : 'recovers'
      const summary =
        `${characterName} ${verb} ${String(delta.magnitude)} ` +
        `${input.kind === 'damage' ? 'damage' : 'hit points'} (now ${String(hp)}/${String(maxHp)} HP)` +
        (collapsed ? ' and collapses, falling unconscious.' : '.')
      const payload: LedgerUpdatePayload = {
        characterName,
        kind: 'hp',
        summary,
        hp,
        maxHp,
        ...(diceRolled.length > 0 ? { diceRolled } : {}),
      }
      return {
        applied: true,
        payload,
        delta: { kind: input.kind, magnitude: delta.magnitude, hp, diceRolled },
      }
    },
    (tx) => makeReplayBuilders(deps.sessionId).hpPayload(tx, characterId, characterName),
  )
}

/** Current HP for the pre-write delta. Reads the snapshot row through the tx
 *  client so it reflects in-flight changes; throws fail-soft up if absent. */
async function readHp(tx: LedgerOps, sessionId: string, characterId: string): Promise<number> {
  const row = (await tx.readPartyLedgerSnapshot(sessionId)).find((c) => c.characterId === characterId)
  if (!row) throw new Error(`adjust_hp: no snapshot row for ${characterId}`)
  return row.hitPoints
}

// ---------------------------------------------------------------------------
// update_condition
// ---------------------------------------------------------------------------

export interface UpdateConditionInput {
  readonly character_name: string
  readonly condition: ConditionName
  readonly action: 'apply' | 'clear'
  /** Required iff exhaustion (structural mismatch → fail-soft). */
  readonly level?: number
}

/** The condition result carries `changed` so the consume loop maps an
 *  idempotent no-op (clear-when-absent / apply-identical) to NO frame (§8). */
export interface ConditionPayload extends LedgerUpdatePayload {
  readonly changed: boolean
}

export type ConditionResolution =
  | { readonly ok: true; readonly payload: ConditionPayload }
  | { readonly ok: false; readonly binding: boolean; readonly found: boolean; readonly constraint: string }

export async function resolveUpdateCondition(
  deps: RulesLawyerDeps,
  input: UpdateConditionInput,
): Promise<ConditionResolution> {
  // Structural validation (ZFC-exempt): level required iff exhaustion.
  const isExhaustion = input.condition === 'exhaustion'
  const hasLevel = input.level !== undefined
  if (input.action === 'apply' && isExhaustion !== hasLevel) {
    deps.logger?.warn(
      { condition: input.condition, hasLevel },
      'rules-lawyer: update_condition level/exhaustion mismatch',
    )
    return failSoftCondition()
  }
  if (input.action === 'clear' && hasLevel) {
    // A level on a clear is meaningless — structural mismatch, fail-soft.
    deps.logger?.warn({ condition: input.condition }, 'rules-lawyer: update_condition clear with level')
    return failSoftCondition()
  }

  const resolved = await resolveLedgerCharacter(deps, input.character_name)
  if (resolved.outcome === 'rejected') return rejection(resolved.resolution)
  const { id: characterId, name: characterName, hitPoints } = resolved.projection.character

  // §5a single-owner: clearing unconscious while HP is 0 is binding — the
  // condition is HP-derived; heal them first.
  if (input.action === 'clear' && input.condition === 'unconscious' && hitPoints === 0) {
    return {
      ok: false,
      binding: true,
      found: true,
      constraint:
        `${characterName} cannot be roused while at 0 HP — "unconscious" is HP-derived. ` +
        `Heal them above 0 first (adjust_hp), which lifts it automatically.`,
    }
  }

  const result = await applyConditionTx(deps, characterId, characterName, input)
  return result
}

/** Narrow a `LedgerResolution` failure arm into the bare rejection shape both
 *  `ConditionResolution` and `TakeRestResolution` share (their success arms
 *  differ from `LedgerResolution`'s, so the union can't be returned directly). */
function rejection(res: LedgerResolution): {
  readonly ok: false
  readonly binding: boolean
  readonly found: boolean
  readonly constraint: string
} {
  /* c8 ignore start — defensive: every caller passes a failure arm (failSoft()
     and resolveLedgerCharacter rejections are failures by construction); the
     guard exists only to satisfy the discriminated-union narrowing. */
  if (res.ok) throw new Error('unreachable: expected a rejection')
  /* c8 ignore stop */
  return { ok: false, binding: res.binding, found: res.found, constraint: res.constraint }
}

function failSoftCondition(): ConditionResolution {
  return rejection(failSoft())
}

/** Apply or clear in one tx + journal ONLY when something changed. An
 *  idempotent no-op writes no journal row and returns `changed:false`. */
async function applyConditionTx(
  deps: RulesLawyerDeps,
  characterId: string,
  characterName: string,
  input: UpdateConditionInput,
): Promise<ConditionResolution> {
  try {
    return await deps.runInTx(async (tx) => {
      const already = await tx.findLedgerEvent(deps.turnId, deps.toolCallId, characterId)
      if (already) {
        // Replay: report the current state as an idempotent no-op (no frame).
        return {
          ok: true as const,
          payload: noopConditionPayload(characterName, input),
        }
      }
      const write =
        input.action === 'apply'
          ? await tx.applyCondition(characterId, input.condition, input.level ?? null)
          : await tx.clearCondition(characterId, input.condition)
      if (write.outcome === 'noop') {
        return { ok: true as const, payload: noopConditionPayload(characterName, input) }
      }
      await tx.writeLedgerEvent({
        characterId,
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        toolCallId: deps.toolCallId,
        tool: 'update_condition',
        delta: { condition: input.condition, action: input.action, level: input.level ?? null },
      })
      return {
        ok: true as const,
        payload: {
          characterName,
          kind: 'condition' as const,
          condition: input.condition,
          changed: true,
          summary: changedConditionSummary(characterName, input),
        },
      }
    })
  } catch (err) {
    deps.logger?.warn({ err, characterId }, 'rules-lawyer: update_condition tx threw')
    return failSoftCondition()
  }
}

function noopConditionPayload(characterName: string, input: UpdateConditionInput): ConditionPayload {
  return {
    characterName,
    kind: 'condition',
    condition: input.condition,
    changed: false,
    summary: `${characterName}'s ${input.condition} state is unchanged (no-op).`,
  }
}

function changedConditionSummary(characterName: string, input: UpdateConditionInput): string {
  if (input.action === 'clear') return `${characterName} is no longer ${input.condition}.`
  if (input.condition === 'exhaustion') {
    return `${characterName} is at exhaustion level ${String(input.level)}.`
  }
  return `${characterName} is now ${input.condition}.`
}

// ---------------------------------------------------------------------------
// take_rest
// ---------------------------------------------------------------------------

export interface TakeRestInput {
  readonly type: 'short' | 'long'
  /** Per-character hit-dice spend (short rest only); names resolved + an
   *  unknown/ambiguous name rejects the WHOLE call (informational). */
  readonly hit_dice?: readonly { readonly character_name: string; readonly count: number }[]
}

/** take_rest itemizes PER CHARACTER (the consume loop emits one frame each), so
 *  the success payload is an ARRAY — distinct from the single-payload shape. */
export type TakeRestResolution =
  | { readonly ok: true; readonly payload: readonly LedgerUpdatePayload[] }
  | { readonly ok: false; readonly binding: boolean; readonly found: boolean; readonly constraint: string }

export async function resolveTakeRest(
  deps: RulesLawyerDeps,
  input: TakeRestInput,
): Promise<TakeRestResolution> {
  let participants: readonly RestParticipant[]
  try {
    participants = await deps.ledger.readRestParticipants(deps.sessionId)
  } catch (err) {
    deps.logger?.warn({ err }, 'rules-lawyer: readRestParticipants threw')
    return failSoftRest()
  }

  // Resolve the requested hit-dice spends against the participant set. An
  // unknown/ambiguous name rejects the WHOLE call (informational; no partial).
  const requestsOrReject = mapHitDiceRequests(input.hit_dice ?? [], participants, deps.rng)
  if (!requestsOrReject.ok) return requestsOrReject.rejection

  try {
    return await deps.runInTx(async (tx) => {
      // §10 idempotency: a replay of an in-flight rest already journaled one row
      // per participant under this (turn, call). Any present row ⟹ replay.
      const first = participants[0]
      if (first && (await tx.findLedgerEvent(deps.turnId, deps.toolCallId, first.characterId))) {
        return { ok: true as const, payload: await buildRestPayloads(tx, deps.sessionId, input.type) }
      }
      if (input.type === 'short') {
        await tx.shortRest(deps.sessionId, requestsOrReject.requests)
      } else {
        await tx.longRest(deps.sessionId)
      }
      for (const p of participants) {
        await tx.writeLedgerEvent({
          characterId: p.characterId,
          sessionId: deps.sessionId,
          turnId: deps.turnId,
          toolCallId: deps.toolCallId,
          tool: 'take_rest',
          delta: { type: input.type },
        })
      }
      return { ok: true as const, payload: await buildRestPayloads(tx, deps.sessionId, input.type) }
    })
  } catch (err) {
    deps.logger?.warn({ err, type: input.type }, 'rules-lawyer: take_rest tx threw')
    return failSoftRest()
  }
}

function failSoftRest(): TakeRestResolution {
  return rejection(failSoft())
}

/** Roll each requested character's short-rest hit-dice heal (clamped to
 *  remaining; per-die `max(0, roll(hitDie) + conMod)`), or reject on an
 *  unknown/ambiguous name. Long rest ignores `hit_dice` (regain is fixed). */
function mapHitDiceRequests(
  requested: readonly { readonly character_name: string; readonly count: number }[],
  participants: readonly RestParticipant[],
  rng?: Rng,
):
  | { readonly ok: true; readonly requests: readonly { characterId: string; diceSpent: number; healTotal: number }[] }
  | { readonly ok: false; readonly rejection: TakeRestResolution } {
  const requests: { characterId: string; diceSpent: number; healTotal: number }[] = []
  for (const req of requested) {
    const [p, ...extra] = participants.filter(
      (x) => x.name.trim().toLowerCase() === req.character_name.trim().toLowerCase(),
    )
    if (p === undefined || extra.length > 0) {
      // Unknown OR ambiguous name → the WHOLE call rejects (no partial state).
      return {
        ok: false,
        rejection: {
          ok: false,
          binding: false,
          found: false,
          constraint:
            `Could not identify the resting character "${req.character_name}" among the party. ` +
            `No one rested. Do not narrate a definite rest outcome for this attempt.`,
        },
      }
    }
    const diceSpent = Math.min(req.count, p.hitDiceRemaining)
    let healTotal = 0
    for (let i = 0; i < diceSpent; i += 1) {
      const { total } = rollDice(1, p.hitDie, rng)
      healTotal += Math.max(0, total + p.conMod)
    }
    requests.push({ characterId: p.characterId, diceSpent, healTotal })
  }
  return { ok: true, requests }
}

/** Build one payload per participant from the POST-rest snapshot (numbers the
 *  FT narrates). The consume loop emits one `ledger_update` frame each (§8). */
async function buildRestPayloads(
  tx: LedgerOps,
  sessionId: string,
  type: 'short' | 'long',
): Promise<readonly LedgerUpdatePayload[]> {
  const snapshot = await tx.readPartyLedgerSnapshot(sessionId)
  return snapshot.map((c) => ({
    characterName: c.name,
    kind: 'rest' as const,
    summary:
      `${c.name} finishes a ${type} rest (now ${String(c.hitPoints)}/${String(c.maxHitPoints)} HP, ` +
      `${String(c.hitDiceRemaining)} hit dice remaining).`,
    hp: c.hitPoints,
    maxHp: c.maxHitPoints,
  }))
}
