// The subclass-at-level table (MYT-90) — the ONE authority the guided character
// builder consults to decide whether it shows a Subclass step at the party's starting
// level. SRD 2014 grants a subclass at level 1 (Cleric / Sorcerer / Warlock), level 2
// (Druid / Wizard), or level 3 (the other seven). This table MUST agree with the
// backend's level-scaling assumptions, so it is pinned here explicitly (not derived).

import type { ClassName } from './classes.ts'

/** The level at which each SRD 2014 class gains its subclass. */
export const SUBCLASS_LEVEL = {
  cleric: 1,
  sorcerer: 1,
  warlock: 1,
  druid: 2,
  wizard: 2,
  barbarian: 3,
  bard: 3,
  fighter: 3,
  monk: 3,
  paladin: 3,
  ranger: 3,
  rogue: 3,
} as const satisfies Record<ClassName, 1 | 2 | 3>

/** Whether the guided builder should offer a Subclass step for `className` at the
 * party's starting `level` — true once the level reaches the class's grant level. */
export function subclassOfferedAt(className: ClassName, level: number): boolean {
  return SUBCLASS_LEVEL[className] <= level
}
