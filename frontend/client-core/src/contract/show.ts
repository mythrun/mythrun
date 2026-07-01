import type { BaseProps } from './index.ts'

/** The responsive breakpoints — the named min-width steps the theme defines
 *  (`--breakpoint-sm` 640px … `--breakpoint-2xl` 1536px). */
export type Breakpoint = 'sm' | 'md' | 'lg' | 'xl' | '2xl'

/**
 * Responsive show/hide primitive — a breakpoint SWITCH for two visually distinct
 * layouts that don't reflow into each other (e.g. a desktop card GRID vs a mobile
 * INDEX list). It renders its children always and toggles their VISIBILITY at a
 * breakpoint via CSS, so exactly one sibling `Show` is visible at a time; the
 * hidden branch is `display:none` (out of layout AND the a11y tree).
 *
 * Exactly one of `above` / `below` is given (a compile-time XOR):
 *  - `above="sm"` → visible at/above `sm` (hidden below it).
 *  - `below="sm"` → visible below `sm` (hidden at/above it).
 *
 * Platform-neutral (§9): a neutral breakpoint enum, no className/style/DOM events.
 * (Native renders the matching branch off its own dimensions; the contract is the
 * same `above`/`below` intent.)
 */
export type ShowProps = BaseProps &
  ({ above: Breakpoint; below?: never } | { below: Breakpoint; above?: never })
