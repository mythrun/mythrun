// MYT-68 §3.4 — the deterministic dice engine (Principle #4: the LLM never
// generates a random number). Ported from the validated mythrun-v5 prototype
// with an injectable RNG for tests, a defensive bound on rollDice (an
// unbounded count would stall the worker, which holds the session lock), and
// 5e-RAW advantage/disadvantage cancellation (the prototype let advantage
// silently win — not RAW).

import crypto from 'node:crypto'

export type RollType = 'normal' | 'advantage' | 'disadvantage'

/** `rng(min, maxExclusive)` — crypto.randomInt-compatible; injectable. */
export type Rng = (min: number, maxExclusive: number) => number

const defaultRng: Rng = (min, maxExclusive) => crypto.randomInt(min, maxExclusive)

export interface D20Result {
  readonly roll: number
  readonly roll2: number | null
  readonly keptRoll: number
  readonly rollType: RollType
}

export const STANDARD_DICE = [2, 4, 6, 8, 10, 12, 20, 100] as const
export const MAX_DICE_COUNT = 100

/** 5e RAW: any source of advantage + any source of disadvantage cancel to a
 *  straight roll, regardless of how many of each. */
export function resolveRollType(advantage: boolean, disadvantage: boolean): RollType {
  if (advantage && disadvantage) return 'normal'
  if (advantage) return 'advantage'
  if (disadvantage) return 'disadvantage'
  return 'normal'
}

export function rollD20WithType(rollType: RollType, rng: Rng = defaultRng): D20Result {
  const roll = rng(1, 21)
  if (rollType === 'normal') return { roll, roll2: null, keptRoll: roll, rollType }
  const roll2 = rng(1, 21)
  const keptRoll = rollType === 'advantage' ? Math.max(roll, roll2) : Math.min(roll, roll2)
  return { roll, roll2, keptRoll, rollType }
}

export function rollDice(
  count: number,
  sides: number,
  rng: Rng = defaultRng,
): { results: number[]; total: number } {
  if (!Number.isInteger(count) || count < 1 || count > MAX_DICE_COUNT) {
    throw new Error(`rollDice: count out of bounds (1..${String(MAX_DICE_COUNT)}): ${String(count)}`)
  }
  if (!(STANDARD_DICE as readonly number[]).includes(sides)) {
    throw new Error(`rollDice: non-standard die d${String(sides)}`)
  }
  const results: number[] = []
  for (let i = 0; i < count; i += 1) results.push(rng(1, sides + 1))
  return { results, total: results.reduce((a, b) => a + b, 0) }
}

export function calculateModifier(abilityScore: number): number {
  return Math.floor((abilityScore - 10) / 2)
}

const PROFICIENCY_TABLE: readonly (readonly [number, number, number])[] = [
  [1, 4, 2], [5, 8, 3], [9, 12, 4], [13, 16, 5], [17, 20, 6],
]

/** Generation/validation use ONLY — the live skill-check path reads the
 *  stored characters.proficiency_bonus column (§3.5 step 2). */
export function proficiencyBonusByLevel(level: number): number {
  const entry = PROFICIENCY_TABLE.find(([min, max]) => level >= min && level <= max)
  if (entry === undefined) throw new Error(`Invalid level: ${String(level)}. Must be 1-20.`)
  return entry[2]
}
