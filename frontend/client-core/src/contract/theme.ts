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

/**
 * The canonical theme-toggle FAB. A square button with its OWN solid surface +
 * strong border so it floats cleanly ABOVE the dither crown (occluding it, never
 * embedded). Carries the pixel sun/moon Icon; ≥44px touch target; 0px radius.
 */
export interface ThemeToggleProps extends BaseProps {
  /** Accessible name (an i18n KEY the consumer resolves) for the icon-only control. */
  label: string
}
