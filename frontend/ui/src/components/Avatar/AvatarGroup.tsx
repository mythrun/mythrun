import { forwardRef, Children, isValidElement } from 'react'
import type { AvatarGroupProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// AvatarGroup — an overlapping cluster of Avatars. Each face is separated from
// the one beneath it by a token RING, so the stack reads as distinct squares
// rather than a smear; a negative inline margin produces the overlap. The ring
// color tracks the SURFACE the cluster sits on (`surface` prop) so it matches the
// background and reads as a clean cut, not a halo — `ring-bg` on the page,
// `ring-surface` on a Card. When the child count exceeds `max`, the first `max`
// render and a trailing `+N` overflow chip stands in for the rest.
//
// The overflow chip mirrors the Avatar shape (SQUARE — 0px radius, §3, no rounded
// exception) + the quiet brand chip tokens (`--surface` / `--border-strong` /
// `--ink`), mono `font-ui` (it's a count — data). It is plain text (`+2`); the
// names it stands in for live in the avatars it replaced, so no extra a11y wiring
// is needed.
//
// `children` come in as Avatars; we cap with `Children.toArray` (which also
// flattens fragments + filters nullish children) so `max` counts real avatars.

const OVERLAP = '-ml-[var(--space-2)]'
// The token ring color per surface. `ring-bg` = var(--color-bg) (the page);
// `ring-surface` = var(--color-surface) (a Card). Both literals appear verbatim
// so Tailwind's JIT scanner emits each utility (a computed `ring-${surface}`
// would never be seen).
const RING_COLOR: Record<NonNullable<AvatarGroupProps['surface']>, string> = {
  bg: 'ring-bg',
  surface: 'ring-surface',
}
// The full overlap ring: width + surface-matched color + SQUARE corner + overlap.
const ringFor = (surface: NonNullable<AvatarGroupProps['surface']>): string =>
  cn('ring-2 rounded-none', RING_COLOR[surface], OVERLAP)

export const AvatarGroup = forwardRef<HTMLDivElement, AvatarGroupProps>(function AvatarGroup(
  { max, children, surface = 'bg', 'data-testid': dataTestId },
  ref,
) {
  // `Children.toArray` flattens fragments, drops nullish children, AND assigns
  // each remaining element a STABLE key (`.0`, `.1`, …) — so we key the wrappers
  // on `child.key` (positional but stable across renders), not a raw array index.
  const all = Children.toArray(children).filter(isValidElement)
  const cap = max ?? all.length
  const shown = all.slice(0, cap)
  const overflow = all.length - shown.length
  const ring = ringFor(surface)

  return (
    <div
      ref={ref}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className="inline-flex items-center"
    >
      {shown.map((child, i) => (
        // The first avatar keeps its natural edge; the rest overlap + ring.
        <span key={child.key} className={i === 0 ? '' : ring}>
          {child}
        </span>
      ))}
      {overflow > 0 ? (
        <span
          className={cn(
            'inline-flex items-center justify-center',
            'w-[var(--control-md)] h-[var(--control-md)]',
            'rounded-none bg-surface text-ink border border-border-strong',
            'font-ui text-sm font-medium leading-none',
            ring,
          )}
        >
          {`+${String(overflow)}`}
        </span>
      ) : null}
    </div>
  )
})
