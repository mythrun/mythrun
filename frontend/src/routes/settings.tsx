import { Suspense } from 'react'
import { Stack, Heading, Spinner } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { SessionsBilling } from './settings/sessions-billing.tsx'

// The settings screen (`/settings`). Today it is the Sessions & Billing surface
// (MYT-95): the section title over the wired billing composition, which reads the
// balance / skus / history suspense queries. The billing surface is mounted under a
// Suspense boundary so the screen paints its title + a Spinner immediately and
// degrades gracefully while the three reads resolve (the same shape the home hub
// and header credits use). Composes @mythrun/ui + i18n only (R5).
export function SettingsRoute(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="route-settings">
      <Heading level={1}>{t('billing.sectionTitle')}</Heading>
      <Suspense fallback={<Spinner />}>
        <SessionsBilling />
      </Suspense>
    </Stack>
  )
}
