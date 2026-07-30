import { Suspense } from 'react'
import { Stack, Heading, Spinner } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { SessionsBilling } from './billing/sessions-billing.tsx'

// The billing screen (`/billing`) — the Sessions & Billing surface's home since
// the NavBar IA rename (was `/settings`, MYT-95's interim address; the legacy
// path now redirects here). The section title over the wired billing
// composition, which reads the balance / skus / history suspense queries. The
// billing surface is mounted under a Suspense boundary so the screen paints its
// title + a Spinner immediately and degrades gracefully while the three reads
// resolve (the same shape the home hub and header credits use). Composes
// @mythrun/ui + i18n only (R5).
export function BillingRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-billing">
      <Heading level={1}>{t('billing.sectionTitle')}</Heading>
      <Suspense fallback={<Spinner />}>
        <SessionsBilling />
      </Suspense>
    </Stack>
  )
}
