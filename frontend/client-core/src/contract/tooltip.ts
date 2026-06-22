import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/** Side of the trigger the tooltip bubble prefers to open toward. */
export type TooltipSide = 'top' | 'right' | 'bottom' | 'left'

/**
 * Tooltip — a small supplementary-info bubble that appears on hover AND keyboard
 * focus. The web impl wraps the unstyled Radix `Tooltip` primitive (hover/focus
 * open with a delay, `Esc`/blur close, a portalled bubble, ARIA description
 * wiring); styled 100% with our tokens.
 *
 * SUPPLEMENTARY ONLY. A tooltip MUST NOT be the sole label for, or the sole access
 * to, a control: it does not appear on touch, and (as `aria-describedby`, not
 * `aria-labelledby`) it is not a reliable accessible NAME. Give the trigger its
 * own label (an {@link IconButtonProps IconButton}'s `label`, a {@link ButtonProps Button}'s
 * text) and use the tooltip for the EXTRA hint, never the only one.
 *
 * Requires a {@link TooltipProviderProps TooltipProvider} ancestor (mount once at
 * the app root) — it shares the open-delay timing across tooltips. Platform-neutral
 * (§9): `content` is an i18n key; no `className`/`style`/raw DOM events.
 */
export interface TooltipProps extends BaseProps {
  /**
   * The trigger element — must be a focusable, already-LABELLED control. The
   * tooltip supplements it; it does not name it.
   */
  trigger: ReactNode
  /** Bubble text — an i18n key the consumer resolves. */
  content: string
  /** Preferred side to open toward. Default `top`. Radix flips it if there's no room. */
  side?: TooltipSide
}

/**
 * Provider for the {@link TooltipProps Tooltip} timing context. Mount ONCE near the
 * app root; it coordinates the shared open/close delay so moving between adjacent
 * triggers feels instant. Platform-neutral wrapper — no DOM props.
 */
export interface TooltipProviderProps extends BaseProps {
  /** Delay (ms) before a tooltip opens on hover. Default Radix value if omitted. */
  delayDuration?: number
}
