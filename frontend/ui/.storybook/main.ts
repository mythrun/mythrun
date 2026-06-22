import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'

const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  // Storybook builds its preview through its OWN Vite config, separate from
  // frontend/vite.config.ts. Without pushing @tailwindcss/vite in here, the
  // `@import "tailwindcss"` in storybook.css is never compiled and NO token
  // utilities apply in stories — the harness would render unstyled. This is
  // the load-bearing line that makes Tailwind v4 work in Storybook.
  viteFinal: (viteConfig) => {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()]
    return viteConfig
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its config; the repo applies the same exemption to vite/vitest config files.
export default config
