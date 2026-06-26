import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { Theme, ThemeContextValue } from '@mythrun/client-core/contract'

// The theme runtime. Lives in @mythrun/ui (the web UI package — DOM-capable, like
// Spinner's matchMedia) so the @mythrun/ui ThemeToggle can consume `useTheme()`
// (the brain stays DOM-free). Applies/removes `.dark` on <html>, persists to
// localStorage('mythrun-theme'); default = stored ?? prefers-color-scheme. A tiny
// inline script in index.html applies the class BEFORE React mounts (no FOUC);
// this provider reconciles to the same value, so there is no flip on hydrate.
const STORAGE_KEY = 'mythrun-theme'

function readStored(): Theme | null {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : null
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme: dark)').matches
}

function resolveInitial(): Theme {
  return readStored() ?? (systemPrefersDark() ? 'dark' : 'light')
}

function applyClass(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

export function ThemeProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [theme, setThemeState] = useState<Theme>(resolveInitial)

  // Keep <html>.dark in sync with state (covers the toggle + a hydrate where the
  // pre-paint script and the resolved state ever disagree).
  useEffect(() => {
    applyClass(theme)
  }, [theme])

  const setTheme = useCallback((next: Theme): void => {
    localStorage.setItem(STORAGE_KEY, next)
    setThemeState(next)
  }, [])

  const toggle = useCallback((): void => {
    setThemeState((prev) => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark'
      localStorage.setItem(STORAGE_KEY, next)
      return next
    })
  }, [])

  const value = useMemo<ThemeContextValue>(() => ({ theme, toggle, setTheme }), [theme, toggle, setTheme])
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Read the active theme + the toggle/set actions. Must be under a <ThemeProvider>. */
export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (ctx === null) throw new Error('useTheme must be used within a ThemeProvider')
  return ctx
}
