import type { SpaceToken } from '@mythrun/client-core/contract'

// SpaceToken → full, STATIC Tailwind class strings for our spacing scale.
//
// Why a literal lookup and not `gap-[var(--space-${n})]`: Tailwind v4 scans
// SOURCE TEXT for class names. A template-interpolated class never appears in
// the source, so its utility is never generated. Each class here is a complete
// literal so the scanner finds it. The arbitrary `[var(--space-N)]` value pins
// the gap/padding to OUR --space-1..9 tokens (4/8/12/16/24/32/40/48/64px),
// which DIVERGE from Tailwind's default scale at step 5+ — `gap-5` would be
// 20px, our --space-5 is 24px. (`gap-`/`p-` are non-color prefixes, so the
// arbitrary value passes no-ad-hoc-color, which bans only arbitrary COLORS.)

/** Flex/grid `gap` utility per SpaceToken. */
export const GAP_CLASS: Record<SpaceToken, string> = {
  1: 'gap-[var(--space-1)]',
  2: 'gap-[var(--space-2)]',
  3: 'gap-[var(--space-3)]',
  4: 'gap-[var(--space-4)]',
  5: 'gap-[var(--space-5)]',
  6: 'gap-[var(--space-6)]',
  7: 'gap-[var(--space-7)]',
  8: 'gap-[var(--space-8)]',
  9: 'gap-[var(--space-9)]',
}

/** All-sides `padding` utility per SpaceToken. */
export const PADDING_CLASS: Record<SpaceToken, string> = {
  1: 'p-[var(--space-1)]',
  2: 'p-[var(--space-2)]',
  3: 'p-[var(--space-3)]',
  4: 'p-[var(--space-4)]',
  5: 'p-[var(--space-5)]',
  6: 'p-[var(--space-6)]',
  7: 'p-[var(--space-7)]',
  8: 'p-[var(--space-8)]',
  9: 'p-[var(--space-9)]',
}

/**
 * Grid `auto-fit` track utility per SpaceToken minimum column width: each cell
 * is at least `--space-N` wide and grows to fill. Full literals so the scanner
 * generates them.
 */
export const AUTO_FIT_CLASS: Record<SpaceToken, string> = {
  1: 'grid-cols-[repeat(auto-fit,minmax(var(--space-1),1fr))]',
  2: 'grid-cols-[repeat(auto-fit,minmax(var(--space-2),1fr))]',
  3: 'grid-cols-[repeat(auto-fit,minmax(var(--space-3),1fr))]',
  4: 'grid-cols-[repeat(auto-fit,minmax(var(--space-4),1fr))]',
  5: 'grid-cols-[repeat(auto-fit,minmax(var(--space-5),1fr))]',
  6: 'grid-cols-[repeat(auto-fit,minmax(var(--space-6),1fr))]',
  7: 'grid-cols-[repeat(auto-fit,minmax(var(--space-7),1fr))]',
  8: 'grid-cols-[repeat(auto-fit,minmax(var(--space-8),1fr))]',
  9: 'grid-cols-[repeat(auto-fit,minmax(var(--space-9),1fr))]',
}
