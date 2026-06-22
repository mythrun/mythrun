import { forwardRef } from 'react'
import type { IconProps, IconSize } from '@mythrun/client-core/contract'
import { GLYPHS } from './glyphs.ts'

// A single glyph rendered inline as an SVG, tinted by the current text color
// (`fill="currentColor"` — tint via `text-*` token utilities, never a raw
// color, R3). The glyph SOURCE is the swappable `GLYPHS` map (Pixelarticons
// today; a Pro/Nucleo swap is one file).
//
// Sizing: a STATIC token-class lookup (full literals so Tailwind v4's source
// scanner generates them — same technique as `space.ts`/`typography.ts`). The
// `--icon-sm/md/lg` tokens are 16/20/24px. NOTE (spec §4): Pixelarticons are
// 24-grid VECTOR svgs — they anti-alias at any size, crispest at 24/48. We do
// NOT set `shape-rendering: crispEdges` / `image-rendering: pixelated`: those
// are no-ops on vector geometry, and §4 explicitly drops the "nearest-neighbor
// crisp" promise for this set.
//
// a11y (a discriminated pair — at most one of label / decorative):
//   • decorative, or neither given → `aria-hidden`, no role: hidden from AT, the
//     adjacent text carries the meaning. Decorative is the DEFAULT.
//   • label → `role="img"` + `aria-label`: a meaningful standalone glyph with an
//     accessible name (an i18n key the consumer supplies).
const ICON_SIZE_CLASS: Record<IconSize, string> = {
  sm: 'w-[var(--icon-sm)] h-[var(--icon-sm)]',
  md: 'w-[var(--icon-md)] h-[var(--icon-md)]',
  lg: 'w-[var(--icon-lg)] h-[var(--icon-lg)]',
}

export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(props, ref) {
  const { name, size = 'md', label } = props
  const glyph = GLYPHS[name]
  // Meaningful only when a label is supplied (role=img + accessible name);
  // otherwise — including the explicit `decorative` case — it is hidden from the
  // a11y tree. (The contract union guarantees label and decorative are never
  // both set, so `label === undefined` is the single source of truth here.)
  const a11y =
    label === undefined
      ? ({ 'aria-hidden': true } as const)
      : ({ role: 'img', 'aria-label': label } as const)

  return (
    <svg
      ref={ref}
      viewBox={glyph.viewBox}
      fill="currentColor"
      className={ICON_SIZE_CLASS[size]}
      data-testid={props['data-testid']}
      {...a11y}
    >
      {glyph.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  )
})
