import { useEffect } from 'react'
import { Navigate, useNavigate, useRouteError } from 'react-router-dom'
import { Stack, Box, Heading, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { isHttpError, isContractValidationError, useSessionStore } from '@mythrun/client-core'

// The route-level error boundary (react-router `errorElement`). It catches a
// render/loader failure and branches on the data layer's TYPED errors (§3) — no
// message parsing, no local intelligence — so each failure class gets the right
// treatment:
//
//   401 HttpError              → the session expired: reset the store to
//                                `unauthenticated` and bounce to sign-in. (The
//                                `<RequireAuth>` gate then owns the redirect on
//                                every subsequent navigation.)
//   other HttpError / Network  → a transient, retryable failure: a retry screen.
//   ContractValidationError    → a backend shape drift: a dev-facing "contract
//                                drift" message (loud in dev, per §2/§3).
//   anything else              → falls through to the generic retryable screen.

/** The 401 arm: clear the session, then redirect to sign-in. */
function ExpiredSession(): React.JSX.Element {
  useEffect(() => {
    useSessionStore.getState().setUnauthenticated()
  }, [])
  return <Navigate to="/auth/signin" replace />
}

/** A contract-drift (backend shape mismatch) dev message. */
function ContractDrift(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Box padding={6} data-testid="error-contract">
      <Stack align="center" gap={4}>
        <Heading level={1} role="heading">
          {t('error.contractTitle')}
        </Heading>
        <Text as="p" role="prose-body">
          {t('error.contractBody')}
        </Text>
      </Stack>
    </Box>
  )
}

/** The generic transient-failure screen, with a retry affordance. */
function RetryableError(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Box padding={6} data-testid="error-retryable">
      <Stack align="center" gap={4}>
        <Heading level={1} role="heading">
          {t('error.title')}
        </Heading>
        <Text as="p" role="prose-body">
          {t('error.body')}
        </Text>
        <Button
          variant="primary"
          onPress={() => {
            // Re-run the current route (re-fires its loader / re-mounts the
            // screen); the wired home hub (W3e) swaps this for React-Query's
            // `reset()` once the data-layer error path exists.
            void navigate(0)
          }}
          data-testid="error-retry"
        >
          {t('error.retry')}
        </Button>
      </Stack>
    </Box>
  )
}

export function RouteErrorBoundary(): React.JSX.Element {
  const error = useRouteError()

  if (isHttpError(error) && error.status === 401) {
    return <ExpiredSession />
  }
  if (isContractValidationError(error)) {
    return <ContractDrift />
  }
  // Non-401 HttpError, NetworkError, and any unrecognised throw all share the
  // generic retryable screen — the safe default lets the user re-attempt the
  // action. (NetworkError is a transient transport failure; the retry re-runs
  // the route.)
  return <RetryableError />
}
