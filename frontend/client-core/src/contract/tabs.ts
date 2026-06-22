import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/**
 * A single tab + its panel. `value` is the stable string the consumer keys on;
 * `label` is an i18n key for the tab's display text; `content` is the panel body.
 */
export interface TabItem {
  /** Stable value — what `onChange` reports and `value`/`defaultValue` match. */
  value: string
  /** Tab display text — an i18n key the consumer resolves. */
  label: string
  /** Panel content shown when this tab is active. */
  content: ReactNode
  /** When true, the tab is present but non-selectable. */
  disabled?: boolean
}

/**
 * Tabs. The web impl wraps the unstyled Radix `Tabs` primitive (roving-tabindex
 * ArrowKey navigation across the tab list, ARIA `tablist`/`tab`/`tabpanel` wiring
 * — `aria-controls`/`aria-labelledby` between each tab and its panel); styled 100%
 * with our tokens. The active tab is marked with a flat `--border-strong` underline
 * indicator (token, no shadow), per the 1-bit register.
 *
 * Platform-neutral (§9): `onChange(value)` is the neutral value callback, never a
 * DOM event; no `className`/`style`/raw DOM events.
 *
 * Controlled when `value` is supplied (pair with `onChange`); uncontrolled with
 * `defaultValue` otherwise.
 */
export interface TabsProps extends BaseProps {
  /** The tabs + their panels. Each `label` is an i18n key; `value` is the stable selected string. */
  items: readonly TabItem[]
  /** Controlled active value. When supplied the Tabs are controlled (pair with `onChange`). */
  value?: string
  /** Uncontrolled initial active value. Ignored when `value` is supplied. */
  defaultValue?: string
  /** Neutral value callback — receives the newly-active tab value, not a DOM event (§9). */
  onChange?: (value: string) => void
  /**
   * Accessible label for the tab list — an i18n key. Wired to `aria-label` on the
   * `tablist` so screen-reader users know what the tabs switch between.
   */
  label: string
}
