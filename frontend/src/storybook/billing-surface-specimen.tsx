import { Suspense, useState } from 'react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import { Spinner } from '@mythrun/ui'
import {
  ApiClientProvider,
  type ApiContext,
  type BalanceResponse,
  type SkuListing,
  type BillingHistoryEvent,
} from '@mythrun/client-core'
import { i18n } from '../i18n/config.ts'
import { SessionsBilling } from '../routes/billing/sessions-billing.tsx'
import { BILLING_PATH } from '../app/paths.ts'

// A seeded specimen of the Sessions & Billing surface (MYT-95) for the billing
// screen stories. The surface reads THREE billing suspense queries (balance / skus
// / history); the dead-API route tree can never reach the settled state (they'd
// suspend forever), so — like Screens/CampaignPage — we render the surface DIRECTLY
// against a pre-seeded, never-stale QueryClient cache: an honest deterministic
// specimen of the real composition the 375/1280 overflow gate can measure. Lives in
// `src/storybook/**` (not a route file) so it may hold the QueryClient wiring the
// `src/routes/**` react-query ban keeps out of the screens themselves.
//
// The story picks only the balance (subscriber vs. not — which drives the whole
// CTA-gating surface); the catalogue + history fixtures are fixed here.

const STORYBOOK_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

function sku(over: Partial<SkuListing> & Pick<SkuListing, 'lookup_key' | 'displayName' | 'type'>): SkuListing {
  return { sessionsGranted: 8, worldsGranted: 1, price: { unit_amount_cents: 1200, currency: 'usd' }, ...over }
}

// The real catalogue shape (backend/src/billing/lookup-keys.ts): the per-tier grants
// are what the cards' ledgers compare, so the specimen must carry the REAL ladder —
// a fixture where every tier grants the same thing would show three identical cards
// and quietly re-stage the decidability defect this surface was fixed for
// (myth-9jrh9). The world SKU grants a world AND a session (a bought world arrives
// playable).
const SKUS: readonly SkuListing[] = [
  sku({ lookup_key: 'tier_wayfarer', displayName: 'Wayfarer', type: 'recurring', sessionsGranted: 4, worldsGranted: 1, price: { unit_amount_cents: 1500, currency: 'usd' } }),
  sku({ lookup_key: 'tier_sojourner', displayName: 'Sojourner', type: 'recurring', sessionsGranted: 8, worldsGranted: 2, price: { unit_amount_cents: 2500, currency: 'usd' } }),
  sku({ lookup_key: 'tier_mythwright', displayName: 'Mythwright', type: 'recurring', sessionsGranted: 16, worldsGranted: 4, price: { unit_amount_cents: 4500, currency: 'usd' } }),
  sku({ lookup_key: 'sku_session', displayName: 'Session', type: 'one_time', sessionsGranted: 1, worldsGranted: 0, price: { unit_amount_cents: 500, currency: 'usd' } }),
  sku({ lookup_key: 'sku_world', displayName: 'World', type: 'one_time', sessionsGranted: 1, worldsGranted: 1, price: { unit_amount_cents: 800, currency: 'usd' } }),
]

const HISTORY_EVENTS: readonly BillingHistoryEvent[] = [
  { id: 'h1', kind: 'invoice', occurred_at: '2026-07-09T00:00:00.000Z', amount_cents: 1200, currency: 'usd', lookup_key: 'tier_wayfarer', status: 'completed', source_id_stripe: 'in_2' },
  { id: 'h2', kind: 'purchase', occurred_at: '2026-07-04T00:00:00.000Z', amount_cents: 500, currency: 'usd', lookup_key: null, status: 'completed', source_id_stripe: 'pi_1' },
  { id: 'h3', kind: 'purchase', occurred_at: '2026-06-28T00:00:00.000Z', amount_cents: 800, currency: 'usd', lookup_key: null, status: 'refunded', source_id_stripe: 'pi_0' },
]

export const NON_SUBSCRIBER_BALANCE: BalanceResponse = { session: 120, world_gen: 4, active_subscription: null }
export const SUBSCRIBER_BALANCE: BalanceResponse = {
  session: 8,
  world_gen: 2,
  active_subscription: {
    tier_lookup_key: 'tier_wayfarer',
    current_period_end: '2026-08-01T00:00:00.000Z',
    cancel_at_period_end: false,
    status: 'active',
  },
}

export function BillingSurfaceSpecimen({ balance }: { readonly balance: BalanceResponse }): React.JSX.Element {
  const [client] = useState(() => {
    const c = new QueryClient({
      defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } },
    })
    c.setQueryData(['billing', 'balance'], balance)
    c.setQueryData(['billing', 'skus'], SKUS)
    c.setQueryData(['billing', 'history'], { events: HISTORY_EVENTS, nextCursor: null })
    return c
  })
  // SessionsBilling reads location.hash (the #buy deep-link scroll), so the
  // specimen owns the MemoryRouter (the Screens/CampaignPage precedent) — every
  // consumer gets a router for free, at the plain path so the scroll stays inert.
  return (
    <MemoryRouter initialEntries={[BILLING_PATH]}>
      <QueryClientProvider client={client}>
        <ApiClientProvider value={STORYBOOK_CTX}>
          <I18nextProvider i18n={i18n}>
            <Suspense fallback={<Spinner />}>
              <SessionsBilling />
            </Suspense>
          </I18nextProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
}
