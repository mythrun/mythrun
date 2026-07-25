import { forwardRef } from 'react'
import type { CSSProperties } from 'react'
import { cn } from '../../lib/cn.ts'
import { Icon } from '../Icon/Icon.tsx'
import { Text } from '../Text/Text.tsx'

// CoverCardAdd — the dashed "＋ New campaign" CREATE tile that TRAILS the campaign-hub
// grid (MYT-3jb55, moved to the last cell by myth-z9eiq — the premier top-left slot
// belongs to the player's most-recent campaign). It shares CoverCard's 3:2 portrait
// footprint so it sits as a peer cell that terminates the grid as a natural "+ one
// more", but it is a single centered action, not a cover object: a plus glyph over
// a terse label.
// Dashed --border-strong edge reads as "an outline waiting to be filled" (the same
// language as the empty shelf's dashed frame); square, paper, 1-bit register.
//
// PRESENTATIONAL: like CoverCard, it renders no navigation of its own — the consumer
// wraps it in a Link (mirroring CampaignCard's `Link > CoverCard`), so the tile gets
// the sanctioned navigable primitive + focus ring and the label becomes the link's
// accessible name. The plus is decorative (the label carries the meaning).

export interface CoverCardAddProps {
  /** The action label (also the wrapping link's accessible name), e.g. "New campaign". */
  readonly label: string
  /** Fixed object width (px) to match the sibling covers; omit to FILL the grid track. */
  readonly width?: number
  readonly 'data-testid'?: string
}

const TILE = cn(
  'flex aspect-[2/3] flex-col items-center justify-center gap-[var(--space-2)]',
  'rounded-none border border-dashed border-border-strong bg-surface text-ink',
  'transition-colors hover:bg-surface-raised',
)

export const CoverCardAdd = forwardRef<HTMLDivElement, CoverCardAddProps>(function CoverCardAdd(
  { label, width, 'data-testid': dataTestId },
  ref,
) {
  const style: CSSProperties | undefined = width !== undefined ? { width } : undefined
  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      {...(style !== undefined ? { style } : {})}
      className={cn(TILE, width === undefined && 'w-full')}
    >
      <Icon name="plus" decorative size="lg" />
      <Text role="ui-label">{label}</Text>
    </div>
  )
})
