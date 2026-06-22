import { forwardRef } from 'react'
import type { LinkProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Navigational link primitive. Renders a real <a href> (a genuine link with an
// accessible name). `onPress` is the platform-neutral activation callback — the
// web impl maps it to onClick. `external` opens a new context with a safe rel.
//
// Focus ring (a11y-critical): a 2px hard square outline, 2px offset, in the
// `accent` token color. `outline-accent` resolves to --color-accent, which is
// EXACTLY what --focus-ring-color references in both themes
// (`--focus-ring-color: var(--accent)` in :root and .dark), so the ring is
// theme-aware. We use the token utility (`outline-accent`) rather than the
// arbitrary `outline-[var(--focus-ring-color)]` because no-ad-hoc-color (R3)
// bans arbitrary color utilities — the token utility is the supported form, and
// here it's semantically identical to the focus-ring token.
const LINK_CLASS = cn(
  'text-accent underline-offset-2 hover:underline hover:text-accent-hover',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
)

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, onPress, external = false, children, ...rest },
  ref,
) {
  const externalAttrs = external ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  return (
    <a
      ref={ref}
      href={href}
      onClick={onPress}
      className={LINK_CLASS}
      {...externalAttrs}
      {...rest}
    >
      {children}
    </a>
  )
})
