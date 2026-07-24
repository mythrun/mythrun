import { forwardRef } from 'react'
import { cva } from 'class-variance-authority'
import type { StackProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { GAP_CLASS } from '../../lib/space.ts'

// Enum variants (direction/align/justify/wrap) are fixed sets → CVA. The gap is
// an open SpaceToken, so it comes from the GAP_CLASS lookup (full static
// classes), not a CVA variant. No colors here — pure layout.
//
// `[&>*]:min-w-0` is the canonical flex-shrink unblocker (§3): the flex
// `min-width:auto` default floors children at their content width, so a long
// child can't shrink and forces overflow. Setting min-width:0 on every direct
// child removes that floor (no effect when there's slack) and cascades through
// nested Stacks. The graceful outcome itself is the child's job (Text.truncate,
// wrap). NOTE (R2/native): min-w-0 is a WEB impl detail, not a contract prop —
// React Native's Yoga defaults flexShrink to 0, so the native Stack must opt
// each shrinkable child in explicitly.
const stack = cva('flex [&>*]:min-w-0', {
  variants: {
    direction: {
      row: 'flex-row',
      column: 'flex-col',
    },
    align: {
      start: 'items-start',
      center: 'items-center',
      end: 'items-end',
      stretch: 'items-stretch',
    },
    justify: {
      start: 'justify-start',
      center: 'justify-center',
      end: 'justify-end',
      between: 'justify-between',
    },
    wrap: {
      true: 'flex-wrap',
      false: '',
    },
    // Hold the stack's size in a flex parent — a nested group otherwise inherits
    // the parent's [&>*]:min-w-0 and can shrink below its content, overlapping the
    // next item. `shrink-0` pins it so a shrinkable sibling absorbs the row shrink.
    noShrink: {
      true: 'shrink-0',
      false: '',
    },
    // Full dynamic-viewport floor (mirrors Box's minHeight="screen" — `dvh`, not
    // `vh`, so mobile chrome doesn't leave a gap). Full literal so the v4 scanner emits it.
    minHeight: {
      screen: 'min-h-dvh',
    },
    // flex-1 fill for the body region of a fixed-crown column. `grow={true}` →
    // this class; a NUMERIC weight is applied via inline `flexGrow` instead (an
    // arbitrary weight can't be a static Tailwind class — the v4 scanner only emits
    // literals it sees, so a dynamic `grow-[n]` would never generate).
    grow: {
      true: 'grow',
      false: '',
    },
    // Reading-measure column: cap the width and centre it (`mx-auto`) so a single-
    // column reading/flow surface doesn't stretch to full width. `w-full` lets it
    // fill UP TO the cap, then the max-width holds. Full literals so the v4 scanner
    // emits them (a `max-w-[var(--measure)]` would be a color-safe arbitrary value,
    // but the fixed rem measures read clearer at the call site).
    maxWidth: {
      prose: 'mx-auto w-full max-w-[34rem]',
      form: 'mx-auto w-full max-w-[36rem]',
      wide: 'mx-auto w-full max-w-[56rem]',
    },
  },
  defaultVariants: {
    direction: 'column',
  },
})

export const Stack = forwardRef<HTMLDivElement, StackProps>(function Stack(
  { direction = 'column', gap, align, justify, wrap, noShrink, minHeight, maxWidth, grow = false, children, ...rest },
  ref,
) {
  // A numeric grow is an explicit flex-grow WEIGHT (proportional spacers); the
  // boolean `true` is the `flex:1` fill class. Map the number to `flexGrow` inline
  // (platform-neutral contract → web flex-grow; native Yoga maps the same field).
  const growStyle = typeof grow === 'number' ? { flexGrow: grow } : undefined
  return (
    <div
      ref={ref}
      className={cn(
        stack({
          direction,
          align,
          justify,
          wrap,
          noShrink,
          grow: grow === true,
          ...(minHeight !== undefined && { minHeight }),
          ...(maxWidth !== undefined && { maxWidth }),
        }),
        gap !== undefined && GAP_CLASS[gap],
      )}
      {...(growStyle !== undefined && { style: growStyle })}
      {...rest}
    >
      {children}
    </div>
  )
})
