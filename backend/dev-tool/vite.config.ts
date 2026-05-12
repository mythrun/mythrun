import { defineConfig } from 'vite'

// Local-only dev server. Proxy makes /api/* and /health/* requests
// same-origin from the browser's perspective so no CORS plugin is
// needed on the backend.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
    fs: { strict: true },
    proxy: {
      '/api': 'http://localhost:3000',
      '/health': 'http://localhost:3000',
    },
  },
})
