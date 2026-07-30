import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Suspense } from 'react'
import type { ReactNode } from 'react'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nextProvider } from 'react-i18next'
import {
  ApiClientProvider,
  type ApiContext,
  type BalanceResponse,
  type SkuListing,
  type BillingHistoryEvent,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { SessionsBilling } from './sessions-billing.tsx'

// The wired Sessions & Billing surface (MYT-95 Task 11) — the composition layer:
// it reads the three billing suspense queries (balance / skus / history), derives
// the two-bucket balance view, the price-ordered tier catalogue with the gated
// CTA per tier (the double-subscribe guard, spec §4), the à-la-carte packs, and
// the terse history feed, then routes each affordance to the right client-core
// mutation (checkout / upgrade-tier / portal). MSW stands in for the backend at
// the wire level; the platform navigation seam is mocked so the external Stripe
// redirects are observable (a screen never touches `window` itself, R1).

const BASE_URL = 'http://api.test'
const server = setupServer()

// The platform seam (src/platform/web/**) is the sanctioned web-globals carve-out;
// the screen imports `redirectTo`/`currentOrigin`/`currentHref` from it instead of
// touching `window`/`location`. Mock it so the external redirect target + the
// origin-derived return URLs are deterministic and observable.
const redirectTo = vi.fn<(url: string) => void>()
vi.mock('../../platform/web/navigation.ts', () => ({
  redirectTo: (url: string) => {
    redirectTo(url)
  },
  currentOrigin: () => 'http://test.local',
  currentHref: () => 'http://test.local/billing',
}))

const testCtx: ApiContext = {
  baseUrl: BASE_URL,
  getAuthHeaders: () => Promise.resolve({}),
}

// Mirror the component's own Intl money formatter so the expected prose never
// drifts with the host locale data — including the MYT-9jrh9 rule that a whole
// amount drops its trailing `.00` ("$5", not "$5.00").
function money(cents: number, currency: string): string {
  const whole = cents % 100 === 0
  return new Intl.NumberFormat(i18n.language, {
    style: 'currency',
    currency,
    ...(whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
  }).format(cents / 100)
}

function tier(overrides: Partial<SkuListing> & Pick<SkuListing, 'lookup_key' | 'displayName'>): SkuListing {
  return {
    type: 'recurring',
    sessionsGranted: 8,
    worldsGranted: 1,
    price: { unit_amount_cents: 1200, currency: 'usd' },
    ...overrides,
  }
}
function pack(overrides: Partial<SkuListing> & Pick<SkuListing, 'lookup_key' | 'displayName'>): SkuListing {
  return {
    type: 'one_time',
    sessionsGranted: 1,
    worldsGranted: 0,
    price: { unit_amount_cents: 500, currency: 'usd' },
    ...overrides,
  }
}

// The real per-tier grants (backend/src/billing/lookup-keys.ts is the source of
// truth; the frontend never hardcodes them — it renders whatever /skus serves).
const WAYFARER = tier({ lookup_key: 'tier_wayfarer', displayName: 'Wayfarer', sessionsGranted: 4, worldsGranted: 1, price: { unit_amount_cents: 1500, currency: 'usd' } })
const SOJOURNER = tier({ lookup_key: 'tier_sojourner', displayName: 'Sojourner', sessionsGranted: 8, worldsGranted: 2, price: { unit_amount_cents: 2500, currency: 'usd' } })
const MYTHWRIGHT = tier({ lookup_key: 'tier_mythwright', displayName: 'Mythwright', sessionsGranted: 16, worldsGranted: 4, price: { unit_amount_cents: 4500, currency: 'usd' } })
const SESSION_PACK = pack({ lookup_key: 'sku_session', displayName: 'Session', sessionsGranted: 1, worldsGranted: 0, price: { unit_amount_cents: 500, currency: 'usd' } })
// The world SKU grants a world AND a session — a bought world arrives playable.
const WORLD_PACK = pack({ lookup_key: 'sku_world', displayName: 'World', sessionsGranted: 1, worldsGranted: 1, price: { unit_amount_cents: 800, currency: 'usd' } })

const ALL_SKUS: readonly SkuListing[] = [WAYFARER, SOJOURNER, MYTHWRIGHT, SESSION_PACK, WORLD_PACK]

const NO_SUB: BalanceResponse = { session: 120, world_gen: 4, active_subscription: null }
const WAYFARER_SUB: BalanceResponse = {
  session: 3,
  world_gen: 0,
  active_subscription: {
    tier_lookup_key: 'tier_wayfarer',
    current_period_end: '2026-08-01T00:00:00.000Z',
    cancel_at_period_end: false,
    status: 'active',
  },
}

function balanceOk(balance: BalanceResponse) {
  return http.get(`${BASE_URL}/api/billing/balance`, () => HttpResponse.json(balance))
}
function skusOk(skus: readonly SkuListing[] = ALL_SKUS) {
  return http.get(`${BASE_URL}/api/billing/skus`, () => HttpResponse.json(skus))
}
function historyOk(events: readonly BillingHistoryEvent[] = []) {
  return http.get(`${BASE_URL}/api/billing/history`, () => HttpResponse.json({ events, nextCursor: null }))
}

// The three POST mutations capture the request body so the test can assert the
// exact shape the screen sends (the credit-ledger surface — the body is
// load-bearing).
let lastCheckout: unknown = null
let lastUpgrade: unknown = null
let lastPortal: unknown = null
function checkoutOk(url = 'https://stripe.test/checkout/cs_1') {
  return http.post(`${BASE_URL}/api/billing/checkout`, async ({ request }) => {
    lastCheckout = await request.json()
    return HttpResponse.json({ checkout_session_id: 'cs_1', url })
  })
}
function portalOk(url = 'https://stripe.test/portal/bps_1') {
  return http.post(`${BASE_URL}/api/billing/portal`, async ({ request }) => {
    lastPortal = await request.json()
    return HttpResponse.json({ url })
  })
}
function upgradeOk() {
  return http.post(`${BASE_URL}/api/billing/upgrade-tier`, async ({ request }) => {
    lastUpgrade = await request.json()
    return HttpResponse.json({ invoice_id: 'in_1' })
  })
}
function upgradeConflict() {
  return http.post(`${BASE_URL}/api/billing/upgrade-tier`, () =>
    HttpResponse.json(
      { code: 'upgrade_already_pending', detail: { pending_update_expires_at: 1, latest_invoice_id: 'in_0' } },
      { status: 409 },
    ),
  )
}

// The surface now reads `useLocation` (the `#buy` deep-link scroll), so every
// mount needs a router context. A MemoryRouter over the given initial entry
// stands in for the app's data router — the path (and its hash) is the only
// routing input the surface consumes.
function renderBillingAt(initialPath: string): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }): React.JSX.Element => (
    <MemoryRouter initialEntries={[initialPath]}>
      <QueryClientProvider client={client}>
        <ApiClientProvider value={testCtx}>
          <I18nextProvider i18n={i18n}>
            <Suspense fallback={<div data-testid="loading" />}>{children}</Suspense>
          </I18nextProvider>
        </ApiClientProvider>
      </QueryClientProvider>
    </MemoryRouter>
  )
  render(wrapper({ children: <SessionsBilling /> }))
}

function renderSurface(): void {
  renderBillingAt('/billing')
}

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' })
})
beforeEach(() => {
  redirectTo.mockReset()
  lastCheckout = null
  lastUpgrade = null
  lastPortal = null
})
afterEach(() => {
  // Web's vitest config sets no `globals`, so testing-library's auto-cleanup is
  // not registered — `cleanup()` must UNMOUNT the prior render (mirrors
  // campaign-new.test / landing.test), else leftover trees leak across cases.
  cleanup()
  server.resetHandlers()
})
afterAll(() => {
  server.close()
})

describe('Sessions & Billing surface (wired)', () => {
  it('renders both credit buckets independently — never a summed total', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk())
    renderSurface()

    const surface = await screen.findByTestId('sessions-billing')
    expect(surface).toBeDefined()
    expect(screen.getByTestId('credit-balance-session-value').textContent).toBe('120')
    expect(screen.getByTestId('credit-balance-world-gen-value').textContent).toBe('4')
  })

  // myth-9jrh9: the two counters were bare label-number pairs. Each bucket now carries
  // its own explainer INSIDE its own tile — what one credit buys, and what zero costs.
  it('explains each currency inside its own tile — what one credit buys and what zero means', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    const sessionTile = within(screen.getByTestId('credit-balance-session'))
    expect(sessionTile.getByText(i18n.t('billing.sessionHelp'))).toBeDefined()
    expect(sessionTile.getByText(i18n.t('billing.sessionZeroHelp'))).toBeDefined()

    const worldTile = within(screen.getByTestId('credit-balance-world-gen'))
    expect(worldTile.getByText(i18n.t('billing.worldGenHelp'))).toBeDefined()
    expect(worldTile.getByText(i18n.t('billing.worldGenZeroHelp'))).toBeDefined()
  })

  // The decidability fix (myth-9jrh9): the tier cards' grant ledgers are derived from
  // the SKU payload's own sessionsGranted/worldsGranted, so the pricing UI cannot
  // drift from Stripe. Wired end-to-end here — MSW serves the numbers, the screen
  // renders them.
  it('renders each tier’s per-month grants straight off the /skus payload', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    const perMonth = (n: number): string => i18n.t('billing.grantPerMonth', { amount: String(n) })

    const wayfarer = within(screen.getByTestId('pack-list-tier-tier_wayfarer'))
    expect(wayfarer.getByText(perMonth(4))).toBeDefined()
    expect(wayfarer.getByText(perMonth(1))).toBeDefined()

    const mythwright = within(screen.getByTestId('pack-list-tier-tier_mythwright'))
    expect(mythwright.getByText(perMonth(16))).toBeDefined()
    expect(mythwright.getByText(perMonth(4))).toBeDefined()

    // The same two field labels in the same order in every tier — the comparison.
    for (const key of ['tier_wayfarer', 'tier_sojourner', 'tier_mythwright']) {
      const labels = within(screen.getByTestId(`pack-list-tier-${key}`))
        .getAllByTestId(/grant-label$/)
        .map((el) => el.textContent)
      expect(labels).toEqual([i18n.t('billing.grantSessions'), i18n.t('billing.grantWorlds')])
    }
  })

  // The à-la-carte section is the top-up path on this screen. A pack's ledger states
  // what ONE unit grants — the session pack shows no worlds row (a "Worlds 0" line is
  // noise), and the world pack shows both, which is how the reader learns a bought
  // world arrives playable.
  it('renders the à-la-carte top-up section with each pack’s per-unit grants', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    expect(screen.getByText(i18n.t('billing.alaCarteTitle'))).toBeDefined()
    expect(screen.getByText(i18n.t('billing.alaCarteHelp'))).toBeDefined()

    const sessionPack = within(screen.getByTestId('pack-list-pack-sku_session'))
    expect(sessionPack.getAllByTestId(/grant-label$/).map((el) => el.textContent)).toEqual([
      i18n.t('billing.grantSessions'),
    ])

    const worldPack = within(screen.getByTestId('pack-list-pack-sku_world'))
    expect(worldPack.getAllByTestId(/grant-label$/).map((el) => el.textContent)).toEqual([
      i18n.t('billing.grantSessions'),
      i18n.t('billing.grantWorlds'),
    ])
  })

  // Consumer pricing, not a formatted database decimal: $15 / month, never $15.00.
  it('formats a whole subscription price without the developer cents', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    expect(screen.getByText(i18n.t('billing.pricePerMonth', { price: money(1500, 'usd') }))).toBeDefined()
    expect(screen.queryByText(/\$15\.00/)).toBeNull()
  })

  it('renders the three named tiers and applies CTA gating — a subscriber never sees subscribe', async () => {
    server.use(balanceOk(WAYFARER_SUB), skusOk(), historyOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    // Current tier → manage (marked current); higher tiers → upgrade; none subscribe.
    expect(screen.getByTestId('pack-list-tier-cta-tier_wayfarer').textContent).toBe(i18n.t('billing.manage'))
    expect(screen.getByTestId('pack-list-tier-cta-tier_sojourner').textContent).toBe(i18n.t('billing.upgrade'))
    expect(screen.getByTestId('pack-list-tier-cta-tier_mythwright').textContent).toBe(i18n.t('billing.upgrade'))
    expect(screen.getByText(i18n.t('billing.current'))).toBeDefined()
    expect(screen.queryByText(i18n.t('billing.subscribe'))).toBeNull()
  })

  it('subscribe (no active sub) opens Checkout for the tier and redirects', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk(), checkoutOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    fireEvent.click(screen.getByTestId('pack-list-tier-cta-tier_sojourner'))

    await waitFor(() => {
      expect(redirectTo).toHaveBeenCalledWith('https://stripe.test/checkout/cs_1')
    })
    expect(lastCheckout).toEqual({
      items: [{ lookup_key: 'tier_sojourner', quantity: 1 }],
      success_url: 'http://test.local/billing/return',
      cancel_url: 'http://test.local/billing/cancelled',
    })
  })

  it('upgrade (active sub, higher tier) calls upgrade-tier with the target key', async () => {
    server.use(balanceOk(WAYFARER_SUB), skusOk(), historyOk(), upgradeOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    fireEvent.click(screen.getByTestId('pack-list-tier-cta-tier_mythwright'))

    await waitFor(() => {
      expect(lastUpgrade).toEqual({ target_tier_lookup_key: 'tier_mythwright' })
    })
    expect(redirectTo).not.toHaveBeenCalled()
  })

  it('a 409 upgrade_already_pending renders the calm pending arm, not an error', async () => {
    server.use(balanceOk(WAYFARER_SUB), skusOk(), historyOk(), upgradeConflict())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    fireEvent.click(screen.getByTestId('pack-list-tier-cta-tier_sojourner'))

    const pending = await screen.findByTestId('billing-pending-upgrade')
    expect(pending.textContent).toBe(i18n.t('billing.pendingUpgrade'))
  })

  it('the portal link opens the Customer Portal with the current href and redirects', async () => {
    server.use(balanceOk(WAYFARER_SUB), skusOk(), historyOk(), portalOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    fireEvent.click(screen.getByTestId('billing-portal-link'))

    await waitFor(() => {
      expect(redirectTo).toHaveBeenCalledWith('https://stripe.test/portal/bps_1')
    })
    expect(lastPortal).toEqual({ return_url: 'http://test.local/billing' })
  })

  it('the à-la-carte buy opens Checkout for the pack at the chosen quantity', async () => {
    // Only the session pack as à-la-carte so the preset button "4" is unambiguous.
    server.use(balanceOk(NO_SUB), skusOk([WAYFARER, SESSION_PACK]), historyOk(), checkoutOk())
    renderSurface()
    await screen.findByTestId('sessions-billing')

    // The preset button (not the world-gen balance readout, which may also read "4").
    fireEvent.click(screen.getByRole('button', { name: '4' }))
    fireEvent.click(screen.getByTestId('pack-list-buy-sku_session'))

    await waitFor(() => {
      expect(redirectTo).toHaveBeenCalledWith('https://stripe.test/checkout/cs_1')
    })
    expect(lastCheckout).toEqual({
      items: [{ lookup_key: 'sku_session', quantity: 4 }],
      success_url: 'http://test.local/billing/return',
      cancel_url: 'http://test.local/billing/cancelled',
    })
  })

  it('renders the terse history feed — a pack row names no credit count; an invoice names its tier', async () => {
    const events: BillingHistoryEvent[] = [
      { id: 'h1', kind: 'purchase', occurred_at: '2026-07-10T00:00:00.000Z', amount_cents: 500, currency: 'usd', lookup_key: null, status: 'completed', source_id_stripe: 'pi_1' },
      { id: 'h2', kind: 'invoice', occurred_at: '2026-07-09T00:00:00.000Z', amount_cents: 4800, currency: 'usd', lookup_key: 'tier_mythwright', status: 'completed', source_id_stripe: 'in_1' },
      { id: 'h3', kind: 'refund', occurred_at: '2026-07-08T00:00:00.000Z', amount_cents: 500, currency: 'usd', lookup_key: null, status: 'refunded', source_id_stripe: 're_1' },
    ]
    server.use(balanceOk(NO_SUB), skusOk(), historyOk(events))
    renderSurface()
    await screen.findByTestId('sessions-billing')

    const packRow = screen.getByTestId('purchase-history-row-h1')
    expect(packRow.textContent).toBe(i18n.t('billing.history.purchase', { amount: money(500, 'usd') }))
    expect(packRow.textContent).not.toMatch(/credit/i)
    expect(screen.getByTestId('purchase-history-row-h2').textContent).toBe(
      i18n.t('billing.history.subscription', { tier: 'Mythwright', amount: money(4800, 'usd') }),
    )
    const refundRow = screen.getByTestId('purchase-history-row-h3')
    expect(refundRow.textContent).toContain(i18n.t('billing.history.refundedSuffix'))
  })

  it('renders the empty history state when there are no rows', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk([]))
    renderSurface()
    await screen.findByTestId('sessions-billing')

    expect(screen.getByTestId('purchase-history-empty').textContent).toBe(i18n.t('billing.history.empty'))
  })

  // The NavBar's "Add credits" deep-link: /billing#buy must land the reader ON the
  // purchase section, not the top of the screen. jsdom implements no scrolling, so
  // the spy on the prototype IS the observable — the section mounts below the
  // Suspense boundary, meaning the scroll can only fire after the data resolved.
  it('arriving with #buy scrolls the purchase section into view after data resolves', async () => {
    server.use(balanceOk(NO_SUB), skusOk(), historyOk())
    const scrollSpy = vi.fn()
    window.HTMLElement.prototype.scrollIntoView = scrollSpy
    renderBillingAt('/billing#buy')
    await screen.findByTestId('billing-buy-section')
    await waitFor(() => {
      expect(scrollSpy).toHaveBeenCalled()
    })
  })
})
