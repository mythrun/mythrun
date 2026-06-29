import { Box, Stack, HorizontalLockup, Lockup, VisuallyHidden, Heading, Text, ThemeToggle, Button, useTheme } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

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
    <Box as="nav" padding={4} data-testid="landing-nav">
      <Stack direction="row" justify="between" align="center">
        <HorizontalLockup aria-label={t('landing.wordmark')} data-testid="landing-wordmark" />
        <Stack direction="row" align="center" gap={3}>
          <ThemeToggle placement="inline" label={toggleLabel} data-testid="landing-theme-toggle" />
          <Button variant="secondary" onPress={() => void navigate(SIGNIN_PATH)} data-testid="landing-signin">
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
    <Box as="main" padding={6} data-testid="landing-hero">
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

// The public landing page (MYT-86). Composed from @mythrun/ui only; nav/main/
// footer are semantic landmarks (Box `as`). Prose is [ph_] i18n; the CTA + nav
// Sign-in route to /auth/signin via SPA navigation.
export function LandingRoute(): React.JSX.Element {
  return (
    <Stack minHeight="screen" data-testid="route-landing">
      <LandingNav />
      <LandingHero />
    </Stack>
  )
}
