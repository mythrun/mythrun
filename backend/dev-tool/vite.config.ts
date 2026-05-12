import { defineConfig, loadEnv } from 'vite'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

// Local-only dev server. Proxy makes /api/* and /health/* requests
// same-origin from the browser's perspective so no CORS plugin is
// needed on the backend.
//
// The proxy target port is read from `backend/.env.development`'s PORT
// value (Vite's loadEnv resolves it). Single source of truth — change
// PORT in one place and both the backend AND this proxy align. Defaults
// to 3000 if the env file is missing or doesn't set PORT.
export default defineConfig(({ mode }) => {
  const backendEnv = loadEnv(mode, resolve(here, '..'), '')
  const backendPort = backendEnv.PORT ?? '3000'
  const backendTarget = `http://localhost:${backendPort}`

  return {
    server: {
      host: '127.0.0.1',
      port: 5273,
      strictPort: true,
      fs: { strict: true },
      proxy: {
        '/api': backendTarget,
        '/health': backendTarget,
      },
    },
  }
})
