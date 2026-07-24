import { Outlet, useMatches, useNavigate } from 'react-router-dom'
import { Box, Stack, Divider, IconButton, HorizontalLockup, Show } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { HeaderCredits } from './header-credits.tsx'
import { HeaderIdentity } from './header-identity.tsx'

// The quiet brand frame (brand decisions.md — "the brand is the frame, not the
// content"). Every authed route renders inside this persistent header: a muted
// Parchment-&-Ink bar carrying the wordmark · display name · live credit balance ·
// buy · settings, above the content <Outlet/>. The frame recedes so the narrative/
// combat content inside it is the focus — it never colonises the screen. Composed
// from @mythrun/ui primitives only (R5, no-ad-hoc-ui).
//
// MYT-99 redesign. Six fixes over the prior header:
//   • The wordmark reads as the brand anchor — the HorizontalLockup is 32px tall
//     (≈half the 64px bar), not the earlier 24px afterthought.
//   • The display name is the player's REAL name from `useMe()` via <HeaderIdentity/>,
//     not the passthrough i18n key that printed the literal "{{DISPLAYNAME}}".
//   • The credit counter is a labeled "1,250 credits" readout (<HeaderCredits/>), not
//     a bare mystery number.
//   • The bottom edge is a single quiet <Divider/> hairline (the decorative --border
//     token, theme-aware), NOT a 4-sided --border-strong box that read as a stark
//     white line in dark mode.
//   • Considered spacing: groups are spaced apart (gap 5), items within a group tight
//     (gap 2 / 3), so identity · balance · actions read as distinct clusters.
//   • Responsive: at 375px the display name (the ONLY flexible item) truncates and
//     absorbs the row's shrink while the wordmark, credits, and icon buttons hold
//     their width — a single quiet row, not a squeeze.
//
// <HeaderIdentity/> and <HeaderCredits/> each own their OWN Suspense + error boundary
// (see header-slot.tsx), so a slow/failed `/me` or balance fetch degrades only that
// slot, never the whole frame. The "+" (buy) and gear (settings) affordances route to
// interim targets (no dead clicks): the buy flow is MYT-95's, so both point at
// `/settings` (where account / billing lives) until it ships. The "+" sits OUTSIDE
// HeaderCredits' boundary so it stays actionable even if the balance fetch fails.

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
      {/* The banner landmark. `surface="base"` sits it one step off the page; the
          bottom edge is a single quiet <Divider/> below (not a 4-sided border). */}
      <Box as="header" padding={4} surface="base" data-testid="app-frame-header">
        <Stack direction="row" justify="between" align="center" gap={4}>
          {/* The brand mark — the frame's quiet anchor (left). The horizontal lockup,
              sized to read as the brand at ≈half the bar height; inherently shrink-0,
              so a long display name can't squeeze it. Its accessible name is the
              wordmark i18n key (the landing.wordmark / signin.wordmark pattern). */}
          <HorizontalLockup
            aria-label={t('frame.wordmark')}
            size={36}
            data-testid="frame-logo"
          />
          {/* Identity · balance+buy · settings — three clusters, spaced apart (gap 5)
              with tight grouping within each. */}
          <Stack direction="row" align="center" gap={5}>
            {/* Identity shows from `sm` up; on phones it collapses so the wordmark +
                balance + actions get the row's width (the considered mobile arrangement,
                not a squeeze). */}
            <Show above="sm">
              <HeaderIdentity />
            </Show>
            {/* The live credit balance + its buy affordance, grouped tight. The buy
                "+" sits OUTSIDE HeaderCredits' error boundary so it stays actionable
                even if the balance fetch fails. `noShrink` holds the group so the
                display name (the row's only flexible item) absorbs all the shrink —
                without it the group collapses and the "+" overlaps the balance. */}
            <Stack direction="row" align="center" gap={3} noShrink>
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
      {/* The quiet hairline under the banner — the decorative --border token (bg-border),
          theme-aware in BOTH themes, flat-1-bit. Replaces the old --border-strong box
          edge that read as a stark white line on the dark page. */}
      <Divider data-testid="app-frame-divider" />
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
