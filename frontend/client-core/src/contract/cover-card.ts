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
   * Fixed card width in px (the made-object's set size — e.g. the width the hub
   * grid auto-fills to). Omit to fill the container width; either way the 3:2
   * (h:w) portrait aspect drives the height.
   */
  width?: number
}
