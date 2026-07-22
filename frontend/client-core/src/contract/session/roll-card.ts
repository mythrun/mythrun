import type { CardItem, RollPhase } from '../../session/roll-reveal.ts'

// RollCard (MYT-93, spec §5) — the in-stream dice moment: a skill_check / dice_roll
// transcript item rendered as a square/paper card (skill + context + posture → a Roll
// button → a stepped DieSpin → the mod/total/DC/tier readout → Continue). The card is
// PURE THEATER over an already-server-resolved number — it sends NOTHING to the server
// (no client→server roll frame). `phase` is DERIVED by the route's client-core selector
// (`cardPhase`) and passed in, so @mythrun/ui holds no reveal runtime (R1). The
// `constraint` field is NEVER rendered (it is the seed the DM's gated prose is written
// from). Platform-neutral (§9): pure data + resolved labels + neutral callbacks —
// no DOM types.

/** The resolved label bundle the route threads to each card (so @mythrun/ui
 *  needs no translation import). Outcome-tier words are rendered as typographic WEIGHT,
 *  never a colour chip (spec §5 / the no-status-chips register). */
export interface RollCardLabels {
  /** The Roll button (idle phase). */
  readonly roll: string
  /** The Continue button (revealed skill_check — releases the buffered prose). */
  readonly continue: string
  /** outcomeTier → its word (rendered as typographic WEIGHT, never a colour chip). */
  readonly tier: Readonly<Record<'fail' | 'success' | 'great_success', string>>
  /** The "DC" readout prefix. */
  readonly dc: string
  /** advantage / disadvantage posture tags (a normal roll shows neither). */
  readonly advantage: string
  readonly disadvantage: string
  /** SR label naming the die's stamped result (motion is never the only signal). */
  readonly dieResult: string
}

/** Props for one in-stream dice-moment card. */
export interface RollCardProps {
  /** The card's transcript item (skill_check or dice_roll — carries the whole frame). */
  item: CardItem
  /** The card's derived reveal phase (idle → revealed → released), computed route-side. */
  phase: RollPhase
  /** Honour reduced motion — the die lands instantly, no spin. */
  reducedMotion: boolean
  /** Resolved label bundle (the web layer fills it). */
  labels: RollCardLabels
  /** Commit the roll (the spin completed) — neutral callback, never a DOM event. */
  onRoll: () => void
  /** Release the buffered post-check prose (Continue) — neutral callback. */
  onContinue: () => void
}
