import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/source-serif-4/400.css'
import '@fontsource/source-serif-4/600.css'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import {
  useSessionStore,
  configureOAuth,
  configureTokenRefresh,
  configureStreamingFetch,
  refreshSession,
  bootstrapSession,
} from '@mythrun/client-core'
import { App } from './app.tsx'
import { type AppProvidersConfig, toApiContext } from './app/providers.tsx'
import { createWebSecureStorage } from './platform/web/secure-storage.ts'
import { createWebOAuthStateStore } from './platform/web/oauth-state-store.ts'
import { createWebStreamingFetch } from './platform/web/streaming-fetch.ts'
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

// Wire the SSE streaming-fetch seam UNCONDITIONALLY (both auth modes), at module
// scope. It is the realtime transport's one platform-divergent dependency; unlike
// configureTokenRefresh (jwt-only, in the else branch below), the DEV/bypass build
// still opens SSE/WS — the /dev/transport harness runs in DEV — so this must NOT
// be fenced inside either auth branch.
configureStreamingFetch(createWebStreamingFetch())

// DEV BOOTSTRAP (bypass only): the dev backend's bypass auth seam is always
// authenticated (it injects `request.user.sub` on every request), so the dev app
// should land on the authed side of <RequireAuth> rather than bounce to sign-in.
// Bypass implies an authenticated dev identity, so seed the session store `ready`
// ONCE at module scope with the dev sub. In `jwt` mode (the else branch below) we
// instead wire the OAuth helper + kick the on-load refresh → /me bootstrap, leaving
// the store `initializing` until it settles (RequireAuth shows the splash meanwhile).
if (config.authMode === 'bypass') {
  useSessionStore.getState().setReady(config.devSub)
} else {
  // jwt mode: wire the OAuth helper ONCE at boot — the single-use state store + the
  // Cognito Hosted UI config (PUBLIC build values, safe in the bundle). The
  // redirect_uri is derived from THIS origin and MUST exact-match the backend's
  // server-derived `${frontendBaseUrl}/auth/callback` AND the Cognito app-client
  // callback URL (Task 1). `window` is allowed here (the web entry).
  configureOAuth({
    store: createWebOAuthStateStore(),
    cognito: {
      domain: import.meta.env.VITE_COGNITO_HOSTED_UI_DOMAIN,
      clientId: import.meta.env.VITE_COGNITO_APP_CLIENT_ID,
      redirectUri: `${window.location.origin}/auth/callback`,
      scopes: ['openid', 'email', 'profile'],
    },
  })
  // Wire the refresh transport BEFORE kicking the on-load bootstrap. CRITICAL
  // ORDERING: bootstrapSession's refresh is a silent no-op if the token manager's
  // refreshFn isn't set yet — performRefresh returns false WITHOUT calling
  // /api/auth/refresh. refreshFn was previously configured ONLY in an AppProviders
  // useEffect, which runs AFTER this module-scope bootstrap, so on every reload the
  // on-load refresh never fired and the user bounced to sign-in. Set it here, first.
  const apiContext = toApiContext(config)
  configureTokenRefresh(() => refreshSession(undefined, apiContext))
  // … then kick the on-load refresh → /me mapping. The store stays `initializing`
  // (its default) until this settles — RequireAuth shows the splash meanwhile.
  // Transitions to ready / onboarding-required / unauthenticated. Fire-and-forget:
  // it must NOT block first paint (spec §3) — the splash covers the gap.
  void bootstrapSession(apiContext)
}

const rootEl = document.getElementById('root')
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <App config={config} />
    </StrictMode>,
  )
}
