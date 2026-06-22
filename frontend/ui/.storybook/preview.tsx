import { useEffect } from 'react'
import type { Preview } from '@storybook/react-vite'
import './storybook.css'

const preview: Preview = {
  parameters: {
    // The a11y addon runs axe on every story; flag violations rather than
    // silently passing them through.
    a11y: { test: 'error' },
  },
  // Global toolbar toggle: every story renders against either the light
  // (paper) or warm-dark theme. The `.dark` class drives the semantic-token
  // cascade in semantic.css (:root vs .dark), so toggling it flips the whole
  // specimen — the same mechanism the app uses. The class lives on the ROOT
  // (<html>), not a story-local wrapper, so Radix PORTALS (Modal / Popover /
  // Select / Menu / Tooltip / Toast render to document.body, OUTSIDE the story
  // tree) still inherit the theme. Root-element theming is also the correct
  // real-app pattern.
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
      // document.body, outside this wrapper) inherit the theme too. Cleanup on
      // unmount / theme change keeps the class in lockstep with the toolbar.
      useEffect(() => {
        const root = document.documentElement
        root.classList.toggle('dark', dark)
        return () => {
          root.classList.remove('dark')
        }
      }, [dark])
      // The per-story wrapper keeps the in-tree background + padding; the theme
      // itself now cascades from <html>, so no `.dark` class is needed here.
      return (
        <div className="bg-bg text-ink p-6">
          <Story />
        </div>
      )
    },
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its preview; the repo applies the same exemption to vite/vitest config files.
export default preview
