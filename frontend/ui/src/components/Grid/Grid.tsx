import { forwardRef } from 'react'
import type { CSSProperties } from 'react'
import type { GridProps, SpaceToken } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { AUTO_FIT_CLASS, GAP_CLASS } from '../../lib/space.ts'

// Default auto-fit minimum column width: the largest scale step.
const DEFAULT_AUTO_FIT_MIN: SpaceToken = 9

// A fixed column COUNT is structural (a number, not a design token), so it is
// mechanical computation expressed inline — there is no "columns" token scale,
// and the count is fully dynamic (any N). The auto-fit track, by contrast, is
// sized by a --space TOKEN, so it uses the AUTO_FIT_CLASS lookup. The gap is a
// SpaceToken → GAP_CLASS. No colors anywhere — pure layout.
const fixedColumns = (n: number): CSSProperties => ({
  gridTemplateColumns: `repeat(${String(n)}, minmax(0, 1fr))`,
})

export const Grid = forwardRef<HTMLDivElement, GridProps>(function Grid(
  { columns = 1, gap, minColumnWidth, children, ...rest },
  ref,
) {
  const autoFit = columns === 'auto-fit'
  const trackClass = autoFit ? AUTO_FIT_CLASS[minColumnWidth ?? DEFAULT_AUTO_FIT_MIN] : undefined
  const style = autoFit ? undefined : fixedColumns(columns)
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
