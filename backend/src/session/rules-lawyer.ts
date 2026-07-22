// backend/src/session/rules-lawyer.ts
//
// MYT-70 §4 — the Rules Lawyer contract + shared helpers. The deterministic
// adjudication core: one exported resolver per ledger tool (split across
// `rules-lawyer-resources.ts` for cast/spend/acquire and
// `rules-lawyer-vitals.ts` for hp/condition/rest to stay under the 400-line
// gate). This module owns the result type, the scoped deps, the fail-soft
// constant, name normalization, character resolution, and the journal write +
// idempotent-replay helper every resolver shares.
//
// TOTAL: every game-rule failure arm returns a structured constraint result;
// the service never throws on game-rule grounds (an uncaught throw surfaces as
// a tool-error part the FT loop continues past, letting the model narrate an
// outcome with no adjudication — a Principle #4/#5 violation). Infrastructure
// failures (PG down) follow the skill-check fail-soft precedent: a generic
// "could not be resolved" constraint, logged. The injected `ledger` dep is the
// SCOPED LedgerOps projection, not the whole Repo (same boundary as
// `MechanicalReads` in skill-check.ts).

import type { Rng } from './dice/engine.js'
import type {
  FindLedgerCharacterResult,
  LedgerCharacterProjection,
  LedgerOps,
} from '../repo/characters-ledger.js'
// CANONICAL HOME (T11): `LedgerUpdatePayload` lives in `tiers/types.ts`. It was
// defined locally here so Wave C could land in order; T11 re-homed it and this
// module now imports + re-exports it so every existing consumer keeps its path.
import type { LedgerUpdatePayload } from './tiers/types.js'
export type { LedgerUpdatePayload } from './tiers/types.js'

// ---------------------------------------------------------------------------
// The §4 result contract
// ---------------------------------------------------------------------------

/** §4 contract: success carries the payload (a real mutation OR a §10 idempotent
 *  replay); failure carries the §6 discriminators + the FT-facing constraint. */
export type LedgerResolution =
  | { readonly ok: true; readonly payload: LedgerUpdatePayload }
  | {
      readonly ok: false
      readonly binding: boolean
      readonly found: boolean
      readonly constraint: string
    }

// ---------------------------------------------------------------------------
// Scoped deps
// ---------------------------------------------------------------------------

interface RulesLawyerLogger {
  warn: (o: Record<string, unknown>, m: string) => void
}

/**
 * The transaction runner the resolver uses to make a mutation + its
 * `ledger_events` journal row atomic (§10). The caller (T10/T12) constructs
 * this from `repo.transaction` bound to the tx-scoped `LedgerOps`; the resolver
 * stays decoupled from the concrete repo wiring. The callback receives a
 * tx-bound `LedgerOps` and the runner commits on return / rolls back on throw.
 */
export type LedgerTxRunner = <T>(fn: (txLedger: LedgerOps) => Promise<T>) => Promise<T>

export interface RulesLawyerDeps {
  /** Pool-bound ops for the pre-mutation reads (character resolution, slot +
   *  spell reads). Mutations go through `runInTx`. */
  readonly ledger: LedgerOps
  /** Opens ONE transaction so a mutation + its journal row commit atomically. */
  readonly runInTx: LedgerTxRunner
  readonly sessionId: string
  readonly turnId: string
  /** The SDK-assigned tool-call id (threaded from `execute` in T10). The
   *  journal's `(turn_id, tool_call_id, character_id)` idempotency key — a
   *  BullMQ redelivery of an in-flight job replays the same id. */
  readonly toolCallId: string
  readonly rng?: Rng
  readonly logger?: RulesLawyerLogger
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const norm = (s: string): string => s.trim().toLowerCase()

/** Fail-soft constraint for any infra-class failure (PG down, a tx throw, a
 *  multi-row-match invariant violation): the FT must NOT narrate a definite
 *  outcome. Mirrors skill-check.ts's UNRESOLVED. */
const UNRESOLVED =
  'This could not be resolved. Do not narrate a definite outcome for this attempt.'

/** Build the generic fail-soft rejection (always non-binding, always a miss —
 *  the FT should treat it as "no adjudication happened", not a refusal). */
export function failSoft(constraint = UNRESOLVED): LedgerResolution {
  return { ok: false, binding: false, found: false, constraint }
}

/** A binding rejection — scarce, tracked state was exhausted/insufficient. The
 *  constraint is the authoritative outcome; the FT narrates HOW it falls short. */
export function bindingRejection(constraint: string): LedgerResolution {
  return { ok: false, binding: true, found: true, constraint }
}

/** An informational ledger MISS — no row for the named resource. Non-binding;
 *  the constraint carries the §6 three-branch guidance the FT reasons over. */
export function informationalMiss(constraint: string): LedgerResolution {
  return { ok: false, binding: false, found: false, constraint }
}

/**
 * Resolve a session participant's character + live ledger projection, mapping
 * the `not_found | ambiguous` arms to the same informational constraint the
 * skill-check resolver uses. `found` returns the projection for the caller to
 * proceed with; any other arm returns a ready-to-return `LedgerResolution`.
 */
export async function resolveLedgerCharacter(
  deps: RulesLawyerDeps,
  characterName: string,
): Promise<
  | { readonly outcome: 'found'; readonly projection: LedgerCharacterProjection }
  | { readonly outcome: 'rejected'; readonly resolution: LedgerResolution }
> {
  let resolved: FindLedgerCharacterResult
  try {
    resolved = await deps.ledger.findLedgerCharacterByName(deps.sessionId, characterName)
  } catch (err) {
    deps.logger?.warn({ err, characterName }, 'rules-lawyer: character resolution threw')
    return { outcome: 'rejected', resolution: failSoft() }
  }
  if (resolved.outcome === 'found') {
    return { outcome: 'found', projection: resolved.projection }
  }
  deps.logger?.warn(
    { characterName, outcome: resolved.outcome },
    'rules-lawyer: character resolution failed',
  )
  return {
    outcome: 'rejected',
    resolution: informationalMiss(
      `Could not identify the character "${characterName}". ${UNRESOLVED}`,
    ),
  }
}

/**
 * Run a mutation + its journal write in ONE transaction (§10). The mutation
 * callback returns the applied payload; if the journal `INSERT … ON CONFLICT`
 * returns no id, this exact tool call already applied (BullMQ redelivery of an
 * in-flight job) — `onAlreadyApplied` builds the idempotent-success payload
 * from the existing state. Any throw fail-softs (logged), so an infra failure
 * never surfaces as a tool-error the FT narrates past.
 *
 * `mutate` performs the guarded write and returns either the success payload +
 * the journal delta, or a `LedgerResolution` rejection (a guard-predicate
 * rowcount-0 / binding case) — rejections short-circuit BEFORE any journal row.
 */
export async function applyWithJournal(
  deps: RulesLawyerDeps,
  characterId: string,
  tool: string,
  mutate: (txLedger: LedgerOps) => Promise<
    | { readonly applied: true; readonly payload: LedgerUpdatePayload; readonly delta: Record<string, unknown> }
    | { readonly applied: false; readonly resolution: LedgerResolution }
  >,
  onAlreadyApplied: (txLedger: LedgerOps) => Promise<LedgerUpdatePayload>,
): Promise<LedgerResolution> {
  try {
    return await deps.runInTx(async (txLedger) => {
      // §10 idempotency: check the journal FIRST. A BullMQ redelivery of an
      // in-flight job would otherwise re-run the guarded debit (the mutation
      // commits before the journal's ON CONFLICT can fire), double-spending a
      // mutable column. Checking first inside the tx makes the replay a true
      // no-op — it returns the current post-mutation state, mutates nothing.
      const already = await txLedger.findLedgerEvent(deps.turnId, deps.toolCallId, characterId)
      if (already) {
        return { ok: true, payload: await onAlreadyApplied(txLedger) }
      }
      const result = await mutate(txLedger)
      if (!result.applied) return result.resolution
      await txLedger.writeLedgerEvent({
        characterId,
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        toolCallId: deps.toolCallId,
        tool,
        delta: result.delta,
      })
      return { ok: true, payload: result.payload }
    })
  } catch (err) {
    deps.logger?.warn({ err, tool, characterId }, 'rules-lawyer: mutation tx threw')
    return failSoft()
  }
}

export type {
  CharacterSpellRow,
  LedgerOps,
  SpellSlotRow,
} from '../repo/characters-ledger.js'
