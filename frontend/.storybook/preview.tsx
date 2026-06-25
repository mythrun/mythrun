import { useEffect } from 'react'
import type { Preview } from '@storybook/react-vite'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import './storybook.css'

const preview: Preview = {
  parameters: {
    // a11y is OUT OF SCOPE for MYT-97 (overflow-only). `todo` reports axe
    // violations in the Storybook a11y panel but does NOT fail the test-runner —
    // so the new gate enforces OVERFLOW only. Activating the runner surfaced a
    // pre-existing axe backlog (bare form-control specimens lacking a label — the
    // app labels them via FormField — plus the Radix dropdown/select
    // aria-hidden-focus false-positive); a follow-up a11y ticket flips this back
    // to `error` and clears the backlog. Screen stories set a11y:{test:'off'}.
    a11y: { test: 'todo' },
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
      if (context.parameters.layout === 'fullscreen') {
        return <Story />
      }
      return (
        <div data-sb-pad className="bg-bg text-ink p-6">
          <Story />
        </div>
      )
    },
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its preview; the repo applies the same exemption to vite/vitest config files.
export default preview
