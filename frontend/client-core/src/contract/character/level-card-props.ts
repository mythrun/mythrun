// LevelCard (MYT-90) — a starting-level pick card (levels 1–5). The party's shared
// starting level; `grantGloss` is the resolved one-line description of what the level
// grants. Platform-neutral (§9): `onSelect` is a neutral callback, never a DOM event.

/** The party's shared starting level — the 1..5 closed union the level cards offer. */
export type CharacterLevel = 1 | 2 | 3 | 4 | 5

/** Props for one starting-level card. */
export interface LevelCardProps {
  /** The resolved machine-register eyebrow over the number (e.g. "Level") — the
   *  shell resolves i18n and passes it (MYT-100 lifted it into the contract). */
  eyebrow: string
  /** This card's level (1–5). */
  level: CharacterLevel
  /** Resolved one-line "what this level grants" gloss (the web layer fills the copy). */
  grantGloss: string
  /** Whether this card is the current pick. */
  selected: boolean
  /** Neutral activation callback — fired on click AND keyboard (Enter/Space). */
  onSelect: () => void
}
