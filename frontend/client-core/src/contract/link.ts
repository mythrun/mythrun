import type { BaseProps } from './index.ts'

/**
 * Navigational link primitive. `href` is the destination; `onPress` is the
 * platform-neutral activation callback (web maps it to `onClick`, a future
 * native impl to its own press handler). `external` opens a new context with
 * safe `rel`. No `asChild` (DOM-coupled) and no `className`/`style` — the
 * public surface stays platform-neutral.
 */
export interface LinkProps extends BaseProps {
  /** Destination URL. */
  href: string
  /** Platform-neutral activation callback. Web maps this to `onClick`. */
  onPress?: () => void
  /** Open in a new context (web: `target="_blank"` with safe `rel`). */
  external?: boolean
  /**
   * Drop the link's own accent styling — no accent text colour, no hover
   * underline — so the children render in the AMBIENT ink and the link is a bare
   * navigable wrapper. The a11y focus ring is KEPT (a keyboard-focusable link
   * always needs a visible focus indicator). Use this when the link wraps a
   * larger composed target (a whole card / index row) that must read in its own
   * paper-ink register, not in link-accent. Default `false` (the accent link).
   */
  unstyled?: boolean
}
