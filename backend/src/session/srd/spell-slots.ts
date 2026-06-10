// MYT-70 §9.1 — SRD 5e spell-slot progression tables.
//
// Pure reference data + lookup math (ZFC: no string ops, no class names — the
// input is the structured `SpellcastingProgression` enum set by prep at
// generation time, §3.2). Consumed at character finalize, by `take_rest`
// restores, and by the §3.2 coherence validation.
//
// Data is AUTHORED from the public SRD 5e tables — the prototype carries no
// slot-progression tables to port (verified at plan time). Pinned row-for-row
// in `__tests__/spell-slots.test.ts`.
//
// Levels outside 1–20 THROW: the `characters.level` column is an unchecked
// INTEGER from migration 001, and an out-of-range level reaching this lookup is
// a generation-time data error, not a runtime arm to fail-soft over.

export const SPELLCASTING_PROGRESSIONS = ['full', 'half', 'third', 'pact', 'none'] as const
export type SpellcastingProgression = (typeof SPELLCASTING_PROGRESSIONS)[number]

/** One slot row: `max` slots of spell level `slotLevel` (1–9). */
export interface SpellSlotRow {
  readonly slotLevel: number
  readonly max: number
}

const MIN_CHARACTER_LEVEL = 1
const MAX_CHARACTER_LEVEL = 20

// Slot maxima tables, indexed by character level (slot-1-first arrays). Each
// inner array lists slots of spell level 1, 2, 3, … in order; a missing trailing
// entry means zero slots of that level. Authored from the public SRD 5e tables.
//
// `LEVEL_OFFSET` aligns character level N with row index N (index 0 unused) so
// the tables read like the SRD's level-numbered rows.

const FULL_TABLE: readonly (readonly number[])[] = [
  /* L0  unused */ [],
  /* L1  */ [2],
  /* L2  */ [3],
  /* L3  */ [4, 2],
  /* L4  */ [4, 3],
  /* L5  */ [4, 3, 2],
  /* L6  */ [4, 3, 3],
  /* L7  */ [4, 3, 3, 1],
  /* L8  */ [4, 3, 3, 2],
  /* L9  */ [4, 3, 3, 3, 1],
  /* L10 */ [4, 3, 3, 3, 2],
  /* L11 */ [4, 3, 3, 3, 2, 1],
  /* L12 */ [4, 3, 3, 3, 2, 1],
  /* L13 */ [4, 3, 3, 3, 2, 1, 1],
  /* L14 */ [4, 3, 3, 3, 2, 1, 1],
  /* L15 */ [4, 3, 3, 3, 2, 1, 1, 1],
  /* L16 */ [4, 3, 3, 3, 2, 1, 1, 1],
  /* L17 */ [4, 3, 3, 3, 2, 1, 1, 1, 1],
  /* L18 */ [4, 3, 3, 3, 3, 1, 1, 1, 1],
  /* L19 */ [4, 3, 3, 3, 3, 2, 1, 1, 1],
  /* L20 */ [4, 3, 3, 3, 3, 2, 2, 1, 1],
]

const HALF_TABLE: readonly (readonly number[])[] = [
  /* L0  unused */ [],
  /* L1  */ [],
  /* L2  */ [2],
  /* L3  */ [3],
  /* L4  */ [3],
  /* L5  */ [4, 2],
  /* L6  */ [4, 2],
  /* L7  */ [4, 3],
  /* L8  */ [4, 3],
  /* L9  */ [4, 3, 2],
  /* L10 */ [4, 3, 2],
  /* L11 */ [4, 3, 3],
  /* L12 */ [4, 3, 3],
  /* L13 */ [4, 3, 3, 1],
  /* L14 */ [4, 3, 3, 1],
  /* L15 */ [4, 3, 3, 2],
  /* L16 */ [4, 3, 3, 2],
  /* L17 */ [4, 3, 3, 3, 1],
  /* L18 */ [4, 3, 3, 3, 1],
  /* L19 */ [4, 3, 3, 3, 2],
  /* L20 */ [4, 3, 3, 3, 2],
]

const THIRD_TABLE: readonly (readonly number[])[] = [
  /* L0  unused */ [],
  /* L1  */ [],
  /* L2  */ [],
  /* L3  */ [2],
  /* L4  */ [3],
  /* L5  */ [3],
  /* L6  */ [3],
  /* L7  */ [4, 2],
  /* L8  */ [4, 2],
  /* L9  */ [4, 2],
  /* L10 */ [4, 3],
  /* L11 */ [4, 3],
  /* L12 */ [4, 3],
  /* L13 */ [4, 3, 2],
  /* L14 */ [4, 3, 2],
  /* L15 */ [4, 3, 2],
  /* L16 */ [4, 3, 3],
  /* L17 */ [4, 3, 3],
  /* L18 */ [4, 3, 3],
  /* L19 */ [4, 3, 3, 1],
  /* L20 */ [4, 3, 3, 1],
]

function assertLevelInRange(level: number): void {
  if (
    !Number.isInteger(level) ||
    level < MIN_CHARACTER_LEVEL ||
    level > MAX_CHARACTER_LEVEL
  ) {
    throw new Error(
      `spell-slots: character level out of range (${String(MIN_CHARACTER_LEVEL)}..${String(MAX_CHARACTER_LEVEL)}): ${String(level)}`,
    )
  }
}

/** A slot-1-first maxima array → `SpellSlotRow[]`, dropping zero/absent levels. */
function rowsFromMaxima(maxima: readonly number[]): SpellSlotRow[] {
  const rows: SpellSlotRow[] = []
  for (let i = 0; i < maxima.length; i += 1) {
    const max = maxima[i] ?? 0
    if (max > 0) rows.push({ slotLevel: i + 1, max })
  }
  return rows
}

// Pact (warlock) derivation. N slots of a SINGLE pact-slot level (identified
// downstream by `spellcasting_progression = 'pact'`, never by slot level):
//   slot level rises 1→5 at character levels 1 / 3 / 5 / 7 / 9;
//   slot count is 1 at L1, 2 from L2, 3 from L11, 4 from L17.
function pactSlotLevel(level: number): number {
  if (level >= 9) return 5
  if (level >= 7) return 4
  if (level >= 5) return 3
  if (level >= 3) return 2
  return 1
}

function pactSlotCount(level: number): number {
  if (level >= 17) return 4
  if (level >= 11) return 3
  if (level >= 2) return 2
  return 1
}

/**
 * SRD 5e spell-slot maxima for a given progression and character level.
 * Returns rows ascending by slot level; `none` and slot-less low levels of the
 * partial casters return `[]`. Throws on out-of-range or non-integer levels.
 */
export function spellSlotsFor(
  progression: SpellcastingProgression,
  level: number,
): readonly SpellSlotRow[] {
  assertLevelInRange(level)
  switch (progression) {
    case 'full':
      return rowsFromMaxima(FULL_TABLE[level] ?? [])
    case 'half':
      return rowsFromMaxima(HALF_TABLE[level] ?? [])
    case 'third':
      return rowsFromMaxima(THIRD_TABLE[level] ?? [])
    case 'pact':
      return [{ slotLevel: pactSlotLevel(level), max: pactSlotCount(level) }]
    case 'none':
      return []
  }
}

/**
 * Highest spell level this character can cast from a slot, for the §3.2
 * coherence validation. 0 when no slots exist (`none`, or a partial caster
 * below its onset level).
 */
export function maxSlotLevel(progression: SpellcastingProgression, level: number): number {
  const rows = spellSlotsFor(progression, level)
  let max = 0
  for (const row of rows) {
    if (row.slotLevel > max) max = row.slotLevel
  }
  return max
}
