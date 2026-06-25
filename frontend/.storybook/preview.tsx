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
