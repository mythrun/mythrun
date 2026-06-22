import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/** Side of the trigger the popover content prefers to open toward. */
export type PopoverSide = 'top' | 'right' | 'bottom' | 'left'

/**
 * Popover. The web impl wraps the unstyled Radix `Popover` primitive (a portalled
 * content layer anchored to the trigger, focus move INTO the content and BACK to
 * the trigger on close, `Esc`-to-close, ARIA wiring); styled 100% with our tokens.
 *
 * Unlike a {@link TooltipProps Tooltip}, a popover can hold INTERACTIVE content
 * (buttons, links, a form) — it opens on click/keyboard activation and traps
 * nothing, so it is the right primitive for the entity-card popover (spec §12).
 *
 * Platform-neutral (§9): open/close is the neutral `onOpenChange(open)` callback,
 * never a DOM event; no `className`/`style`/raw DOM events.
 *
 * Controlled when `open` is supplied (pair with `onOpenChange`); uncontrolled with
 * `defaultOpen` otherwise.
 */
export interface PopoverProps extends BaseProps {
  /**
   * The trigger element (e.g. a {@link ButtonProps Button} or a highlighted
   * entity name). Rendered through Radix `Popover.Trigger`; focus returns here on
   * close. REQUIRED.
   */
  trigger: ReactNode
  /**
   * Accessible name for the popover content — an i18n key. REQUIRED: Radix renders
   * the content with `role="dialog"`, which must carry a name (→ `aria-label`), so
   * a nameless popover is structurally impossible.
   */
  label: string
  /** Controlled open state. When supplied the Popover is controlled (pair with `onOpenChange`). */
  open?: boolean
  /** Uncontrolled initial open state. Ignored when `open` is supplied. */
  defaultOpen?: boolean
  /** Neutral open-state callback — receives the next boolean, not a DOM event (§9). */
  onOpenChange?: (open: boolean) => void
  /** Preferred side to open toward. Default `bottom`. Radix flips it if there's no room. */
  side?: PopoverSide
}
