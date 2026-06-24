import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import { App } from './app.tsx'
import { type AppProvidersConfig } from './app/providers.tsx'
import { createWebSecureStorage } from './platform/web/secure-storage.ts'
import './index.css'

// The web entry — the ONE place a web-only DOM touch is allowed (the
// `document.getElementById('root')` mount; lint-exempt per the R1 carve-out).
// It also resolves the provider config from the build/runtime environment ONCE,
// at module scope — never inline in render, so the ApiContext memo in
// `AppProviders` stays stable across re-renders (a fresh config object would
// rebuild it every render). Dev runs the bypass auth seam (sends
// `x-mythrun-dev-sub`); prod runs the JWT seam (Bearer from secure storage).
const config: AppProvidersConfig = import.meta.env.DEV
  ? {
      baseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3030',
      authMode: 'bypass',
      devSub: import.meta.env.VITE_DEV_SUB ?? 'dev-user-1',
      secureStorage: createWebSecureStorage(),
    }
  : {
      baseUrl: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:3030',
      authMode: 'jwt',
      secureStorage: createWebSecureStorage(),
    }

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  )
}
