import { forwardRef } from 'react'
import type { CSSProperties } from 'react'
import type { GridProps, SpaceToken } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { AUTO_FIT_CLASS, GAP_CLASS } from '../../lib/space.ts'

// Default responsive minimum column width: the largest scale step. Serves both
// the auto-fit (class) and the token-fallback auto-fill (inline) tracks.
const DEFAULT_AUTO_MIN: SpaceToken = 9

// A fixed column COUNT is structural (a number, not a design token), so it is
// mechanical computation expressed inline — there is no "columns" token scale,
// and the count is fully dynamic (any N). The auto-fit track, by contrast, is
// sized by a --space TOKEN, so it uses the AUTO_FIT_CLASS lookup. The gap is a
// SpaceToken → GAP_CLASS. No colors anywhere — pure layout.
const fixedColumns = (n: number): CSSProperties => ({
  gridTemplateColumns: `repeat(${String(n)}, minmax(0, 1fr))`,
})

// The auto-FILL track: cells hold `min` and wrap (empty tracks are kept, so
// cells never stretch). Prefers an explicit PIXEL escape hatch for card-scale
// widths that live off the --space scale; else reuses the --space token
// vocabulary. Always inline — a px value can't be a static Tailwind class, and
// auto-fill has no class lookup, so both branches build the minmax string here.
const autoFillColumns = (minPx: number | undefined, min: SpaceToken): CSSProperties => ({
  gridTemplateColumns: `repeat(auto-fill, minmax(${
    minPx === undefined ? `var(--space-${String(min)})` : `${String(minPx)}px`
  }, 1fr))`,
})

// The inline grid-template-columns for the non-auto-fit modes. auto-fit is the
// one mode driven by a class (AUTO_FIT_CLASS) rather than inline style, so it
// returns undefined here.
const trackStyle = (
  columns: number | 'auto-fit' | 'auto-fill',
  minPx: number | undefined,
  min: SpaceToken,
): CSSProperties | undefined => {
  if (columns === 'auto-fit') return undefined
  if (columns === 'auto-fill') return autoFillColumns(minPx, min)
  return fixedColumns(columns)
}

export const Grid = forwardRef<HTMLDivElement, GridProps>(function Grid(
  { columns = 1, gap, minColumnWidth, minColumnPx, children, ...rest },
  ref,
) {
  const min = minColumnWidth ?? DEFAULT_AUTO_MIN
  const trackClass = columns === 'auto-fit' ? AUTO_FIT_CLASS[min] : undefined
  const style = trackStyle(columns, minColumnPx, min)
  return (
    <div
      ref={ref}
      className={cn('grid', trackClass, gap !== undefined && GAP_CLASS[gap])}
      {...(style ? { style } : {})}
      {...rest}
    >
      {children}
    </div>
  )
})
