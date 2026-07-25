import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/**
 * A portrait "made-object" card — a paperback/cover object of a fixed 3:2 (h:w)
 * shape. It splits into a full-bleed COVER header (the cover art — a CoverDither),
 * an INK seam, then a body whose narrative content sits at the TOP and whose FOOT
 * slot (the imprint / ledger) pins to the BOTTOM, with air between.
 *
 * Reusable geometry: `width` sets the object's fixed size (px); the 3:2 portrait
 * aspect always drives the height. Paired with a 5:3 cover (CoverDither `band`),
 * the cover fills ~40% of the height. The campaign-hub card is a thin composition
 * of this primitive (cover = a world-colour CoverDither; body = title + subtitle;
 * foot = party seals over a mono record line).
 *
 * Platform-neutral (§9): the cover/foot come in as `ReactNode` slots; no
 * className/style/DOM events. `children` are the body's TOP content.
 */
/**
 * The cta line's loudness tier (ux-run3 myth-7jc1h — the hub's resume
 * hierarchy). Three weights of the same accent action register, so a grid of
 * cards can rank its actions without badges: `loud` is the premier
 * continue-session cue (semibold), `quiet` (default) the ordinary action line
 * (medium — e.g. a dormant card's "Resume →"), `whisper` the quietest tier
 * (normal weight — e.g. a cold start's "Author your character →", which must
 * never out-shout an invested campaign). Weight is the axis — never a sub-AA
 * opacity dim (the contrast rule).
 */
export type CoverCardCtaTone = 'loud' | 'quiet' | 'whisper'

export interface CoverCardProps extends BaseProps {
  /**
   * The full-bleed cover header — the cover art (a `CoverDither`). Sits at the
   * top; an ink seam separates it from the body. At the 3:2 card shape a 5:3
   * cover stands ~40% of the height.
   */
  cover: ReactNode
  /**
   * The foot slot — pinned to the BOTTOM of the body (the imprint / ledger row:
   * e.g. party seals over a record line). Omit for a card with no foot.
   */
  foot?: ReactNode
  /**
   * Optional call-to-action line — the card's single action cue, rendered as
   * the LAST line of the body in the accent action register (mono caption,
   * accent ink), e.g. the hub premier card's "Continue session →". The card
   * stays presentational: the consumer's wrapping link is the actual target;
   * this line only names it. State-as-prose — never a chip/badge.
   */
  cta?: string
  /**
   * The cta line's loudness tier — default `quiet`. See {@link CoverCardCtaTone}.
   * Ignored when no `cta` is given (the reserved empty line carries no tone).
   */
  ctaTone?: CoverCardCtaTone
  /**
   * Marks the grid's ONE promoted object (ux-run3 myth-7jc1h — the hub premier
   * card): a heavier 2px edge plus a thin accent rule above the cta line, so the
   * promoted card reads as the shelf's dominant object rather than relying on
   * position alone. At most one card per grid should carry it.
   */
  promoted?: boolean
  /**
   * Fixed card width in px (the made-object's set size — e.g. the width the hub
   * grid auto-fills to). Omit to fill the container width; either way the 3:2
   * (h:w) portrait aspect drives the height.
   */
  width?: number
}
