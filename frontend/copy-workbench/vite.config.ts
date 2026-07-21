import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dedicated Vite config for the copy-workbench (an internal tooling surface, not
// shipped app code). Mirrors frontend/animation-audit/vite.config.ts: the react +
// tailwind plugins, the single-instance `dedupe` belt, and the single-file build
// knobs (every asset inlined as a data: URI, one JS chunk, one CSS file) so
// fold.mjs can emit one self-contained HTML with zero external requests (the
// artifact host runs a strict CSP that blocks every external host).
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    cssMinify: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'workbench.js',
        assetFileNames: 'workbench[extname]',
      },
    },
  },
})
