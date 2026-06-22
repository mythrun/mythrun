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
  // cascade in semantic.css (:root vs .dark), so toggling it here flips the
  // whole specimen — the same mechanism the app uses.
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
      return (
        <div className={dark ? 'dark bg-bg text-ink p-6' : 'bg-bg text-ink p-6'}>
          <Story />
        </div>
      )
    },
  ],
}

// eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its preview; the repo applies the same exemption to vite/vitest config files.
export default preview
