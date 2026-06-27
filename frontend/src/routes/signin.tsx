import { useSearchParams } from 'react-router-dom'
import { Box, Stack, Text, Button, Dither, Banner, ThemeToggle, useTheme } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useSessionStore, createAuthState, buildAuthorizeUrl, isLocalPath } from '@mythrun/client-core'
import { redirectTo } from '../platform/web/navigation.ts'

// The sign-in screen — the §11 genesis title composition (matches
// signin-title-fab.html): a theme-driven Dither CROWN (light-ember in light,
// dark-cream in dark) grading out of the page field, the quiet `Mythrun` wordmark,
// a terse at-the-table tagline (placeholder), and the two provider actions as
// `secondary` (bordered) Buttons. The ThemeToggle FAB floats top-right above the
// crown (self-positioning — never laid ON the dither). Each provider button begins
// the OAuth flow: createAuthState (CSPRNG state + PKCE, carrying provider + a
// validated return-to) → buildAuthorizeUrl → full-page redirect to the Hosted UI.
//
// The return-to is seeded from a `?returnTo` query (the invite handoff, §7),
// validated LOCAL before it rides the OAuth `state`; otherwise the Hub.
type Provider = 'google' | 'discord'

export function SigninRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const [params] = useSearchParams()
  const suspended = useSessionStore((s) => s.suspended)

  const rawReturnTo = params.get('returnTo')
  const returnTo = rawReturnTo !== null && isLocalPath(rawReturnTo) ? rawReturnTo : '/home'

  // `createAuthState` is async (the S256 PKCE digest); it persists the state +
  // returns {state, challenge}, then we build the authorize URL and redirect.
  const begin = async (provider: Provider): Promise<void> => {
    const { state, challenge } = await createAuthState({ provider, returnTo })
    redirectTo(buildAuthorizeUrl({ provider, state, challenge }))
  }

  return (
    <Stack minHeight="screen" data-testid="route-signin">
      <ThemeToggle label={t('theme.toggle')} data-testid="signin-theme-toggle" />
      <Dither pairing={theme === 'dark' ? 'dark-cream' : 'light-ember'} data-testid="signin-crown" />
      <Stack grow justify="center" align="center" gap={7}>
        <Box padding={6}>
          <Stack align="center" gap={6}>
            <Text role="ui-label" data-testid="signin-wordmark">
              {t('signin.wordmark')}
            </Text>
            <Text as="p" role="prose-body" data-testid="signin-tagline">
              {t('signin.tagline')}
            </Text>
            {suspended ? (
              <Banner severity="warning" data-testid="signin-suspended">
                {t('signin.suspended')}
              </Banner>
            ) : null}
            <Stack align="stretch" gap={3}>
              <Button variant="secondary" onPress={() => { void begin('google') }}>
                {t('signin.google')}
              </Button>
              <Button variant="secondary" onPress={() => { void begin('discord') }}>
                {t('signin.discord')}
              </Button>
            </Stack>
            <Text role="ui-caption" data-testid="signin-legal">
              {t('signin.legal')}
            </Text>
          </Stack>
        </Box>
      </Stack>
    </Stack>
  )
}
