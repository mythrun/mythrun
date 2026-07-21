import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Dedicated Vite config for the animation-audit gallery (an internal tooling
// surface, not shipped app code). It mirrors what matters from frontend/vite.config.ts
// (the react + tailwind plugins, and the single-instance `dedupe` belt that the
// workspace-injection npm setting makes load-bearing) and adds the single-file
// build knobs: EVERYTHING inlines (assets as data: URIs, one JS chunk, one CSS
// file), so fold.mjs can produce one self-contained HTML with zero external
// requests (the artifact host runs a strict CSP that blocks every external host).
export default defineConfig({
  root: __dirname,
  plugins: [react(), tailwindcss()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    // Inline every asset (fonts, any image) as a base64 data: URI — no separate
    // files for fold.mjs to chase, and nothing the CSP would block.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    // Leave the CSS readable so fold.mjs can find + neutralize the DS's
    // `@media (prefers-reduced-motion)` reset (the audit drives motion itself).
    cssMinify: false,
    modulePreload: false,
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
        entryFileNames: 'audit.js',
        assetFileNames: 'audit[extname]',
      },
    },
  },
})
