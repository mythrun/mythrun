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
// then writes the reconciled PC damage to the shared ledger through the REAL
// Rules-Lawyer resolver (one `toolCallId`, characterId-keyed idempotency), and
// `assembleSummary` builds the `CombatSummaryL1` the post-combat world update
// reads.
//
// Pure orchestration (ZFC): all the judgment — who fought, who fell, how bad it
// was — was made by the deterministic roll + the FT's narration. This module
// only enforces the mechanical envelope contract; it reasons about nothing.

import { resolveAdjustHp } from '../rules-lawyer-vitals.js'
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
  /** Net damage to APPLY (post-envelope), each capped at the PC's current hp. */
  readonly pcDamage: readonly { characterId: string; name: string; amount: number }[]
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
    pcDamage: pcs.map((p) => ({ characterId: p.characterId, name: p.name, amount: p.damage })),
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
// applyToLedger — write the reconciled PC damage through the real resolver
// ---------------------------------------------------------------------------

export interface CombatHpChange {
  readonly combatant: string
  readonly hpBefore: number
  readonly hpAfter: number
  readonly maxHp: number
}

export async function applyToLedger(
  deps: RulesLawyerDeps,
  reconciled: ReconciledCombat,
): Promise<readonly CombatHpChange[]> {
  const changes: CombatHpChange[] = []
  for (const d of reconciled.pcDamage) {
    if (d.amount <= 0) continue // no-op damage — nothing to journal
    const resolution = await resolveAdjustHp(deps, {
      character_name: d.name,
      kind: 'damage',
      amount: d.amount,
    })
    if (!resolution.ok) {
      // Should not happen for a valid PC — log + skip (never narrate past it).
      deps.logger?.warn(
        { combatant: d.name, constraint: resolution.constraint },
        'combat-apply: adjust_hp rejected for a reconciled PC',
      )
      continue
    }
    const { hp, maxHp } = resolution.payload
    // The resolver's payload carries hpAfter (`hp`) + maxHp; hpBefore is the
    // applied damage added back (damage is capped at current hp, so this is exact).
    // The `?? 0` arms are defensive against the optional payload fields: an
    // `adjust_hp` success ALWAYS sets hp + maxHp (kind:'hp'), so they never fire.
    /* c8 ignore next 2 -- hp/maxHp are always set on a successful adjust_hp payload */
    const hpAfter = hp ?? 0
    const max = maxHp ?? 0
    changes.push({ combatant: d.name, hpBefore: hpAfter + d.amount, hpAfter, maxHp: max })
  }
  return changes
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
