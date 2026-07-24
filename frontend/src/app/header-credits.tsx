import { Text, Spinner, Stack } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useBalance } from '@mythrun/client-core'
import { HeaderSlot } from './header-slot.tsx'

// The header credit-balance slot (MYT-87 T16, relabeled MYT-99). Reads the live
// SESSION balance via the `useBalance` suspense hook and renders it as a terse mono
// readout in the app frame: a visible "Credits" label LEADING the number, so the
// counter says what it is instead of being a bare number (MYT-99 complaint #3). The
// label leads (not a trailing unit) so it satisfies sentence case — the first word
// carries the capital — and it doubles as the accessible name (a screen reader reads
// "Credits 1,250"), so no visually-hidden label is needed.
//
// It lives in the ALWAYS-present frame, so `HeaderSlot` isolates it: Suspense paints
// a small spinner while the balance first loads (the frame never suspends as a
// whole), and a local error boundary drops the slot to nothing on a failed fetch.
// The "+" buy affordance beside it (owned by AppFrame, OUTSIDE this slot) still lets
// the player act even if the balance fetch fails.

/** The resolved balance number + its unit. Only rendered once `useBalance` has data
 *  (HeaderSlot's Suspense owns the loading state, its error boundary the failure). */
function HeaderCreditsValue(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { data } = useBalance()
  // Locale-aware grouping — mechanical formatting (ZFC-exempt), like the hub's
  // relative-time formatter. Both the number and its unit hold their width
  // (`noShrink`) so the display-name sibling absorbs the row's shrink, not this.
  const balance = new Intl.NumberFormat(i18n.language).format(data.session)
  return (
    <Stack direction="row" align="center" gap={2} noShrink data-testid="frame-credits">
      <Text role="meta" noShrink>
        {t('frame.credits')}
      </Text>
      <Text role="data" noShrink>
        {balance}
      </Text>
    </Stack>
  )
}

/** The header credits slot: the live session balance, resilient to a slow or
 *  failed balance fetch (loads behind a small spinner, degrades to empty on error). */
export function HeaderCredits(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <HeaderSlot
      pending={<Spinner size="xs" label={t('frame.creditsLoading')} data-testid="frame-credits-loading" />}
    >
      <HeaderCreditsValue />
    </HeaderSlot>
  )
}
