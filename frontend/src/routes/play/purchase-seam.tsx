import { Heading, Text, PurchasePrompt } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { createCheckout, purchasePromptModel, useApiContext } from '@mythrun/client-core'
import type { ApiContext, CheckoutBody, PurchaseMoment } from '@mythrun/client-core'
import { currentOrigin, redirectTo } from '../../platform/web/navigation.ts'
import { CenteredHold } from './notices.tsx'

// The purchase-moment seam (MYT-92 T16 → wired by the MYT-95 merge). The start
// flow's 402 arm resolves to a `PurchaseMoment` — the cross-issue seam consumed
// here by MYT-95's `PurchasePrompt` (spec §4/§7):
//   • OWNER  → the real buy path: à-la-carte session credits via Stripe Checkout,
//     returning through the pinned /billing/return poll. Quantity presets mirror
//     the settings surface's terse set.
//   • MEMBER → the "the host is out of session credits" calm notice — a
//     non-owner buying would credit the WRONG ledger (their own), so the prompt's
//     ledger guard renders no CTA (spec §4).
// The `purchase-moment-seam` testid remains the stable mount point.

const SEAM_TESTID = 'purchase-moment-seam'
const QUANTITY_PRESETS: readonly number[] = [1, 4, 8]

/** Injectable checkout seam (tests drive a spy; the default is the real slice). */
export interface PurchaseSeamDeps {
  readonly checkout?: (ctx: ApiContext, body: CheckoutBody) => Promise<{ url: string }>
  readonly go?: (url: string) => void
}

export function PurchaseSeam({
  moment,
  deps = {},
}: {
  moment: PurchaseMoment
  deps?: PurchaseSeamDeps
}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const checkout = deps.checkout ?? createCheckout
  const go = deps.go ?? redirectTo

  if (!moment.viewerIsOwner) {
    return (
      <CenteredHold data-testid="play-purchase-not-owner">
        <Heading level={1} role="title">
          {t('play.purchase.notOwner.title')}
        </Heading>
        <Text role="ui-caption" as="p">
          {t('play.purchase.notOwner.body')}
        </Text>
      </CenteredHold>
    )
  }

  const model = purchasePromptModel(
    { code: 'insufficient_credits', available: moment.available, required: moment.required },
    moment.viewerIsOwner,
  )
  const onBuy = (quantity: number): void => {
    void checkout(ctx, {
      items: [{ lookup_key: 'sku_session', quantity }],
      success_url: `${currentOrigin()}/billing/return`,
      cancel_url: `${currentOrigin()}/billing/cancelled`,
    }).then((res) => {
      go(res.url)
    })
  }

  return (
    <CenteredHold data-testid={SEAM_TESTID}>
      <PurchasePrompt
        variant={model.variant}
        heading={t('play.purchase.owner.title')}
        body={t('play.purchase.owner.detail', {
          available: moment.available,
          required: moment.required,
        })}
        buyLabel={t('play.purchase.owner.buy')}
        quantityPresets={QUANTITY_PRESETS}
        onBuy={onBuy}
        data-testid="purchase-moment-prompt"
      />
    </CenteredHold>
  )
}
