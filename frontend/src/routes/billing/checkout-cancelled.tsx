import { Stack, Heading, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'
import { BILLING_PATH } from '../../app/paths.ts'

// The Stripe checkout-CANCELLED screen (`/billing/cancelled`). Stripe redirects
// here when the player abandons Checkout — deliberately NOT an error surface: no
// charge was made. A calm notice + a quiet path back to the `/billing` screen.
// Composes @mythrun/ui + i18n only (R5). The billing path comes from the shared
// `paths.ts` consts so the `navigate(...)` argument is neither a JSX-attribute
// string literal nor a copy that can drift from the route tree.

export function CheckoutCancelledRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Stack gap={4} data-testid="route-checkout-cancelled">
      <Heading level={1}>{t('billing.cancelled.title')}</Heading>
      <Text as="p">{t('billing.cancelled.body')}</Text>
      <Button
        variant="ghost"
        onPress={() => void navigate(BILLING_PATH)}
        data-testid="checkout-cancelled-back"
      >
        {t('billing.cancelled.back')}
      </Button>
    </Stack>
  )
}
