import { AppProviders, type AppProvidersConfig } from './app/providers.tsx'
import { AppRouter } from './app/router.tsx'

// The app shell: the provider stack (QueryClient + ApiContext + i18n) wrapping
// the router. `main.tsx` builds the concrete `config` from the environment +
// the web SecureStorage impl and passes it in, so the shell itself stays
// config-driven (and testable with a fake config). This is the composition the
// browser entry mounts.
export function App({ config }: { config: AppProvidersConfig }): React.JSX.Element {
  return (
    <AppProviders config={config}>
      <AppRouter />
    </AppProviders>
  )
}
