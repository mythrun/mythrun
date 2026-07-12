// The SRD 2014 saving-throw proficiency map (MYT-90, D6) — the ONE authority the
// character-reveal's expanded sheet consults to decide which of a character's six
// saving throws add the proficiency bonus. Each SRD 2014 class is proficient in
// exactly TWO saving throws; the reveal adapter adds the proficiency bonus to those
// two abilities' save modifiers and leaves the other four at the bare ability
// modifier. Like `subclass-level.ts`, this MUST agree with the backend's mechanics,
// so it is pinned here exactly (not derived). This is the ONLY mechanics that live
// in the SRD data (the backend LLM owns everything else) — homed here because the
// reveal derives saves in deterministic client code, never by parsing prose (ZFC).

import type { ClassName } from './classes.ts'

/** The six D&D 5e ability ids, lowercase — the score-key form the sheet carries
 *  (matching `SheetAbilityScores`), and the element type of a class's save pair. */
export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

/** The two saving throws each SRD 2014 class is proficient in, keyed by class id.
 *  `as const satisfies` pins the literal pairs while asserting full coverage of the
 *  12 {@link ClassName}s. */
export const CLASS_SAVES = {
  barbarian: ['str', 'con'],
  bard: ['dex', 'cha'],
  cleric: ['wis', 'cha'],
  druid: ['int', 'wis'],
  fighter: ['str', 'con'],
  monk: ['str', 'dex'],
  paladin: ['wis', 'cha'],
  ranger: ['str', 'dex'],
  rogue: ['dex', 'int'],
  sorcerer: ['con', 'cha'],
  warlock: ['wis', 'cha'],
  wizard: ['int', 'wis'],
} as const satisfies Record<ClassName, readonly [Ability, Ability]>
