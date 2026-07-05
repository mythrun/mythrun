import { AppProviders, type AppProvidersConfig } from './app/providers.tsx'
import { AppRouter } from './app/router.tsx'
import { DevCostTicker } from './dev/dev-cost-ticker.tsx'

// The app shell: the provider stack (QueryClient + ApiContext + i18n) wrapping
// the router. `main.tsx` builds the concrete `config` from the environment +
// the web SecureStorage impl and passes it in, so the shell itself stays
// config-driven (and testable with a fake config). This is the composition the
// browser entry mounts.
//
// `DevCostTicker` is mounted ONCE here — a sibling of the router, above the
// routed <Outlet/> — so the dev/staging-only floating API-cost widget persists
// across navigation. It renders inside AppProviders (it reads the ApiContext)
// and auto-hides in production (its endpoint 404s), so mounting it
// unconditionally is safe.
export function App({ config }: { config: AppProvidersConfig }): React.JSX.Element {
  return (
    <AppProviders config={config}>
      <AppRouter />
      <DevCostTicker />
    </AppProviders>
  )
}
