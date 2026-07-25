// The SRD 2014 spellcasting-ability map (ux-run2 myth-8ps4n) — the ONE authority
// the character reveal consults to mark WHICH ability powers a caster's spells
// (nothing else on the sheet tells a newcomer that the WIS 18 is why their
// spells work). Like `class-saves.ts`, this is pinned SRD mechanics consumed by
// deterministic client code, never derived from prose (ZFC). Non-casting
// classes map to null; the view-model additionally gates the mark on the sheet
// actually carrying spells, so a spell-less character never shows it.

import type { ClassName } from './classes.ts'
import type { Ability } from './class-saves.ts'

/** Each SRD 2014 class's spellcasting ability (null for non-casters). `as const
 *  satisfies` pins the literals while asserting full 12-class coverage. */
export const CASTING_ABILITY = {
  barbarian: null,
  bard: 'cha',
  cleric: 'wis',
  druid: 'wis',
  fighter: null,
  monk: null,
  paladin: 'cha',
  ranger: 'wis',
  rogue: null,
  sorcerer: 'cha',
  warlock: 'cha',
  wizard: 'int',
} as const satisfies Record<ClassName, Ability | null>
