import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/** Side of the trigger the menu content prefers to open toward. */
export type MenuSide = 'top' | 'right' | 'bottom' | 'left'

/**
 * A single menu item. `value` is the stable string identifying the action;
 * `label` is an i18n key for its display text. Selecting it fires the menu's
 * neutral {@link MenuProps.onSelect onSelect} with this `value`.
 */
export interface MenuItem {
  /** Stable value reported to `onSelect` when this item is chosen. */
  value: string
  /** Item display text — an i18n key the consumer resolves. */
  label: string
  /** When true, the item is present but non-selectable. */
  disabled?: boolean
}

/**
 * A non-interactive header row (e.g. the identity line atop the mobile frame
 * menu). Rendered as a Radix `DropdownMenu.Label`: visible text, NOT a
 * menuitem — never keyboard-highlighted, never announced as disabled (a
 * `disabled` MenuItem is the WRONG tool for a header: screen readers announce
 * it as dimmed/unavailable).
 */
export interface MenuHeaderRow {
  /** Discriminant. */
  header: true
  /** Row display text — an i18n key the consumer resolves. */
  label: string
}

/**
 * A structural divider between item groups (rendered as a Radix Separator:
 * `role="separator"`, never a keyboard stop). Menus that mix navigation with an
 * exit action separate the two — Log out never sits flush under a nav item.
 */
export interface MenuSeparatorRow {
  /** Discriminant. */
  separator: true
}

/** One row of a menu: an actionable item, a non-interactive header, or a separator. */
export type MenuEntry = MenuItem | MenuHeaderRow | MenuSeparatorRow

/**
 * Placement rule-set for the dropdown, chosen by WHERE the trigger lives —
 * geometry is encoded here once, never hand-tuned per call site.
 *
 * - `'trigger'` (default) — an inline menu (card actions, list rows): centered
 *   under its trigger, 4px offset, 10rem width floor.
 * - `'bar-end'` — the app-bar rule-set, for menus hanging from right-side
 *   chrome: END-aligned so the menu's trailing edge shares the trigger's
 *   trailing edge (the bar's content gutter line; Radix's centered default
 *   collision-shifts into the raw viewport edge from there), an 8px drop,
 *   16px collision padding so the panel never touches the viewport, and a
 *   width floor of max(12rem, trigger width) so the panel reads anchored to
 *   the control that opened it.
 */
export type MenuPlacement = 'trigger' | 'bar-end'

/**
 * Dropdown menu. The web impl wraps the unstyled Radix `DropdownMenu` primitive
 * (open on Enter/Space/ArrowDown, roving ArrowKey navigation across items, Enter to
 * select, `Esc`-to-close with focus-RETURN to the trigger, a portalled content
 * layer, ARIA `menu`/`menuitem` wiring); styled 100% with our tokens.
 *
 * Platform-neutral (§9): selection is the neutral `onSelect(value)` callback, never
 * a DOM event; open/close is `onOpenChange(open)`; no `className`/`style`/raw DOM
 * events.
 *
 * Controlled-open when `open` is supplied (pair with `onOpenChange`); uncontrolled
 * otherwise.
 */
export interface MenuProps extends BaseProps {
  /**
   * The trigger element (e.g. a {@link ButtonProps Button} or {@link IconButtonProps IconButton}).
   * Rendered through Radix `DropdownMenu.Trigger`; focus returns here on close. REQUIRED.
   */
  trigger: ReactNode
  /**
   * The menu rows: actionable items (each `label` an i18n key; `value` the
   * stable action id) and/or non-interactive {@link MenuHeaderRow header rows}.
   */
  items: readonly MenuEntry[]
  /** Neutral selection callback — receives the chosen item's `value`, not a DOM event (§9). */
  onSelect?: (value: string) => void
  /** Controlled open state. When supplied the menu open-state is controlled (pair with `onOpenChange`). */
  open?: boolean
  /** Neutral open-state callback — receives the next boolean, not a DOM event (§9). */
  onOpenChange?: (open: boolean) => void
  /** Preferred side to open toward. Default `bottom`. Radix flips it if there's no room. */
  side?: MenuSide
  /** Geometry rule-set (see {@link MenuPlacement}). Default `'trigger'`. */
  placement?: MenuPlacement
}
