import { Outlet, useMatches, useNavigate } from 'react-router-dom'
import { Box, Stack, Button, HorizontalLockup, Link, Show, StickyBar } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useScrollElevation } from '../platform/web/use-scroll-elevation.ts'
import { HeaderCredits } from './header-credits.tsx'
import { HeaderMenu } from './header-menu.tsx'
import { useHeaderDisplayName } from './use-header-display-name.ts'
import { BILLING_PATH, BUY_ANCHOR, HOME_PATH } from './paths.ts'

// The quiet brand frame (brand decisions.md — "the brand is the frame, not the
// content"). Every authed route renders inside this persistent sticky header
// above the content <Outlet/>. Navbar redesign (spec 2026-07-30): <StickyBar>
// owns every scroll-visual mechanic — sticky position, fluid bar metrics, the
// zero-CLS elevation border-swap (the hairline IS the bar's bottom border, no
// standalone Divider), brand compaction — so this file is pure composition:
//
//   • Brand (left): the fluid HorizontalLockup filling the bar's clamp-sized
//     brand slot, wrapped in the universal home link (MYT-5qpk2 — the play
//     screen was a nav dead-end without it). `unstyled` keeps it in ink.
//   • Desktop cluster (sm+): credits · Add credits · name-menu. The display
//     name IS the menu trigger (identity moved INTO the menu); the gear died —
//     Sessions & billing lives behind the name.
//   • Mobile cluster (below sm): credits · labeled hamburger-menu, which
//     carries the full list (identity header, Campaigns, Add credits,
//     Sessions & billing, Log out).
//   • The two clusters are BOTH mounted and CSS-switched by <Show/> at `sm`
//     (one HeaderMenu instance per arrangement — each closes itself on a
//     breakpoint cross so no portal strands over the other arm).
//
// Elevation: useScrollElevation watches a 1px sentinel at the TOP of the
// document (a sentinel below a sticky bar slides under it and fires a full
// bar-height late) and StickyBar swaps its border transparent → --border. On
// the immersive full-bleed stage the bar NEVER elevates (the stage below owns
// exactly one viewport — nothing scrolls beneath the bar) and the buy action
// stands down (myth-u5qro — "the usher hawking concessions during the
// overture"); the menu keeps the purchase reachable.
//
// <HeaderCredits/> owns its own Suspense + error boundary (header-slot.tsx), so
// a slow/failed balance fetch degrades only that slot. The display name rides
// useHeaderDisplayName() — null while loading or failed, which HeaderMenu maps
// to the labeled icon trigger, so the menu (and Log out) is always reachable.

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

export function AppFrame({ forceElevated }: { forceElevated?: boolean } = {}): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const fullBleed = useMatches().some((match) => hasFullBleedHandle(match.handle))
  // `forceElevated` pins the elevation for stories/tests ONLY (the Storybook
  // Elevated story can't scroll deterministically under the CI gate).
  const { elevated, sentinelRef } = useScrollElevation(forceElevated)
  const displayName = useHeaderDisplayName()
  const goToBuy = (): void => {
    void navigate(`${BILLING_PATH}${BUY_ANCHOR}`)
  }
  return (
    // The frame paints ONE ground for everything inside it: Box surface="base"
    // (--surface) — the same paper the padded content Box paints — so the bar,
    // the padded routes, AND fullBleed routes (whose stage paints nothing and
    // would otherwise show the darker body --bg through) all sit on a single
    // field. Without this, the bar read as a permanent tonal band.
    <Box surface="base">
      {/* The viewport floor is UNCONDITIONAL: short content (act-one worldgen, calm
          holds) must never expose the page background beneath the app's own (the
          626px-tall-app seam found in the MYT-102 audit). fullBleed still governs
          only the content-region layout below. */}
      <Stack minHeight="screen" data-testid="app-frame">
      {/* The 1px elevation sentinel — TOP of the document, absolutely positioned
          so it occupies no flow space (spec: a sentinel BELOW a sticky bar slides
          under it and fires a bar-height late). A measurement probe, not UI —
          the raw element is the point (the BaseProps ban covers DS components). */}
      {/* eslint-disable mythrun-ui/no-ad-hoc-ui -- scroll-elevation measurement sentinel: a 1px absolute raw element with a callback ref is not expressible via @mythrun/ui primitives */}
      <div
        ref={sentinelRef}
        aria-hidden="true"
        className="absolute top-0 h-px w-px"
        data-testid="frame-sentinel"
      />
      {/* eslint-enable mythrun-ui/no-ad-hoc-ui -- end of the sentinel escape hatch */}
      <StickyBar
        elevated={fullBleed ? false : elevated}
        data-testid="app-frame-header"
        brand={
          <Link href={HOME_PATH} unstyled data-testid="frame-logo-link">
            <HorizontalLockup aria-label={t('frame.wordmark')} size="fluid" data-testid="frame-logo" />
          </Link>
        }
      >
        {/* Desktop cluster (sm+): credits · Add credits · name-menu. The buy
            control is a LABELED "Add credits" action, never a bare "+" (a lone
            "+" reads as "new" and collided with create-campaign, MYT-3jb55; the
            + glyph stays reserved for campaign creation, myth-rhvkt). It sits
            OUTSIDE HeaderCredits' error boundary so it stays actionable even if
            the balance fetch fails. */}
        <Show above="sm">
          <Stack direction="row" align="center" gap={5}>
            <HeaderCredits data-testid="frame-credits-desktop" />
            {!fullBleed && (
              <Button variant="ghost" size="md" onPress={goToBuy} data-testid="frame-buy-credits">
                {t('frame.buyCredits')}
              </Button>
            )}
            <HeaderMenu arrangement="desktop" displayName={displayName} />
          </Stack>
        </Show>
        {/* Mobile cluster (below sm): credits · hamburger. The buy action lives
            INSIDE the menu here (its Add credits item), so the bar stays a
            two-item row at 375px instead of overflowing (the MYT-83 failure
            this frame guards against). */}
        <Show below="sm">
          <Stack direction="row" align="center" gap={4}>
            <HeaderCredits data-testid="frame-credits-mobile" />
            <HeaderMenu arrangement="mobile" displayName={displayName} />
          </Stack>
        </Show>
      </StickyBar>
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
    </Box>
  )
}
