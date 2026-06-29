import type { BaseProps } from './index.ts'

/** The two themes the running app supports. */
export type Theme = 'light' | 'dark'

/** The value `useTheme()` returns (the ThemeProvider's context). DOM-free type — the impl (with the `<html>.dark` + localStorage side effects) lives in the web UI package. */
export interface ThemeContextValue {
  /** The active theme. */
  theme: Theme
  /** Flip light↔dark (and persist). */
  toggle: () => void
  /** Set an explicit theme (and persist). */
  setTheme: (theme: Theme) => void
}

/** Where the theme toggle sits: a fixed top-right FAB, or a normal in-flow control. */
export type ThemeTogglePlacement = 'fab' | 'inline'

// The theme toggle. `placement='fab'` (default) is the fixed top-right FAB used
// on genesis screens (signin, onboard). `placement='inline'` drops the fixed
// positioning for a normal in-flow control (e.g. a nav cluster).
export interface ThemeToggleProps extends BaseProps {
  /** Accessible name (an i18n KEY the consumer resolves) for the icon-only control. */
  label: string
  /** Positioning mode. Default `'fab'` (fixed top-right); `'inline'` is in-flow. */
  placement?: ThemeTogglePlacement
}
