import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { Text, Spinner, Stack } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useBalance, useInvalidateBalance } from '@mythrun/client-core'
import { HeaderSlot } from './header-slot.tsx'

// The header credit-balance slot (MYT-87 T16, relabeled MYT-99, reconciled MYT-9jrh9).
// Reads the live SESSION balance via the `useBalance` suspense hook and renders it as
// a terse mono readout in the app frame: a visible "Session credits" label LEADING the
// number. The label is SPECIFIC — "Session credits", not a bare "Credits" — because the
// product has TWO currencies (session + world credits); a lone "Credits N" in the
// persistent header silently equalled the session bucket and taught the wrong model on
// the highest-traffic surface (MYT-9jrh9). The label leads (not a trailing unit) so it
// satisfies sentence case, and it doubles as the accessible name (a screen reader reads
// "Session credits 1,250"), so no visually-hidden label is needed.
//
// It lives in the ALWAYS-present frame, so `HeaderSlot` isolates it: Suspense paints
// a small spinner while the balance first loads (the frame never suspends as a
// whole), and a local error boundary drops the slot to nothing on a failed fetch.
// The "+" buy affordance beside it (owned by AppFrame, OUTSIDE this slot) still lets
// the player act even if the balance fetch fails.

/** The resolved balance number + its unit. Only rendered once `useBalance` has data
 *  (HeaderSlot's Suspense owns the loading state, its error boundary the failure).
 *  The bar's typography (navbar redesign): the label is quiet `chrome`, the number
 *  `chrome-strong` — semibold tabular accent, the bar's ONLY accent. */
function HeaderCreditsValue({ testId }: { readonly testId: string }): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { data } = useBalance()
  // Locale-aware grouping — mechanical formatting (ZFC-exempt), like the hub's
  // relative-time formatter. Both the number and its unit hold their width
  // (`noShrink`) so flexible siblings absorb the row's shrink, not this.
  const balance = new Intl.NumberFormat(i18n.language).format(data.session)
  return (
    <Stack direction="row" align="center" gap={2} noShrink data-testid={testId}>
      <Text role="chrome" noShrink>
        {t('frame.credits')}
      </Text>
      <Text role="chrome-strong" noShrink>
        {balance}
      </Text>
    </Stack>
  )
}

/** The header credits slot: the live session balance, resilient to a slow or
 *  failed balance fetch (loads behind a small spinner, degrades to empty on error).
 *  `data-testid` distinguishes the frame's two mounted instances (one per
 *  arrangement cluster: frame-credits-desktop / frame-credits-mobile). */
export function HeaderCredits({
  'data-testid': dataTestId = 'frame-credits',
}: {
  readonly 'data-testid'?: string
} = {}): React.JSX.Element {
  const { t } = useTranslation()
  const { pathname } = useLocation()
  const invalidateBalance = useInvalidateBalance()
  // Navigation-refresh contract (myth-bsyu9): the frame — and this slot —
  // persists across routes, so a balance spent mid-route (ending a session
  // deducts server-side) survived as a stale readout on the next surface (the
  // campaign hub briefly showed the pre-end number). Invalidating the shared
  // balance cache on every pathname change refetches in the background (the
  // readout updates in place; suspense only gates the first load) — one cheap
  // GET per navigation buys "the header is never stale across a navigation" as
  // a chrome-level contract, instead of relying on every credit-spending
  // mutation site to remember to invalidate. The mount run is skipped: the
  // suspense query is fetching right then.
  const lastPathname = useRef(pathname)
  useEffect(() => {
    if (lastPathname.current === pathname) return
    lastPathname.current = pathname
    invalidateBalance()
  }, [pathname, invalidateBalance])
  return (
    <HeaderSlot
      pending={<Spinner size="xs" label={t('frame.creditsLoading')} data-testid="frame-credits-loading" />}
    >
      <HeaderCreditsValue testId={dataTestId} />
    </HeaderSlot>
  )
}
