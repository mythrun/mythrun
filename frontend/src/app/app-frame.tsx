import { Outlet, useMatches, useNavigate } from 'react-router-dom'
import { Box, Stack, Text, IconButton, HorizontalLockup } from '@mythrun/ui'
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

// The content region has two layouts, chosen by the MATCHED route, not by AppFrame
// (MYT-92 T15). A route opts its content OUT of the frame's padded Box and INTO a
// full-bleed viewport-fill stage by declaring `handle: { fullBleed: true }` on its
// route entry (router.tsx) — the React-Router idiomatic "a child route influences
// the layout" seam. The live-play screen uses it so the transcript owns the screen
// below the header (header + content = exactly one viewport; the content scrolls
// internally). Structural validation only (a handle-shape check) — no cognition.
function hasFullBleedHandle(handle: unknown): boolean {
  return (
    typeof handle === 'object' && handle !== null && 'fullBleed' in handle && handle.fullBleed === true
  )
}

export function AppFrame(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fullBleed = useMatches().some((match) => hasFullBleedHandle(match.handle))
  const goToSettings = (): void => {
    void navigate(SETTINGS_PATH)
  }
  return (
    // The viewport floor is UNCONDITIONAL: short content (act-one worldgen, calm
    // holds) must never expose the page background beneath the app's own (the
    // 626px-tall-app seam found in the MYT-102 audit). fullBleed still governs
    // only the content-region layout below.
    <Stack minHeight="screen" data-testid="app-frame">
      <Box padding={4} surface="base" border data-testid="app-frame-header">
        <Stack direction="row" justify="between" align="center" gap={5}>
          {/* The brand mark — the frame's quiet anchor (left). The compact
              horizontal lockup the landing nav uses; it is inherently shrink-0, so
              a long display name can't squeeze it into a spill. Its accessible name
              is the wordmark i18n key (the landing.wordmark / signin.wordmark
              pattern). */}
          <HorizontalLockup
            aria-label={t('frame.wordmark')}
            size={24}
            data-testid="frame-logo"
          />
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
      {/* The content surface — the matched authed route renders here. A route that
          declares handle.fullBleed (MYT-92 T15) escapes the padded Box and fills the
          viewport below the header (the live-play stage); every other route keeps the
          padded content box unchanged. */}
      {fullBleed ? (
        // The app-shell's ONE full-viewport layout root. `min-h-0`/`flex-1` is the
        // flex-scroll unblocker (a tall transcript scrolls INSIDE this region, not the
        // page) — not expressible via Stack props because BaseProps forbids className,
        // so this is the sanctioned raw-element escape hatch, scoped to the shell.
        // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- app-shell viewport-fill layout root; the min-h-0 flex-scroll unblocker is not expressible via @mythrun/ui Stack props (BaseProps bans className)
        <div className="flex min-h-0 flex-1 flex-col" data-testid="app-frame-content-bleed">
          <Outlet />
        </div>
      ) : (
        <Box padding={6} grow data-testid="app-frame-content">
          <Outlet />
        </Box>
      )}
    </Stack>
  )
}
