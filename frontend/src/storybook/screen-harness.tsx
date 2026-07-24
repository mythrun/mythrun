import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { within, expect } from 'storybook/test'
import {
  ApiClientProvider,
  useSessionStore,
  type ApiContext,
  type BalanceResponse,
  type CampaignSummary,
  type MeResponse,
} from '@mythrun/client-core'
import { ThemeProvider } from '@mythrun/ui'
import { defaultNS } from '@mythrun/client-core/i18n'
import { routes } from '../app/router.tsx'
import { i18n } from '../i18n/config.ts'

// Router-bearing screen harness (MYT-97 §5). Screen stories render the REAL
// route tree at a seeded entry so the COMPOSITION layer (where the app-frame
// header bug lived) is gated, not just isolated primitives. The data the
// screens read is pre-seeded:
//   • session store → `ready` (the RequireAuth gate), so authed screens render.
//   • QueryClient cache → setQueryData(['campaigns','mine'], …) and, for the
//     header credit display + display name, setQueryData(['billing','balance'], …)
//     and setQueryData(['me'], …) — all with staleTime:Infinity. `useMyCampaigns` /
//     `useBalance` / `useMe` are SUSPENSE queries — a key/shape mismatch hangs
//     forever, so the story's `play` (expectScreen) asserts the root testid and
//     fails loud instead of timing out as a flake.
//   • seedMe → the display name is DATA (from `useMe`); an adversarial-length name
//     is seeded here (a story prop), not swapped as i18n copy.
//   • i18nOverrides → swap a catalog key for adversarial-length copy.
// A dummy ApiContext + the pre-seeded, never-stale cache mean no network call
// fires. Runs in real Chromium under the test-runner, so RR7's data router
// works without the jsdom-native-fetch shim the vitest env needs.

const STORYBOOK_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

// The app-frame header now reads the live balance on EVERY authed route (MYT-87
// T16 `useBalance`), so any authed screen would otherwise suspend-hang on the
// (unseeded) balance cache. Seed a representative default for every story so the
// header credits render deterministically; a story passes `seedBalance` to
// override with a specific value. A dummy value is harmless on the public screens
// that never render the frame.
const DEFAULT_BALANCE: BalanceResponse = {
  session: 120,
  world_gen: 4,
  active_subscription: null,
}

// The app-frame header now reads the signed-in display name on EVERY authed route
// (MYT-99 `useMe`), so any authed screen would otherwise suspend-hang on the
// (unseeded) `['me']` cache. Seed a representative default for every story so the
// header identity renders deterministically; a story passes `seedMe` to override
// (e.g. an adversarial-length name that must truncate).
const DEFAULT_ME: MeResponse = {
  user: {
    id: 'dev-user-1',
    username: 'wren',
    displayName: 'Wren',
    freeTrialUsed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

type Session = 'unauthenticated' | 'onboarding-required' | 'ready'

export interface ScreenHarnessProps {
  /** The MemoryRouter entry to render (with seeded :params), e.g. `/home`. */
  readonly entry: string
  /** Seeded session status for the RequireAuth gate. Default `ready`. */
  readonly session?: Session
  /** Pre-seed the `['campaigns','mine']` suspense cache (home hub). */
  readonly seedCampaigns?: readonly CampaignSummary[]
  /** Pre-seed the `['billing','balance']` suspense cache (header credits). */
  readonly seedBalance?: BalanceResponse
  /** Pre-seed the `['me']` suspense cache (header identity / display name). */
  readonly seedMe?: MeResponse
  /** Override i18n keys (e.g. adversarial-length catalog copy). */
  readonly i18nOverrides?: Readonly<Record<string, string>>
}

function seedSession(session: Session): void {
  const store = useSessionStore.getState()
  if (session === 'ready') store.setReady('dev-user-1')
  else if (session === 'onboarding-required') store.setOnboardingRequired('dev-user-1')
  else store.setUnauthenticated()
}

export function ScreenHarness({
  entry,
  session = 'ready',
  seedCampaigns,
  seedBalance,
  seedMe,
  i18nOverrides,
}: ScreenHarnessProps): React.JSX.Element {
  // Lazy init: one-time per story mount, before children render, so the auth
  // gate + suspense query read the seeded state on the first paint.
  const [{ client, router }] = useState(() => {
    if (i18nOverrides) {
      for (const [key, value] of Object.entries(i18nOverrides)) {
        i18n.addResource('en', defaultNS, key, value)
      }
    }
    seedSession(session)
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false },
      },
    })
    if (seedCampaigns) {
      queryClient.setQueryData(['campaigns', 'mine'], { campaigns: seedCampaigns })
    }
    // Always seed a balance + a `me` (the frame reads both on every authed route) —
    // the props override the defaults for a story that asserts a specific value.
    queryClient.setQueryData(['billing', 'balance'], seedBalance ?? DEFAULT_BALANCE)
    queryClient.setQueryData(['me'], seedMe ?? DEFAULT_ME)
    return { client: queryClient, router: createMemoryRouter(routes, { initialEntries: [entry] }) }
  })

  // ThemeProvider mirrors the real app shell (AppProviders) so theme-aware screens —
  // e.g. the auth screens' ThemeToggle FAB calling useTheme — have their context in
  // stories. Without it the screen stories throw "useTheme must be used within a
  // ThemeProvider" under the test-runner.
  return (
    <ThemeProvider>
      <QueryClientProvider client={client}>
        <ApiClientProvider value={STORYBOOK_CTX}>
          <I18nextProvider i18n={i18n}>
            <RouterProvider router={router} />
          </I18nextProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </ThemeProvider>
  )
}

/**
 * A CSF `play` that asserts the screen's root testid is present — so a
 * non-render (e.g. a suspense-hang from a bad seed shape) fails LOUD, not as a
 * silent timeout-flake.
 */
export function expectScreen(testid: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }): Promise<void> => {
    await expect(await within(canvasElement).findByTestId(testid)).toBeInTheDocument()
  }
}
