import { Outlet, useNavigate } from 'react-router-dom'
import { Box, Stack, Text, IconButton } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { HeaderCredits } from './header-credits.tsx'

// The quiet brand frame (brand decisions.md — "the brand is the frame, not the
// content"). Every authed route renders inside this persistent, minimal header:
// a muted Parchment-&-Ink bar carrying the wordmark · display name · live credit
// balance · buy · settings, wrapping the content <Outlet/>. The frame recedes so
// the narrative/combat content inside it is the focus — it never colonises the
// screen. Composed from @mythrun/ui primitives only (R5, no-ad-hoc-ui); the
// static labels are i18n placeholders the flow tickets fill (MYT-84 wires the real
// display name).
//
// The credit balance is the live session balance (`useBalance`, MYT-87 T16),
// rendered by `<HeaderCredits/>` — which owns its OWN Suspense + error boundary so a
// slow/failed balance fetch degrades only that slot, never the whole frame. The
// "+" (buy) and gear (settings) affordances route to interim targets (no dead
// clicks): the buy flow is MYT-95's, so both point at `/settings` (where account /
// billing lives) until it ships.
//
// Responsiveness (MYT-97): the header is a single quiet row at 375px. The
// display-name Text is the ONLY flexible item — it ellipsizes (truncate) and
// absorbs the row's shrink; the wordmark + credits hold their width (noShrink),
// and the buy + settings affordances are icon-only IconButtons (shrink-0). So a
// long display name truncates instead of squeezing the fixed labels into a spill.

// The interim navigation target for the header affordances (both the buy "+" and
// the settings gear) until MYT-95 ships the dedicated buy flow. Hoisted to a
// module const so the path isn't a JSX-attribute string literal (the i18n rule).
const SETTINGS_PATH = '/settings'

export function AppFrame(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const goToSettings = (): void => {
    void navigate(SETTINGS_PATH)
  }
  return (
    <Stack data-testid="app-frame">
      <Box padding={4} surface="base" border data-testid="app-frame-header">
        <Stack direction="row" justify="between" align="center" gap={5}>
          {/* The wordmark — the frame's quiet anchor (left). Fixed: it holds its
              width (noShrink) so a long display name can't squeeze it into a spill. */}
          <Text role="ui-label" noShrink data-testid="frame-logo">
            {t('frame.logo')}
          </Text>
          {/* Identity + balance + buy + settings affordances (right). */}
          <Stack direction="row" align="center" gap={5}>
            <Text role="ui-label" truncate data-testid="frame-display-name">
              {t('frame.displayName')}
            </Text>
            {/* The live credit balance + its buy affordance, grouped tight. The buy
                "+" sits OUTSIDE HeaderCredits' error boundary so it stays actionable
                even if the balance fetch fails. */}
            <Stack direction="row" align="center" gap={2}>
              <HeaderCredits />
              <IconButton
                icon="plus"
                label={t('frame.buyCredits')}
                variant="ghost"
                size="sm"
                onPress={goToSettings}
                data-testid="frame-buy-credits"
              />
            </Stack>
            <IconButton
              icon="settings"
              label={t('frame.settings')}
              variant="ghost"
              size="sm"
              onPress={goToSettings}
              data-testid="frame-settings"
            />
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
