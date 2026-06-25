import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { within, expect } from 'storybook/test'
import {
  ApiClientProvider,
  useSessionStore,
  type ApiContext,
  type CampaignSummary,
} from '@mythrun/client-core'
import { defaultNS } from '@mythrun/client-core/i18n'
import { routes } from '../app/router.tsx'
import { i18n } from '../i18n/config.ts'

// Router-bearing screen harness (MYT-97 §5). Screen stories render the REAL
// route tree at a seeded entry so the COMPOSITION layer (where the app-frame
// header bug lived) is gated, not just isolated primitives. The data the
// screens read is pre-seeded:
//   • session store → `ready` (the RequireAuth gate), so authed screens render.
//   • QueryClient cache → setQueryData(['campaigns','mine'], …) with
//     staleTime:Infinity. `useMyCampaigns` is a SUSPENSE query — a key/shape
//     mismatch hangs forever, so the story's `play` (expectScreen) asserts the
//     root testid and fails loud instead of timing out as a flake.
//   • i18nOverrides → swap an i18n placeholder for adversarial-length copy
//     (the app-frame display name is an i18n key, not a prop).
// A dummy ApiContext + the pre-seeded, never-stale cache mean no network call
// fires. Runs in real Chromium under the test-runner, so RR7's data router
// works without the jsdom-native-fetch shim the vitest env needs.

const STORYBOOK_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

type Session = 'unauthenticated' | 'onboarding-required' | 'ready'

export interface ScreenHarnessProps {
  /** The MemoryRouter entry to render (with seeded :params), e.g. `/home`. */
  readonly entry: string
  /** Seeded session status for the RequireAuth gate. Default `ready`. */
  readonly session?: Session
  /** Pre-seed the `['campaigns','mine']` suspense cache (home hub). */
  readonly seedCampaigns?: readonly CampaignSummary[]
  /** Override i18n keys (e.g. an adversarial-length `frame.displayName`). */
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
    return { client: queryClient, router: createMemoryRouter(routes, { initialEntries: [entry] }) }
  })

  return (
    <QueryClientProvider client={client}>
      <ApiClientProvider value={STORYBOOK_CTX}>
        <I18nextProvider i18n={i18n}>
          <RouterProvider router={router} />
        </I18nextProvider>
      </ApiClientProvider>
    </QueryClientProvider>
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
