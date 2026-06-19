// backend/src/session/combat/events.ts
//
// MYT-75 Task 6 — the per-turn combat-event sink contract. The two FT combat
// tools (`initiate_combat`, `resolve_combat`) are PURE DATA RESOLVERS: their
// `execute` returns DATA, mutates no session state, and emits no frame. Each
// records its decision into a per-turn `CombatEvent[]` accumulator (the
// `recordCombat` sink, mirroring `recordInjection`) that the WORKER reads
// post-turn (Task 7) to apply the ledger, persist the `CombatStateBlob`, flip
// the session mode, and emit `combat_resolved`.
//
// `initiate_combat` records an `InitiateCombatEvent` (the deterministic
// `CombatOutcome` from `resolveCombat` + the rolled setup); `resolve_combat`
// records a `ResolveCombatEvent` (the FT's deltas reconciled against the
// outcome's envelope via `reconcileDeltas` + the close-out narration). The mode
// flip + blob write + `combat_resolved` emission all happen at the worker (T7),
// NOT here.

import type { CombatOutcome } from '../../redis/session-state.js'
import type { CombatEnemy } from './outcome.js'
import type { ReconciledCombat } from './apply.js'

/** The per-PC projection the combat tools resolve `resolveCombat`/
 *  `reconcileDeltas` against — the public mechanical shape (id + name + level +
 *  current/max HP), derived from the per-turn party-ledger snapshot. No secret
 *  fields: a player's own numbers carry no enforced-ignorance interaction. */
export interface CombatPartyMember {
  readonly characterId: string
  readonly name: string
  readonly level: number
  readonly hp: number
  readonly maxHp: number
}

/** `initiate_combat`'s recorded decision: the deterministic `CombatOutcome`
 *  (the authoritative result the FT narrates within) plus the rolled setup the
 *  worker writes onto the `CombatStateBlob`. */
export interface InitiateCombatEvent {
  readonly kind: 'initiate'
  readonly outcome: CombatOutcome
  readonly enemies: readonly CombatEnemy[]
  readonly environment: string
  readonly surprise: 'none' | 'players_surprised' | 'enemies_surprised'
  readonly initiative: readonly { combatant: string; roll: number }[]
}

/** `resolve_combat`'s recorded decision: the FT's deltas reconciled against the
 *  initiate event's outcome envelope, plus the close-out narration. */
export interface ResolveCombatEvent {
  readonly kind: 'resolve'
  readonly reconciled: ReconciledCombat
  readonly narration: string
}

export type CombatEvent = InitiateCombatEvent | ResolveCombatEvent
