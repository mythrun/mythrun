import { Navigate, Outlet } from 'react-router-dom'
import { Box, Stack, Spinner } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useSessionStore } from '@mythrun/client-core'

// The auth gate the whole authed tree hangs on. It reads ONLY the session store's
// `status` (the client brain's single source of truth, R1) — no token parsing, no
// backend call, no local intelligence:
//
//   initializing        → render a neutral splash (NOT a redirect): the on-load
//                          refresh has not settled, so we must not race it to
//                          sign-in. The boot bootstrap transitions us out of this.
//   unauthenticated     → bounce to sign-in (no identity yet)
//   onboarding-required → bounce to onboarding (identity known, profile not)
//   ready               → render the matched authed route (<Outlet/>)
//
// `replace` keeps the pre-auth URL out of history so Back doesn't loop the gate.
export function RequireAuth(): React.JSX.Element {
  const { t } = useTranslation()
  const status = useSessionStore((s) => s.status)

  if (status === 'initializing') {
    return (
      <Stack align="center" justify="center" minHeight="screen" data-testid="auth-splash">
        <Box padding={6}>
          <Spinner label={t('splash.loading')} />
        </Box>
      </Stack>
    )
  }
  if (status === 'unauthenticated') {
    return <Navigate to="/auth/signin" replace />
  }
  if (status === 'onboarding-required') {
    return <Navigate to="/auth/onboard" replace />
  }
  return <Outlet />
}
