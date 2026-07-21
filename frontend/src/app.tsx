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
// routed <Outlet/> — so the dev-only floating API-cost widget persists across
// navigation. The mount is a BUILD-TIME gate (myth-oay3q): `import.meta.env.DEV`
// is the literal `false` in every built bundle (staging AND prod ship prod
// builds), so `false && <DevCostTicker />` is statically dead — Rollup drops the
// JSX, the now-unused import, and thus the whole dev-cost-ticker module + its
// `/api/dev/api-cost` client. The widget therefore TREE-SHAKES OUT of built
// bundles (no marker strings, no poll loop), rather than shipping and hiding at
// runtime — the earlier state, where the code + endpoint string still shipped
// and staging's env-gated (not bypass-gated) backend answered 200, so the ticker
// rendered and polled there. The widget keeps its own `import.meta.env.DEV`
// default + 404-hide as belt-and-suspenders for the dev server.
export function App({ config }: { config: AppProvidersConfig }): React.JSX.Element {
  return (
    <AppProviders config={config}>
      <AppRouter />
      {import.meta.env.DEV && <DevCostTicker />}
    </AppProviders>
  )
}
