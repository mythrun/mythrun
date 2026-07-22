import { useSearchParams } from 'react-router-dom'
import { Stack, Card, Text, Button, Dither, Lockup, GoogleMark, DiscordMark, Banner, Link, ThemeToggle, useTheme } from '@mythrun/ui'
import { Trans, useTranslation } from 'react-i18next'
import { useSessionStore, createAuthState, buildAuthorizeUrl, isLocalPath } from '@mythrun/client-core'
import { redirectTo } from '../platform/web/navigation.ts'

// The sign-in screen — the §11 genesis title composition (matches
// signin-title-fab.html): a theme-driven Dither CROWN (light: paper-100 → ember-600;
// dark: paper-900 → paper-100), `flip`ped so the accent hangs DENSE at the TOP edge
// and fades DOWN into the page field; the brand's stacked `Lockup` (mark-above-
// wordmark, ink on light / cream on dark); a terse at-the-table tagline (placeholder);
// and the two provider actions as `secondary` (bordered) Buttons, each carrying its
// official provider mark in the native leading-`icon` slot (the 4-color Google "G" /
// the Discord mark). The ThemeToggle FAB floats top-right above the crown
// (self-positioning — never laid ON the dither). Each provider button begins
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

  // The crown palette (from/to PALETTE tokens, matching signin-title-fab.html): light
  // dithers the parchment field → ember accent; dark dithers the reversed ground →
  // cream. `flip` hangs the accent DENSE at the top edge, fading DOWN into the field.
  // (Held as a const so the token names aren't JSX string literals — the i18n rule.)
  const crown = theme === 'dark' ? ({ from: 'paper-900', to: 'paper-100' } as const) : ({ from: 'paper-100', to: 'ember-600' } as const)

  return (
    <Stack minHeight="screen" data-testid="route-signin">
      <ThemeToggle label={t('theme.toggle')} data-testid="signin-theme-toggle" />
      <Dither from={crown.from} to={crown.to} flip data-testid="signin-crown" />
      {/* Below-crown region: the content is seated OPTICALLY ABOVE center on desktop
          via two proportional spacer Stacks (grow 1 above / 4 below — seated high, more quiet space
          below than above; NOT justify-center). On mweb the content nearly fills the
          region, so the spacers collapse and it flows naturally below the crown. The
          card itself collapses to native/inline on mweb (`Card collapse`). */}
      <Stack grow align="center">
        <Stack grow={1} />
        <Card collapse data-testid="signin-card">
          <Stack align="center" gap={6}>
            <Lockup aria-label={t('signin.wordmark')} data-testid="signin-wordmark" />
            <Text as="p" role="prose-body" data-testid="signin-tagline">
              {t('signin.tagline')}
            </Text>
            {suspended ? (
              <Banner severity="warning" data-testid="signin-suspended">
                {/* The suspended notice carries an inline "Contact us" mailto — the
                    <1> slot in the catalog string routes to support (matches how
                    landing.legal composes its Trans links). */}
                <Trans
                  i18nKey="signin.suspended"
                  components={{ 1: <Link href="mailto:hello@mythrun.com" data-testid="signin-contact" /> }}
                />
              </Banner>
            ) : null}
            <Stack align="stretch" gap={3}>
              <Button variant="secondary" icon={<GoogleMark />} onPress={() => { void begin('google') }}>
                {t('signin.google')}
              </Button>
              <Button variant="secondary" icon={<DiscordMark />} onPress={() => { void begin('discord') }}>
                {t('signin.discord')}
              </Button>
            </Stack>
            <Text role="ui-caption" data-testid="signin-legal">
              {t('signin.legal')}
            </Text>
          </Stack>
        </Card>
        <Stack grow={4} />
      </Stack>
    </Stack>
  )
}
