import { Box, Stack, HorizontalLockup, Lockup, VisuallyHidden, Heading, Text, Dither, Link, ThemeToggle, Button, useTheme } from '@mythrun/ui'
import { Trans, useTranslation } from 'react-i18next'
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom'
import { useSessionStore } from '@mythrun/client-core'

// The SPA target both the nav Sign-in and the (later) hero CTA route to. Hoisted
// to a module const so the path is a variable at the `navigate(...)` call site —
// a literal there trips `i18next/no-literal-string` in the JSX-attribute scope.
const SIGNIN_PATH = '/auth/signin'

function LandingNav(): React.JSX.Element {
  const { t } = useTranslation()
  const { theme } = useTheme()
  const navigate = useNavigate()
  const toggleLabel = theme === 'dark' ? t('theme.toLight') : t('theme.toDark')
  return (
    <Box as="nav" surface="none" padding={4} data-testid="landing-nav">
      <Stack direction="row" justify="between" align="center">
        <HorizontalLockup aria-label={t('landing.wordmark')} data-testid="landing-wordmark" />
        <Stack direction="row" align="center" gap={3}>
          <ThemeToggle placement="inline" label={toggleLabel} data-testid="landing-theme-toggle" />
          <Button variant="secondary" size="lg" onPress={() => void navigate(SIGNIN_PATH)} data-testid="landing-signin">
            {t('landing.signin')}
          </Button>
        </Stack>
      </Stack>
    </Box>
  )
}

function LandingHero(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  return (
    <Box as="main" surface="none" padding={6} data-testid="landing-hero">
      <VisuallyHidden>
        <Heading level={1}>{t('landing.title')}</Heading>
      </VisuallyHidden>
      <Stack align="center" gap={6}>
        <Lockup aria-label={t('landing.wordmark')} data-testid="landing-hero-lockup" />
        <Text as="p" role="prose-body" data-testid="landing-tagline">{t('landing.tagline')}</Text>
        <Button variant="primary" onPress={() => void navigate(SIGNIN_PATH)} data-testid="landing-cta">
          {t('landing.cta')}
        </Button>
        <Text role="data" data-testid="landing-pricing">{t('landing.pricing')}</Text>
      </Stack>
    </Box>
  )
}

function LandingFooter(): React.JSX.Element {
  return (
    <Box as="footer" surface="inverted" padding={6} data-testid="landing-footer">
      <Stack align="center" gap={2}>
        <Text role="ui-caption" data-testid="landing-legal">
          <Trans
            i18nKey="landing.legal"
            components={{
              1: <Link href="/terms" data-testid="landing-terms" />,
              2: <Link href="/privacy" data-testid="landing-privacy" />,
              3: <Link href="mailto:hello@mythrun.dev" data-testid="landing-questions" />,
            }}
          />
        </Text>
      </Stack>
    </Box>
  )
}

// The public landing page (MYT-86). Composed from @mythrun/ui only; nav/main/
// footer are semantic landmarks (Box `as`). Prose is [ph_] i18n; the CTA + nav
// Sign-in route to /auth/signin via SPA navigation. The footer is the INVERTED
// surface (dark on a light page, light on a dark page); the page→footer Dither
// flips direction with the theme to grade the page into it.
export function LandingRoute(): React.JSX.Element {
  const { theme } = useTheme()
  const status = useSessionStore((s) => s.status)
  const [searchParams] = useSearchParams()
  // DEV-only escape hatch: `/?preview` lets an auto-authed dev VIEW the marketing
  // landing even while signed in. In a prod build `import.meta.env.DEV` is a
  // statically-`false` constant, so the whole branch dead-code-eliminates — an
  // authed prod visitor ALWAYS redirects, `?preview` or not.
  const preview = import.meta.env.DEV && searchParams.has('preview')
  // Redirect ONLY when definitively authed (`ready`): `/` is the anonymous
  // marketing page, so a signed-in player hitting it lands in the app. While
  // `initializing` (jwt on-load refresh not settled) we must NOT redirect — that
  // would flash/bounce a real anonymous prod visitor mid-bootstrap. `unauthenticated`
  // and `onboarding-required` also stay on the landing (onboarding is reached via
  // the auth flow, not `/`). `replace` keeps `/` out of history so Back doesn't loop.
  if (status === 'ready' && !preview) {
    return <Navigate to="/home" replace />
  }
  // The Dither ALWAYS fires; its direction flips with the theme so it always grades
  // the page INTO the inverted footer (light page → dark footer; dark → light). Held
  // as a const so the palette token names aren't JSX string literals (the i18n rule);
  // mirrors the signin crown.
  const dither =
    theme === 'dark'
      ? ({ from: 'paper-900', to: 'paper-100' } as const)
      : ({ from: 'paper-100', to: 'paper-900' } as const)
  return (
    <Stack minHeight="screen" data-testid="route-landing">
      <LandingNav />
      <Stack grow justify="center">
        <LandingHero />
      </Stack>
      <Dither from={dither.from} to={dither.to} scale="hero" data-testid="landing-dither" />
      <LandingFooter />
    </Stack>
  )
}
