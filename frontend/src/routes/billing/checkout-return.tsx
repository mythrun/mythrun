import { Stack, Text, Spinner, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { useCheckoutReturn } from '@mythrun/client-core'
import { BILLING_PATH } from '../../app/paths.ts'

// The Stripe checkout-RETURN screen (`/billing/return`). Stripe redirects here
// after a completed Checkout Session, but the credit grant rides the async
// `checkout.session.completed` webhook — so the balance can't be confirmed
// synchronously. `useCheckoutReturn` (Task 6) polls it and resolves to one of
// three CALM terminal beats:
//   polling    — still confirming (a Spinner + a reassuring line).
//   settled    — the polled balance changed; the credits have landed.
//   processing — the poll budget expired before the balance moved: the payment
//                completed, the grant is merely still in flight. A calm NON-error
//                beat (never a failure claim for a paid checkout) that points the
//                player at the `/billing` purchase history where the grant will
//                appear.
// Composes @mythrun/ui + i18n only (R5). The billing path comes from the shared
// `paths.ts` consts so the `navigate(...)` argument is neither a JSX-attribute
// string literal nor a copy that can drift from the route tree.

export function CheckoutReturnRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { status } = useCheckoutReturn()

  return (
    <Stack gap={4} data-testid="route-checkout-return">
      {status === 'polling' ? (
        <Stack direction="row" align="center" gap={3} data-testid="checkout-return-polling">
          <Spinner />
          <Text as="p">{t('billing.return.polling')}</Text>
        </Stack>
      ) : null}
      {status === 'settled' ? (
        <Text as="p" data-testid="checkout-return-settled">
          {t('billing.return.settled')}
        </Text>
      ) : null}
      {status === 'processing' ? (
        <Stack gap={3} data-testid="checkout-return-processing">
          <Text as="p">{t('billing.return.processing')}</Text>
          <Button
            variant="ghost"
            onPress={() => void navigate(BILLING_PATH)}
            data-testid="checkout-return-history"
          >
            {t('billing.return.viewHistory')}
          </Button>
        </Stack>
      ) : null}
    </Stack>
  )
}
