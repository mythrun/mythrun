import { Component, Suspense } from 'react'
import type { ReactNode } from 'react'
import { Text, Spinner, VisuallyHidden } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useBalance } from '@mythrun/client-core'

// The header credit-balance slot (MYT-87 T16). Reads the live SESSION balance via
// the `useBalance` suspense hook and renders it as a terse mono number in the app
// frame. Because it is a suspense query living in the ALWAYS-present frame, it is
// wrapped so a slow/failed balance fetch degrades ONLY this slot, never the whole
// authed shell:
//   • Suspense — a small spinner while the balance first loads. The frame paints
//     immediately; only the number slot waits (the brief's "doesn't suspend the
//     whole frame").
//   • a LOCAL error boundary — on a balance fetch failure the slot renders nothing.
//     The "+" buy affordance beside it (owned by AppFrame, outside this boundary)
//     still lets the player act. Non-critical header chrome must not tear down the
//     whole route via the router error boundary.
//
// In production AppProviders always supplies the QueryClient + ApiContext, so the
// boundary only ever catches a genuine balance fetch failure (a 5xx / network
// blip); it is not papering over a missing provider at runtime.

interface CreditsBoundaryState {
  readonly failed: boolean
}

// React error boundaries have no hook form — a class is the only way to catch a
// child render/query error. Module-private; renders nothing on failure.
class CreditsErrorBoundary extends Component<{ children: ReactNode }, CreditsBoundaryState> {
  override state: CreditsBoundaryState = { failed: false }

  static getDerivedStateFromError(): CreditsBoundaryState {
    return { failed: true }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

/** The resolved balance number. Only rendered once `useBalance` has data (the
 *  Suspense boundary owns the loading state, the error boundary the failure). */
function HeaderCreditsValue(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { data } = useBalance()
  // Locale-aware grouping — mechanical formatting (ZFC-exempt), like the hub's
  // relative-time formatter. The bare number carries a visually-hidden label so a
  // screen reader announces what it is.
  const balance = new Intl.NumberFormat(i18n.language).format(data.session)
  return (
    <Text role="data" noShrink data-testid="frame-credits">
      <VisuallyHidden>{t('frame.credits')}</VisuallyHidden>
      {balance}
    </Text>
  )
}

/** The header credits slot: the live session balance, resilient to a slow or
 *  failed balance fetch (loads behind a small spinner, degrades to empty on error). */
export function HeaderCredits(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <CreditsErrorBoundary>
      <Suspense
        fallback={
          <Spinner
            size="xs"
            label={t('frame.creditsLoading')}
            data-testid="frame-credits-loading"
          />
        }
      >
        <HeaderCreditsValue />
      </Suspense>
    </CreditsErrorBoundary>
  )
}
