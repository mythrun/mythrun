import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Box, Stack, Spinner, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  useApiContext,
  useSessionStore,
  parseCallback,
  consumeAuthState,
  isLocalPath,
  createSession,
  applyMe,
  setAccessToken,
} from '@mythrun/client-core'

// The OAuth callback (`/auth/callback?code=…&state=…`). It verifies the opaque
// `state` against the value stashed at sign-in (CSRF), re-validates the carried
// return-to is a LOCAL path, exchanges {code, codeVerifier} at POST /api/auth/session,
// stores the access token IN MEMORY, runs the session adapter (/me → store), and
// navigates: to the return-to when `ready`, to `/auth/onboard` (carrying the pre-fill
// name + return-to) when `onboarding-required`. The OAuth `state` is single-use
// (consumed here), so the return-to is RE-PERSISTED onto the onboard navigation's
// router location state to survive the onboard detour (spec §7).
//
// `code` is single-use too: a module-level guard makes the exchange run exactly
// once even under React StrictMode's dev double-mount (which re-runs effects).
const processedCodes = new Set<string>()

export function CallbackRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  const { search } = useLocation()
  const ran = useRef(false)
  const [errored, setErrored] = useState(false)

  useEffect(() => {
    if (ran.current) return
    ran.current = true

    const parsed = parseCallback(search)
    if ('error' in parsed) {
      setErrored(true)
      return
    }
    if (processedCodes.has(parsed.code)) return
    processedCodes.add(parsed.code)

    const stored = consumeAuthState(parsed.state)
    if (stored === null) {
      setErrored(true)
      return
    }
    const returnTo = stored.returnTo !== null && isLocalPath(stored.returnTo) ? stored.returnTo : '/'

    const run = async (): Promise<void> => {
      const session = await createSession({ code: parsed.code, codeVerifier: stored.verifier }, ctx)
      setAccessToken(session.accessToken, session.expiresIn)
      await applyMe(ctx)
      const status = useSessionStore.getState().status
      if (status === 'ready') {
        navigate(returnTo, { replace: true })
      } else if (status === 'onboarding-required') {
        navigate('/auth/onboard', { replace: true, state: { name: session.name, returnTo } })
      } else {
        setErrored(true)
      }
    }
    void run().catch(() => {
      setErrored(true)
    })
  }, [search, ctx, navigate])

  if (errored) {
    return (
      <Stack align="center" justify="center" minHeight="screen" data-testid="callback-error">
        <Box padding={6}>
          <Text as="p" role="prose-body">
            {t('callback.error')}
          </Text>
        </Box>
      </Stack>
    )
  }
  return (
    <Stack align="center" justify="center" minHeight="screen" data-testid="route-callback">
      <Box padding={6}>
        <Spinner label={t('callback.loading')} />
      </Box>
    </Stack>
  )
}
