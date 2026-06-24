import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Single-instance belt: under `.npmrc`'s `inject-workspace-packages=true`,
  // workspace deps are injected (not symlinked to a single store entry), so
  // react / react-dom / react-query can each resolve to more than one copy —
  // which breaks hooks (duplicate React) and the QueryClient context (duplicate
  // react-query). `dedupe` forces every importer onto one copy of each.
  resolve: { dedupe: ['react', 'react-dom', '@tanstack/react-query'] },
})
