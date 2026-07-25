// SRD 2014 class catalog for the guided character builder (MYT-90). Each entry is a
// menu option: the lowercase class id, its canonical English display name, and the
// class's single SRD 2014 subclass name. The builder renders these, flattens the
// player's pick into concept text (the class name), and — when the party's starting
// level reaches `SUBCLASS_LEVEL[id]` — offers the subclass name in its Subclass step.
//
// Names are ported verbatim from the validated single-player prototype's
// `data/srd/classes.json` (read-only reference). NO mechanics live here (hit dice,
// saving throws, spell slots) — the backend LLM owns mechanics; this is presentational
// input data only. Canonical English is deliberate: client-core carries locale-
// independent LLM input, and `[ph:]` display copy is a later web-layer task.

/** A guided-builder class option: the lowercase id, the canonical English display
 * name, and the class's single SRD 2014 subclass name (offered by the optional
 * Subclass step once the party's starting level reaches `SUBCLASS_LEVEL[id]`). */
export interface ClassOption {
  readonly id: ClassName
  readonly name: string
  readonly subclass: string
}

/** The 12 SRD 2014 classes, in canonical menu order, each paired with its single
 * SRD subclass name. This const is the source of truth for {@link ClassName}. */
export const CLASS_OPTIONS = [
  { id: 'barbarian', name: 'Barbarian', subclass: 'Berserker' },
  { id: 'bard', name: 'Bard', subclass: 'College of Lore' },
  { id: 'cleric', name: 'Cleric', subclass: 'Life Domain' },
  { id: 'druid', name: 'Druid', subclass: 'Circle of the Land' },
  { id: 'fighter', name: 'Fighter', subclass: 'Champion' },
  { id: 'monk', name: 'Monk', subclass: 'Way of the Open Hand' },
  { id: 'paladin', name: 'Paladin', subclass: 'Oath of Devotion' },
  { id: 'ranger', name: 'Ranger', subclass: 'Hunter' },
  { id: 'rogue', name: 'Rogue', subclass: 'Thief' },
  { id: 'sorcerer', name: 'Sorcerer', subclass: 'Draconic Bloodline' },
  { id: 'warlock', name: 'Warlock', subclass: 'The Fiend' },
  { id: 'wizard', name: 'Wizard', subclass: 'School of Evocation' },
] as const

/** The lowercase id of an SRD 2014 class — the 12-member union derived from
 * {@link CLASS_OPTIONS}. Downstream (the builder, the subclass-at-level table) keys
 * off this. */
export type ClassName = (typeof CLASS_OPTIONS)[number]['id']

/** The 12 class ids, in canonical menu order. */
export const CLASSES: readonly ClassName[] = CLASS_OPTIONS.map((option) => option.id)

/** Resolve a free class string to the canonical SRD class id — an EXACT,
 * case-insensitive membership check against the closed 12-class set
 * (schema-style structural validation, never a heuristic prose parse; ZFC-safe).
 * An unrecognized class (e.g. a freeform "Fighter (Champion)") resolves to
 * undefined and the caller degrades gracefully. */
export function resolveClassName(raw: string): ClassName | undefined {
  const normalized = raw.trim().toLowerCase()
  return (CLASSES as readonly string[]).includes(normalized) ? (normalized as ClassName) : undefined
}
