import { forwardRef } from 'react'
import type { EntityMentionProps } from '@mythrun/client-core/contract'
import { Icon } from '../Icon/Icon.tsx'
import { GLYPH_ICON } from '../Icon/glyph-for-kind.ts'
import { cn } from '../../lib/cn.ts'

// EntityMention — a recognized entity name highlighted INSIDE settled DM serif
// prose (MYT-94, spec §6). It is a REAL <button> (native keyboard activation +
// focusable), reset to read as inline text: the EntityPopover (Task 10) wraps it
// via Radix `Trigger asChild`, which injects `onClick` / `aria-*` / `data-state`
// onto this element — hence `...rest` is spread onto the button and the ref is
// forwarded. Standalone (no popover), it is an inert focusable name.
//
// MONOCHROME register (spec §6 pin — UX §12's NPC-blue / location-amber /
// faction-green is deliberately dropped): the ONLY differentiators are the
// underline STYLE and a leading type glyph, never a colour. Resting state is a
// subtle low-contrast dotted underline in the muted (tertiary) ink; hover/focus
// changes the style (dotted → solid) and darkens WITHIN the ink tokens
// (tertiary → ink), and reveals the leading glyph. All CVD-safe.
//
// Two typefaces only: the mention stays `--font-body` (it lives in serif prose);
// a native button's UA font-size/leading are overridden to INHERIT the paragraph
// so the highlight is seamless (no smaller / off-baseline run).
//
// The leading glyph is ABSOLUTELY positioned so its hover/focus reveal never
// reflows the paragraph, and is decorative (`aria-hidden`) — the button's
// `aria-label` ("entity: <name>") is the accessible name.

// The type-glyph vocabulary → the icon names (Task 8). `other` (item / pc — not
// world lore) gets NO glyph, so only the three world-lore kinds are mapped.
// Reset the native button to inline body-serif text, then paint the resting
// underline + the hover/focus style change + the shared a11y focus ring.
const MENTION_CLASS = cn(
  'group relative inline align-baseline appearance-none border-0 bg-transparent p-0 m-0 cursor-pointer',
  'font-body font-normal text-inherit [font-size:inherit] [line-height:inherit]',
  'underline decoration-dotted decoration-1 decoration-ink-tertiary underline-offset-2',
  'hover:decoration-solid hover:decoration-ink focus-visible:decoration-solid focus-visible:decoration-ink',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

// Absolute (out of flow → zero reflow on reveal), hidden at rest, shown on the
// button's (`group`) hover/focus. `pointer-events-none` so the glyph slot never
// intercepts the pointer meant for the name.
const GLYPH_CLASS = cn(
  'pointer-events-none absolute right-full top-1/2 mr-[0.15em] -translate-y-1/2',
  'opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100',
)

export const EntityMention = forwardRef<HTMLButtonElement, EntityMentionProps>(function EntityMention(
  { text, glyph, label, ...rest },
  ref,
) {
  const iconName = GLYPH_ICON[glyph]
  return (
    <button ref={ref} type="button" aria-label={label} className={MENTION_CLASS} {...rest}>
      {iconName !== null ? (
        <span aria-hidden="true" data-entity-glyph="" className={GLYPH_CLASS}>
          <Icon name={iconName} size="sm" decorative />
        </span>
      ) : null}
      {text}
    </button>
  )
})
