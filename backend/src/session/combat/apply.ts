// backend/src/session/combat/apply.ts
//
// MYT-75 Task 5 — the D13 envelope reconciler: the seam that makes the dice
// authoritative over the FT's combat narration. The FT's `resolve_combat`
// reports HP/casualty deltas, but it must NOT narrate away the dice-selected
// stakes. `reconcileDeltas` takes the deterministic `CombatOutcome` (with its
// hard `CombatEnvelope`), the FT's proposed deltas, the PC roster, and the
// enemy names, and returns the RECONCILED deltas — clamped/augmented so the
// envelope's floors (minDownedPcs / minAggregateHpLossFraction) are met and its
// caps (no PC death unless allowPcDeathNarration) are honoured. `applyToLedger`
// then writes the reconciled PC HP to the shared ledger by SETTING each PC's HP
// to the combat target (`combat-start HP − reconciled damage`), not by applying
// a delta. The combat outcome is the AUTHORITATIVE result of the whole fight:
// setting the target subsumes any in-turn `adjust_hp` the FT also fired for a
// combatant (MYT-75 L1 double-application bug) AND is inherently idempotent (a
// BullMQ re-run re-sets the same target → no-op). `assembleSummary` builds the
// `CombatSummaryL1` the post-combat world update reads.
//
// Pure orchestration (ZFC): all the judgment — who fought, who fell, how bad it
// was — was made by the deterministic roll + the FT's narration. This module
// only enforces the mechanical envelope contract; it reasons about nothing.

import type { LedgerOps } from '../../repo/characters-ledger.js'
import type { RulesLawyerDeps } from '../rules-lawyer.js'
import type { CombatOutcome, CombatSummaryL1 } from '../../redis/session-state.js'

// ---------------------------------------------------------------------------
// The contract (consumed by a later task)
// ---------------------------------------------------------------------------

export interface ReconcilePc {
  readonly characterId: string
  readonly name: string
  readonly hp: number
  readonly maxHp: number
}

export interface FtCombatDeltas {
  readonly hp_changes: readonly { combatant_name: string; damage: number; healing: number }[]
  readonly conditions_applied: readonly { combatant_name: string; condition: string }[]
  readonly conditions_removed: readonly { combatant_name: string; condition: string }[]
  readonly casualties: readonly { combatant_name: string; fate: 'dead' | 'unconscious' | 'fled' }[]
}

export interface ReconciledCombat {
  /** 'defeat' iff !envelope.partyWins, else 'victory' (L1 collapses flee/other). */
  readonly outcomeKind: 'victory' | 'defeat' | 'flee' | 'other'
  /** Net damage to APPLY (post-envelope), each capped at the PC's current hp.
   *  `hpBefore` is the PC's combat-start/snapshot HP; `applyToLedger` SETS the
   *  PC's HP to `hpBefore − amount` (authoritative target), it does NOT apply a
   *  delta — so any in-turn `adjust_hp` is subsumed, not double-counted. */
  readonly pcDamage: readonly { characterId: string; name: string; amount: number; hpBefore: number }[]
  /** PCs reduced to 0 hp — 'dead' only when the envelope permits death narration,
   *  otherwise 'unconscious' (mechanically the ledger only has 0-hp/unconscious). */
  readonly pcCasualties: readonly { name: string; fate: 'dead' | 'unconscious' }[]
  /** Narrative-only: the FT's enemy casualties, passed through. */
  readonly enemyCasualties: readonly { name: string; fate: string }[]
  /** The FT's PC conditions, passed through as apply/remove. */
  readonly conditions: readonly { name: string; condition: string; action: 'apply' | 'remove' }[]
}

// ---------------------------------------------------------------------------
// reconcileDeltas — the envelope-enforcement heart of the task
// ---------------------------------------------------------------------------

const norm = (s: string): string => s.trim().toLowerCase()

/** A mutable per-PC working row: the reconciler accrues damage onto it, then
 *  reads back the applied amount + downed state. */
interface PcWork {
  readonly characterId: string
  readonly name: string
  readonly hp: number
  readonly maxHp: number
  damage: number
  /** The FT marked this PC downed (unconscious/dead) regardless of HP math. */
  ftDowned: boolean
  /** The FT claimed this PC dead (only honoured under allowPcDeathNarration). */
  ftDead: boolean
}

export function reconcileDeltas(
  outcome: CombatOutcome,
  ft: FtCombatDeltas,
  party: readonly ReconcilePc[],
  enemyNames: readonly string[],
): ReconciledCombat {
  const { envelope } = outcome
  const byName = new Map<string, PcWork>()
  for (const p of party) {
    byName.set(norm(p.name), {
      characterId: p.characterId,
      name: p.name,
      hp: p.hp,
      maxHp: p.maxHp,
      damage: 0,
      ftDowned: false,
      ftDead: false,
    })
  }
  const enemySet = new Set(enemyNames.map(norm))

  // 1. PC damage from the FT (net damage − healing, floored at 0, capped at hp).
  accrueFtDamage(ft, byName)
  // PC casualties the FT marked (unconscious/dead) — flag the working rows.
  flagFtCasualties(ft, byName, enemySet)
  // 2. Down any FT-declared casualty mechanically: a PC the FT narrated as
  //    unconscious/dead must reach 0 HP in the ledger, or the summary (which
  //    lists it as a casualty) and the ledger (which shows it conscious) would
  //    disagree. Runs BEFORE the enforcement passes so the PC counts toward
  //    minDownedPcs and is at 0 HP.
  applyFtDownings(byName)

  const pcs = [...byName.values()]
  // 3. Enforce minDownedPcs: down the lowest-hp not-yet-downed PCs.
  enforceMinDowned(pcs, envelope.minDownedPcs)
  // 4. Enforce minAggregateHpLossFraction: spread damage onto the highest-hp PCs.
  enforceAggregateLoss(pcs, envelope.minAggregateHpLossFraction)

  return {
    outcomeKind: envelope.partyWins ? 'victory' : 'defeat',
    // `hp` is the PC's combat-start/snapshot HP — the SET target downstream is
    // `hpBefore − amount`, making the combat outcome authoritative + idempotent.
    pcDamage: pcs.map((p) => ({
      characterId: p.characterId,
      name: p.name,
      amount: p.damage,
      hpBefore: p.hp,
    })),
    pcCasualties: buildPcCasualties(pcs, envelope.allowPcDeathNarration),
    enemyCasualties: buildEnemyCasualties(ft, enemySet),
    conditions: buildConditions(ft, byName),
  }
}

/** Sum each PC's net (damage − healing) across its hp_changes, floor at 0, cap
 *  at current hp. Non-PC combatants are dropped (no throw). */
function accrueFtDamage(ft: FtCombatDeltas, byName: ReadonlyMap<string, PcWork>): void {
  const net = new Map<PcWork, number>()
  for (const c of ft.hp_changes) {
    const pc = byName.get(norm(c.combatant_name))
    if (pc === undefined) continue // enemy or unknown → drop
    net.set(pc, (net.get(pc) ?? 0) + c.damage - c.healing)
  }
  for (const [pc, raw] of net) {
    pc.damage = Math.min(pc.hp, Math.max(0, raw))
  }
}

/** Flag the working rows the FT marked unconscious/dead (PC casualties only). */
function flagFtCasualties(
  ft: FtCombatDeltas,
  byName: Map<string, PcWork>,
  enemySet: ReadonlySet<string>,
): void {
  for (const c of ft.casualties) {
    const key = norm(c.combatant_name)
    if (enemySet.has(key)) continue // enemy casualty handled separately
    const pc = byName.get(key)
    if (pc === undefined) continue // unknown → drop
    if (c.fate === 'unconscious' || c.fate === 'dead') {
      pc.ftDowned = true
      if (c.fate === 'dead') pc.ftDead = true
    }
  }
}

/** Mechanically down every FT-declared casualty: set its applied damage to its
 *  full current hp (→ 0 HP, auto-unconscious) when the FT's reported damage was
 *  too low. Keeps the summary's casualty list and the ledger in lock-step — an
 *  FT-narrated "unconscious" PC is at 0 HP in the ledger, not conscious. */
function applyFtDownings(byName: ReadonlyMap<string, PcWork>): void {
  for (const p of byName.values()) {
    if (p.ftDowned && p.damage < p.hp) p.damage = p.hp
  }
}

/** A PC is "downed" if its applied damage takes it to 0 OR the FT marked it. */
function isDowned(p: PcWork): boolean {
  return p.damage >= p.hp || p.ftDowned
}

/** 3. Enforce minDownedPcs: if too few PCs are down, down the lowest-current-hp
 *  not-yet-downed PCs (deterministic: hp asc, then name) until the floor is met. */
function enforceMinDowned(pcs: PcWork[], minDownedPcs: number): void {
  const candidates = pcs
    .filter((p) => !isDowned(p))
    .sort((a, b) => a.hp - b.hp || a.name.localeCompare(b.name))
  let downed = pcs.filter(isDowned).length
  for (const p of candidates) {
    if (downed >= minDownedPcs) break
    p.damage = p.hp // down them
    downed += 1
  }
}

/** 4. Enforce minAggregateHpLossFraction: distribute additional damage across
 *  the highest-current-hp PCs (each capped at its hp) until the fraction is met
 *  or every PC is at 0. */
function enforceAggregateLoss(pcs: PcWork[], minFraction: number): void {
  const totalMax = pcs.reduce((s, p) => s + p.maxHp, 0)
  if (totalMax === 0) return
  const needed = minFraction * totalMax
  // Highest remaining HP (after current damage) first, then name for determinism.
  const ordered = [...pcs].sort(
    (a, b) => b.hp - b.damage - (a.hp - a.damage) || a.name.localeCompare(b.name),
  )
  for (const p of ordered) {
    const applied = pcs.reduce((s, x) => s + x.damage, 0)
    if (applied >= needed) return
    const room = p.hp - p.damage
    if (room <= 0) continue
    const remaining = needed - applied
    p.damage += Math.min(room, Math.ceil(remaining))
  }
}

function buildPcCasualties(
  pcs: readonly PcWork[],
  allowDeath: boolean,
): readonly { name: string; fate: 'dead' | 'unconscious' }[] {
  return pcs.filter(isDowned).map((p) => {
    // A FT-claimed death is narrative-only and gated on the envelope; without
    // it, downgrade to unconscious (the only mechanical 0-hp state).
    const fate: 'dead' | 'unconscious' = p.ftDead && allowDeath ? 'dead' : 'unconscious'
    return { name: p.name, fate }
  })
}

/** Enemy casualties are narrative-only: pass through the FT entries whose name
 *  matched an enemy (drop PC + unknown). */
function buildEnemyCasualties(
  ft: FtCombatDeltas,
  enemySet: ReadonlySet<string>,
): readonly { name: string; fate: string }[] {
  return ft.casualties
    .filter((c) => enemySet.has(norm(c.combatant_name)))
    .map((c) => ({ name: c.combatant_name, fate: c.fate }))
}

/** Pass through the FT's PC conditions as apply/remove; non-PC names are dropped. */
function buildConditions(
  ft: FtCombatDeltas,
  byName: ReadonlyMap<string, PcWork>,
): readonly { name: string; condition: string; action: 'apply' | 'remove' }[] {
  const out: { name: string; condition: string; action: 'apply' | 'remove' }[] = []
  for (const c of ft.conditions_applied) {
    const pc = byName.get(norm(c.combatant_name))
    if (pc !== undefined) out.push({ name: pc.name, condition: c.condition, action: 'apply' })
  }
  for (const c of ft.conditions_removed) {
    const pc = byName.get(norm(c.combatant_name))
    if (pc !== undefined) out.push({ name: pc.name, condition: c.condition, action: 'remove' })
  }
  return out
}

// ---------------------------------------------------------------------------
// applyToLedger — SET each PC's HP to the authoritative combat target
// ---------------------------------------------------------------------------

export interface CombatHpChange {
  readonly combatant: string
  readonly hpBefore: number
  readonly hpAfter: number
  readonly maxHp: number
}

/** The journal `tool` label for a combat HP write — combat damage is one of the
 *  named HP-mutation paths (alongside `adjust_hp` / `update_condition` /
 *  `take_rest`), so the `ledger_events` audit trail is complete + consistent. */
const COMBAT_LEDGER_TOOL = 'resolve_combat'

/**
 * Write the reconciled combat result to the shared ledger by SETTING each PC's
 * HP to the authoritative combat target (`hpBefore − amount`), NOT by applying a
 * delta — AND journaling each write to `ledger_events` (§10). The combat outcome
 * is the authoritative result of the whole fight, so setting the target:
 *   - SUBSUMES any in-turn `adjust_hp` the FT also fired for a combatant (the
 *     MYT-75 L1 double-application bug: `adjust_hp` during the render + a delta
 *     on top here landed a PC at 0 instead of its real target), and
 *   - is INHERENTLY IDEMPOTENT under the set — a re-run re-sets the same target.
 *
 * The journal is restored on top of the set so combat HP is AUDITED like every
 * other HP-mutation path, and the §10 find-first idempotency (keyed on the
 * synthetic, turn-stable `deps.toolCallId` = `combat-resolve:<turnId>`) makes a
 * BullMQ re-run a true no-op: an already-journaled PC is skipped, so no second
 * `ledger_events` row is written. Mirrors `applyWithJournal`'s find-then-
 * (mutate + journal) shape inline so all N PCs' sets + journal rows commit in
 * ONE transaction (the worker binds `runInTx` to a single tx-scoped `LedgerOps`).
 *
 * The signature is unchanged (the T7 worker call site is untouched) — `deps`
 * already carries the synthetic `toolCallId`, `sessionId`, `turnId`, `ledger`,
 * and `runInTx`. `writeHp` is the §5a SET primitive (clamps to [0, maxHp] and
 * auto-syncs the `unconscious` condition at 0).
 */
export async function applyToLedger(
  deps: RulesLawyerDeps,
  reconciled: ReconciledCombat,
): Promise<readonly CombatHpChange[]> {
  const targets = reconciled.pcDamage.filter((d) => d.amount > 0) // 0-damage → no set
  if (targets.length === 0) return []
  return deps.runInTx(async (txLedger: LedgerOps) => {
    const changes: CombatHpChange[] = []
    for (const d of targets) {
      // §10 idempotency: a re-run already journaled this (turn, call, character).
      // Skip — a present row IS the audit record + the set is idempotent, so
      // re-writing nothing here is a true no-op (no duplicate ledger_events row).
      const already = await txLedger.findLedgerEvent(deps.turnId, deps.toolCallId, d.characterId)
      if (already) continue
      const targetHp = Math.max(0, d.hpBefore - d.amount)
      const { hp, maxHp } = await txLedger.writeHp(d.characterId, targetHp)
      // Journal the applied HP delta (negative magnitude semantics live in the
      // `kind` — `magnitude` is the HP removed), matching the adjust_hp/rest
      // journal shape: one append-only row per character, same tx as the write.
      await txLedger.writeLedgerEvent({
        characterId: d.characterId,
        sessionId: deps.sessionId,
        turnId: deps.turnId,
        toolCallId: deps.toolCallId,
        tool: COMBAT_LEDGER_TOOL,
        delta: { kind: 'combat', magnitude: d.hpBefore - targetHp, hp },
      })
      changes.push({ combatant: d.name, hpBefore: d.hpBefore, hpAfter: hp, maxHp })
    }
    return changes
  })
}

// ---------------------------------------------------------------------------
// assembleSummary — build the CombatSummaryL1
// ---------------------------------------------------------------------------

export function assembleSummary(
  outcome: CombatOutcome,
  reconciled: ReconciledCombat,
  hpChanges: readonly CombatHpChange[],
  narration: string,
): CombatSummaryL1 {
  const pcCasualties = reconciled.pcCasualties.map((c) => ({
    name: c.name,
    type: 'pc' as const,
    fate: c.fate,
  }))
  const enemyCasualties = reconciled.enemyCasualties.map((c) => ({
    name: c.name,
    type: 'npc' as const,
    fate: castFate(c.fate),
  }))
  return {
    outcome: reconciled.outcomeKind,
    outcomeDescription: narration.trim().length > 0 ? narration : outcome.tierProse,
    casualties: [...pcCasualties, ...enemyCasualties],
    hpChanges,
    conditionsRemaining: reconciled.conditions
      .filter((c) => c.action === 'apply')
      .map((c) => ({ combatant: c.name, condition: c.condition })),
    loot: [],
  }
}

/** Map a free-form enemy fate string onto the CombatSummaryL1 casualty fate
 *  union, defaulting an unrecognised label to 'dead' (the L1 narrative-only
 *  enemy fate — enemies are not tracked in the ledger). */
function castFate(fate: string): 'dead' | 'unconscious' | 'fled' | 'captured' {
  if (fate === 'unconscious' || fate === 'fled' || fate === 'captured') return fate
  return 'dead'
}
