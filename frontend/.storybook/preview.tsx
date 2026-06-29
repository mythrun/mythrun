import { useEffect } from 'react'
import type { Preview } from '@storybook/react-vite'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './storybook.css'

const preview: Preview = {
  parameters: {
    // a11y is ENFORCED on component stories (MYT-97). `error` fails the
    // test-runner on any axe violation, so the gate now enforces OVERFLOW AND
    // a11y. The bare form-control specimens carry their own accessible name
    // (wrapped in FormField / an associated label) and the Radix dropdown/select
    // OPEN specimens keep a documented per-story carve-out that suppresses ONLY
    // the `aria-hidden-focus` false-positive (every other rule stays enforced).
    // Screen stories are placeholder stubs that set a11y:{test:'off'} — their a11y
    // belongs to the flow tickets, not this gate.
    a11y: { test: 'error' },
  },
  globalTypes: {
    theme: {
      description: 'Light / warm-dark theme',
      toolbar: {
        title: 'Theme',
        icon: 'circlehollow',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Warm dark' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  decorators: [
    (Story, context) => {
      const dark = context.globals.theme === 'dark'
      // Drive the screen-harness ThemeProvider from the toolbar: it resolves its
      // initial theme from localStorage('mythrun-theme') ONCE at mount, so seed that
      // key from the toolbar (before the story mounts) and key the story on the theme
      // below so a toolbar toggle RE-MOUNTS the provider to the new theme. Without this,
      // screen stories' useTheme() ignores the toolbar — the CSS flips via `.dark` but
      // the screen's theme-conditional logic (e.g. the landing dither's DIRECTION) stays
      // stale. Component stories read the `.dark` class directly, so this is harmless there.
      localStorage.setItem('mythrun-theme', dark ? 'dark' : 'light')
      // Toggle `.dark` on the document root so PORTALED overlays (rendered to
      // document.body, outside this wrapper) inherit the theme too.
      useEffect(() => {
        const root = document.documentElement
        root.classList.toggle('dark', dark)
        return () => {
          root.classList.remove('dark')
        }
      }, [dark])

      // Screens render edge-to-edge (real viewport budget); component specimens
      // get the p-6 breathing room. The `data-sb-pad` hook lets the overflow
      // gate neutralize the specimen padding so a ≤375-but-wide component is
      // measured against the TRUE 375px budget, not 375−48.
      // key on the theme so a toolbar toggle re-mounts the story, re-initializing the
      // ThemeProvider (seeded above) to the new theme.
      const themeKey = dark ? 'dark' : 'light'
      if (context.parameters.layout === 'fullscreen') {
        return <Story key={themeKey} />
      }
      return (
        <div key={themeKey} data-sb-pad className="bg-bg text-ink p-6">
          <Story />
        </div>
      )
    },
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its preview; the repo applies the same exemption to vite/vitest config files.
export default preview
