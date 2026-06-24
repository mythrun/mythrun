import { Outlet } from 'react-router-dom'
import { Box, Stack, Text, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The quiet brand frame (brand decisions.md — "the brand is the frame, not the
// content"). Every authed route renders inside this persistent, minimal header:
// a muted Parchment-&-Ink bar carrying the wordmark · display name · credit
// balance · settings, wrapping the content <Outlet/>. The frame recedes so the
// narrative/combat content inside it is the focus — it never colonises the
// screen. Composed from @mythrun/ui primitives only (R5, no-ad-hoc-ui); every
// string is an i18n placeholder the flow tickets fill (MYT-84 wires the real
// display name + credits; settings navigation is a later ticket's concern).
//
// The frame is presentational — the W3c router test asserts its `app-frame`
// testid renders for a `ready` session; W3e/W4a wire the live identity data.
export function AppFrame(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack data-testid="app-frame">
      <Box padding={4} surface="base" border data-testid="app-frame-header">
        <Stack direction="row" justify="between" align="center" gap={5}>
          {/* The wordmark — the frame's quiet anchor (left). */}
          <Text role="ui-label" data-testid="frame-logo">
            {t('frame.logo')}
          </Text>
          {/* Identity + balance + settings affordance (right). */}
          <Stack direction="row" align="center" gap={5}>
            <Text role="ui-label" data-testid="frame-display-name">
              {t('frame.displayName')}
            </Text>
            <Text role="data" data-testid="frame-credits">
              {t('frame.credits')}
            </Text>
            <Button variant="ghost" size="sm" data-testid="frame-settings">
              {t('frame.settings')}
            </Button>
          </Stack>
        </Stack>
      </Box>
      {/* The content surface — the matched authed route renders here. */}
      <Box padding={6} data-testid="app-frame-content">
        <Outlet />
      </Box>
    </Stack>
  )
}
