import type { StorybookConfig } from '@storybook/react-vite'
import tailwindcss from '@tailwindcss/vite'

// The ONE frontend-level Storybook (MYT-97 §5). It scans BOTH the design
// system (../ui/src) and the app shell (../src) stories — hosted in @mythrun/web
// because web already depends on ui (hosting web stories in the ui Storybook
// would invert the dependency into a cycle). The 375/1280 overflow gate
// (test-runner) runs against the build this config produces.
const config: StorybookConfig = {
  framework: '@storybook/react-vite',
  stories: ['../ui/src/**/*.stories.tsx', '../src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y'],
  // Storybook builds its preview through its OWN Vite config. Pushing
  // @tailwindcss/vite here is the load-bearing line that compiles the
  // `@import "tailwindcss"` in storybook.css so token utilities apply.
  viteFinal: (viteConfig) => {
    viteConfig.plugins = [...(viteConfig.plugins ?? []), tailwindcss()]
    // build-storybook compiles a PRODUCTION bundle where `import.meta.env.DEV` is
    // statically false — which tree-shakes the DEV-only routes (the /dev/transport
    // harness in router.tsx) and their components out of the build entirely, so their
    // screen stories route to the 404 and fail the overflow gate. Storybook IS a dev
    // surface (and the transport harness lives only there), so force DEV=true: the dev
    // routes + components ship into the preview bundle and their stories render the real
    // route. Components render identically dev/prod, so the overflow measurements are
    // unaffected — this only restores the DEV-gated routes the prod build dropped.
    viteConfig.define = { ...(viteConfig.define ?? {}), 'import.meta.env.DEV': 'true' }
    return viteConfig
  },
}

// eslint-disable-next-line no-restricted-syntax -- Storybook requires a default export for its config; the repo applies the same exemption to vite/vitest config files.
export default config
