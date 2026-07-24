import { useEffect } from 'react'
import { Navigate, useNavigate, useRouteError } from 'react-router-dom'
import { Stack, Box, Heading, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { isHttpError, isContractValidationError, useSessionStore } from '@mythrun/client-core'
import { readRetryAttempts, recordRetryAttempt } from '../platform/web/retry-tracker.ts'

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

// Escalate once this many retries have already re-failed in the current burst.
// The retry does a full `navigate(0)` reload (screens throw from suspense queries,
// not loaders, so a soft revalidate can't clear the cached error), which resets
// React state — so the count is persisted out-of-band (retry-tracker) and the
// boundary reads it on each fresh mount. After the threshold the copy stops
// pretending a moment's patience will help and names the likely cause.
const ESCALATE_AFTER = 2

/** A terse support reference from a typed error — the HTTP code/status when we
 *  have one (the console carries the full object regardless). */
function errorReference(error: unknown): string | null {
  if (isHttpError(error)) return error.code ?? String(error.status)
  return null
}

/**
 * The generic transient-failure screen. On the first failures it offers a plain
 * "try again"; once retries keep re-failing (a persistent cause — a dead network,
 * a down backend) it escalates the copy and offers a harder reset, and it logs
 * the underlying error to the console every time it shows so a stuck loop is
 * diagnosable rather than silent (myth-t1ccl).
 */
function RetryableError({ error }: { error: unknown }): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const attempts = readRetryAttempts()
  const escalated = attempts >= ESCALATE_AFTER
  const reference = errorReference(error)

  // Diagnostics: the boundary swallows the failure visually, so mirror it to the
  // console (with the retry count) — the only place a persistent, silently-looping
  // failure can be inspected.
  useEffect(() => {
    console.error(`[mythrun] route error (retry attempt ${String(attempts)})`, error)
  }, [error, attempts])

  const onRetry = (): void => {
    // Count this attempt, then hard-reload the route. If it re-fails, the next
    // mount reads the higher count and escalates; a burst that stops resets itself.
    recordRetryAttempt()
    void navigate(0)
  }

  return (
    <Box padding={6} data-testid="error-retryable">
      <Stack align="center" gap={4}>
        <Heading level={1} role="heading">
          {escalated ? t('error.persistentTitle') : t('error.title')}
        </Heading>
        <Text as="p" role="prose-body">
          {escalated ? t('error.persistentBody') : t('error.body')}
        </Text>
        {escalated && reference !== null ? (
          <Text role="meta" data-testid="error-reference">
            {t('error.reference', { code: reference })}
          </Text>
        ) : null}
        <Button variant="primary" onPress={onRetry} data-testid="error-retry">
          {escalated ? t('error.reload') : t('error.retry')}
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
  // the route.) The error rides along for diagnostics + the support reference.
  return <RetryableError error={error} />
}
