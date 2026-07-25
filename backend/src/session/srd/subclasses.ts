// backend/src/session/srd/subclasses.ts
//
// myth-4jhrk: SRD 2014 subclass reference — one subclass per class, 12 entries.
// The deterministic allowlist behind the character-sheet coherence gate (a
// sheet for an SRD class at a subclass-granting level must NAME its SRD
// subclass, or the player's pinned choice) and the rendered table in the
// character-sheet prompt, so the gate and the prompt can never drift apart.
//
// Names + grant levels are pinned verbatim to the guided builder's catalog
// (`frontend/client-core/src/srd/classes.ts` CLASS_OPTIONS +
// `subclass-level.ts` SUBCLASS_LEVEL, themselves ported from the validated
// prototype's `data/srd/classes.json`). The two tables MUST agree — the
// builder offers exactly these names, and this gate validates against them.
// Backend and client-core are separate packages, so the data is duplicated
// here rather than imported; the unit test pins all 12 rows against drift.

/** One SRD 2014 class row: canonical class name (lowercase id), the class's
 *  single SRD subclass name, and the level at which the class gains it. */
export interface SrdSubclassEntry {
  readonly className: string
  readonly subclass: string
  readonly subclassLevel: 1 | 2 | 3
}

/** The 12 SRD 2014 classes with their single SRD subclass each. */
export const SRD_SUBCLASSES: readonly SrdSubclassEntry[] = [
  { className: 'barbarian', subclass: 'Berserker', subclassLevel: 3 },
  { className: 'bard', subclass: 'College of Lore', subclassLevel: 3 },
  { className: 'cleric', subclass: 'Life Domain', subclassLevel: 1 },
  { className: 'druid', subclass: 'Circle of the Land', subclassLevel: 2 },
  { className: 'fighter', subclass: 'Champion', subclassLevel: 3 },
  { className: 'monk', subclass: 'Way of the Open Hand', subclassLevel: 3 },
  { className: 'paladin', subclass: 'Oath of Devotion', subclassLevel: 3 },
  { className: 'ranger', subclass: 'Hunter', subclassLevel: 3 },
  { className: 'rogue', subclass: 'Thief', subclassLevel: 3 },
  { className: 'sorcerer', subclass: 'Draconic Bloodline', subclassLevel: 1 },
  { className: 'warlock', subclass: 'The Fiend', subclassLevel: 1 },
  { className: 'wizard', subclass: 'School of Evocation', subclassLevel: 2 },
]

/**
 * Resolve a narrative class name to its SRD row, or null when the class is
 * not one of the 12 SRD classes (flavored class names — "Storm-Touched
 * Sorcerer", "Hollow Knight" — deliberately miss: the subclass gate only
 * applies to exact SRD classes). Match is exact on the trimmed, case-folded
 * name — the same normalization the repo layer uses for name indexes.
 */
export function srdSubclassFor(className: string): SrdSubclassEntry | null {
  const key = className.trim().toLowerCase()
  return SRD_SUBCLASSES.find((entry) => entry.className === key) ?? null
}
