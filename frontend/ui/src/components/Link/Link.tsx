import { forwardRef } from 'react'
import type { LinkProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Navigational link primitive. Renders a real <a href> (a genuine link with an
// accessible name). `onPress` is the platform-neutral activation callback — the
// web impl maps it to onClick. `external` opens a new context with a safe rel.
//
// Link text AND focus ring use the FOREGROUND accent (--accent-fg), not the fill
// (--accent): a link is accent drawn AS text/stroke ON the page, so it must
// contrast against the page — in dark mode the fill is darkened for on-accent
// text AA and is then too dark to read/ring against the dark page (the fg/fill
// split lives in semantic.css). `text-accent-fg` is the link text; it brightens
// to `text-accent-fg-hover` on hover (alongside the underline).
//
// Focus ring (a11y-critical): a 2px hard square outline, 2px offset, in the
// `accent-fg` token. `outline-accent-fg` resolves to --color-accent-fg, which is
// EXACTLY what --focus-ring-color references in both themes
// (`--focus-ring-color: var(--accent-fg)` in :root and .dark), so the ring is
// theme-aware. We use the token utility (`outline-accent-fg`) rather than the
// arbitrary `outline-[var(--focus-ring-color)]` because no-ad-hoc-color (R3)
// bans arbitrary color utilities — the token utility is the supported form, and
// here it's semantically identical to the focus-ring token.
//
// The class is split so the `unstyled` variant can drop the ACCENT paint (text
// colour + hover underline) while KEEPING the a11y focus ring: an unstyled link
// wraps a larger composed target (a whole card / index row) that must render in
// the ambient ink, but a keyboard-focusable link still needs a visible focus
// indicator.
const FOCUS_CLASS =
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg'
const ACCENT_CLASS = 'text-accent-fg underline-offset-2 hover:underline hover:text-accent-fg-hover'

export const Link = forwardRef<HTMLAnchorElement, LinkProps>(function Link(
  { href, onPress, external = false, unstyled = false, children, ...rest },
  ref,
) {
  const externalAttrs = external ? { target: '_blank', rel: 'noopener noreferrer' } : {}
  return (
    <a
      ref={ref}
      href={href}
      onClick={onPress}
      className={cn(FOCUS_CLASS, !unstyled && ACCENT_CLASS)}
      {...externalAttrs}
      {...rest}
    >
      {children}
    </a>
  )
})
