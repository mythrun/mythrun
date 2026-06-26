import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import {
  ApiClientProvider,
  getAuthHeaders,
  isHttpError,
  type ApiContext,
  type AuthHeaderOptions,
  type SecureStorage,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'

// `AppProviders` is the web shell's one composition root: it stands up the
// single QueryClient, resolves the ApiContext from build/runtime config, and
// nests the i18n runtime — the order every screen renders inside. It is
// config-driven (not reading `import.meta.env` directly) so it is testable with
// a fake SecureStorage + an explicit auth mode; `main.tsx` builds the concrete
// config from the environment and the web SecureStorage impl (W3b).
//
// The Zustand session store (`useSessionStore`) is a module-level global hook
// with no provider — it is available to any descendant by import and defaults
// to `unauthenticated`. There is intentionally no session "provider" here.

/**
 * Build/runtime configuration for the provider stack. `authMode` selects the
 * auth seam: `bypass` (dev — sends `x-mythrun-dev-sub`) carries a `devSub`;
 * `jwt` (prod — Bearer from secure storage) does not. Both carry the
 * `secureStorage` handle the auth producer closes over.
 */
export type AppProvidersConfig = { baseUrl: string; secureStorage: SecureStorage } & (
  | { authMode: 'bypass'; devSub: string }
  | { authMode: 'jwt' }
)

/** Maps the flat app config to `getAuthHeaders`' discriminated-union options. */
function toAuthHeaderOptions(config: AppProvidersConfig): AuthHeaderOptions {
  if (config.authMode === 'bypass') {
    return { mode: 'bypass', devSub: config.devSub }
  }
  return { mode: 'jwt' }
}

export function AppProviders({
  config,
  children,
}: {
  config: AppProvidersConfig
  children: ReactNode
}): React.JSX.Element {
  // One QueryClient for the app's lifetime: created once, never on re-render
  // (a fresh client would drop the cache). Sane defaults — one retry, no
  // refetch-on-focus — so flows get reasonable behaviour without per-call config.
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // A 4xx is the server's terminal answer — never retry it (the only
            // legitimate retry is the auth refresh, which defineEndpoint owns).
            // Other failures (network blips, 5xx) keep the single retry.
            retry: (failureCount, error) => {
              if (isHttpError(error) && error.status >= 400 && error.status < 500) return false
              return failureCount < 1
            },
            refetchOnWindowFocus: false,
          },
        },
      }),
    [],
  )

  // The resolved ApiContext: where the backend lives + how to authenticate.
  // Rebuilt only when the config changes (stable across normal re-renders).
  const apiContext = useMemo<ApiContext>(
    () => ({ baseUrl: config.baseUrl, getAuthHeaders: getAuthHeaders(toAuthHeaderOptions(config)) }),
    [config],
  )

  return (
    <QueryClientProvider client={queryClient}>
      <ApiClientProvider value={apiContext}>
        <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
      </ApiClientProvider>
    </QueryClientProvider>
  )
}
