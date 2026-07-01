import { forwardRef } from 'react'
import type { CSSProperties } from 'react'
import type { CoverCardProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Divider } from '../Divider/Divider.tsx'

// CoverCard — a portrait "made-object" card (a paperback / cover object). A fixed
// 3:2 (h:w) flat card: a full-bleed COVER header (the cover art) over an INK seam
// (Divider tone="ink"), then a body whose narrative content sits at the TOP and
// whose FOOT slot pins to the bottom (justify-between) with air between. Square,
// 1px --border-strong edge, paper surface — the flat-1-bit register, like Card,
// but carrying the cover-object GEOMETRY the neutral Card doesn't model (a fixed
// portrait size, a full-bleed cover, a foot-pinned imprint).
//
// GEOMETRY: the 3:2 portrait aspect (`aspect-[2/3]`, i.e. width:height 2:3) drives
// the height from the width. `width` (px) sets the object's fixed size; omit it to
// FILL the container (a grid track sizes it) — the aspect still holds. The cover is
// a flex item that keeps its intrinsic height (`shrink-0`): a 5:3 CoverDither
// `band` at this width stands ~40% of the card tall, and the body FILLS the
// remainder (`grow`), so the seals + record line pin to the foot regardless of how
// much narrative sits up top. `overflow-hidden` clips a cover / an over-long title
// to the square edge.

const CARD =
  'flex flex-col overflow-hidden rounded-none border border-border-strong bg-surface aspect-[2/3]'

export const CoverCard = forwardRef<HTMLDivElement, CoverCardProps>(function CoverCard(
  { cover, foot, width, children, 'data-testid': dataTestId },
  ref,
) {
  const style: CSSProperties | undefined = width !== undefined ? { width } : undefined
  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      {...(style !== undefined ? { style } : {})}
      className={cn(CARD, width === undefined && 'w-full')}
    >
      {/* Cover header — full-bleed, holds its intrinsic height (a band CoverDither
          ≈ 40% of the 3:2 card). */}
      <div className="shrink-0">{cover}</div>
      {/* Ink seam — a deliberate structural cut, dark in both themes. */}
      <Divider tone="ink" />
      {/* Body — narrative content at the top, the foot imprint pinned to the
          bottom, air between (justify-between). Token-padded. */}
      <div className="flex grow flex-col justify-between p-[var(--space-3)]">
        <div>{children}</div>
        {foot !== undefined ? <div>{foot}</div> : null}
      </div>
    </div>
  )
})
