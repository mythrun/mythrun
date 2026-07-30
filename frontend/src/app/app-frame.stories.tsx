import type { Meta, StoryObj } from '@storybook/react-vite'
import type { RouteObject } from 'react-router-dom'
import { expect, screen, userEvent, within } from 'storybook/test'
import type { BalanceResponse, MeResponse } from '@mythrun/client-core'
import { AppFrame } from './app-frame.tsx'
import { HomeRoute } from '../routes/home.tsx'
import { ScreenHarness, expectScreen } from '../storybook/screen-harness.tsx'

// Screens/AppFrame (navbar redesign 2026-07-30) — the persistent brand frame as
// the players meet it: the StickyBar's fluid lockup on the left, the credits ·
// Add credits · name-menu cluster on the right (hamburger below `sm`), the
// border-swap hairline on scroll, and the full-bleed stand-down on the
// immersive stage. Hosted through ScreenHarness on the (empty) home hub — a
// stable authed route that always renders the frame — so the stories gate the
// COMPOSITION layer, not isolated primitives. No a11y exemption: the frame is
// the highest-traffic chrome in the product, so these stories carry the axe
// sweep themselves (the only carve-out is the documented Radix
// `aria-hidden-focus` false-positive on the OPEN menu specimens, same as
// Overlays/Menu).
const meta: Meta<typeof ScreenHarness> = {
  title: 'Screens/AppFrame',
  component: ScreenHarness,
  parameters: { layout: 'fullscreen' },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof ScreenHarness>

// The story-locked mobile default: catalogue phone-first stories at phone width
// (the Drawer.stories pattern). The 375/1280 overflow sweep still gates BOTH
// breakpoints on every story regardless of this interactive default.
const MOBILE_VIEWPORT = { viewport: { value: 'mobile1', isRotated: false } }

// The Radix DropdownMenu OPEN-state carve-out (see Overlays/Menu · Open): an
// open Radix menu is MODAL — it aria-hides the background (incl. the trigger)
// while moving focus into the portal, and axe's `aria-hidden-focus` rule flags
// the still-tabbable background trigger. A by-design transient state, so ONLY
// that one rule is disabled on the open specimens; every other rule stays
// enforced.
const OPEN_MENU_A11Y = { config: { rules: [{ id: 'aria-hidden-focus', enabled: false }] } }

// Fail-loud open-state gate for the sweep: the portalled menu must actually be
// attached when the overflow gate measures, so a play that silently failed to
// open fails the story instead of measuring an empty portal.
const OPEN_MENU_GATE = { openSelector: '[role="menu"]' }

// The MYT-83 bug class: a long display name shoved the settings affordance off
// the right edge at 375px. The name is DATA (from `useMe()`, not an i18n key —
// MYT-99), so the adversarial 70-char name is seeded into the `['me']` cache
// via `seedMe`. Desktop: the name-as-trigger truncates to a single quiet row;
// at 375px the desktop cluster is hidden entirely (Show) and the hamburger
// carries the identity as the menu's header row.
const LONG_NAME_ME: MeResponse = {
  user: {
    id: 'dev-user-1',
    username: 'aldebaran',
    displayName: 'Aldebaran Featherstonehaugh-Wintermoor, Keeper of a Thousand Old Names',
    freeTrialUsed: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

// A five-digit session balance — the widest realistic credits readout. The
// 375px arm of the overflow sweep is the real assertion: the mobile cluster
// (credits · hamburger) must hold the grouped number without spilling the bar.
const FIVE_DIGIT_BALANCE: BalanceResponse = {
  session: 98750,
  world_gen: 4,
  active_subscription: null,
}

// The real route tree never passes `forceElevated` (it is the stories/tests-only
// elevation pin — the CI gate cannot scroll deterministically), so the Elevated
// story mounts its own AppFrame over the same home-hub content via the
// harness's `routesOverride`. RequireAuth is bypassed: the harness seeds the
// session ready either way, and the subject here is the frame, not the gate.
const ELEVATED_ROUTES: RouteObject[] = [
  { element: <AppFrame forceElevated />, children: [{ path: '*', element: <HomeRoute /> }] },
]

// Opens whichever arrangement's menu trigger is VISIBLE and asserts the list.
// Both HeaderMenu arms share data-testid frame-menu-trigger (two mounts, one
// CSS-hidden by Show), so the play filters by offsetParent — null inside the
// display:none arm. The CI sweep drives the story at desktop width (the
// desktop arm), while the mobile1-locked stories exercise the mobile arm
// interactively; the assertions adapt: the items COMMON to both arrangements
// always, plus the mobile-only list when the hamburger (aria-labelled
// IconButton) was the visible trigger. The menu portals to document.body, so
// item queries go through the document-bound `screen` (Storybook's sanctioned
// portal-query surface — R1 bans touching `document` directly), not
// canvasElement.
async function openVisibleMenu(canvasElement: HTMLElement): Promise<void> {
  const triggers = await within(canvasElement).findAllByTestId('frame-menu-trigger')
  const visible = triggers.find((el) => el.offsetParent !== null)
  if (visible === undefined) throw new Error('no visible frame-menu-trigger in either arrangement')
  await userEvent.click(visible)
  await expect(await screen.findByRole('menuitem', { name: 'Sessions & billing' })).toBeInTheDocument()
  await expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument()
  if (visible.getAttribute('aria-label') !== null) {
    // The mobile arm's full list (the buy action lives IN the menu at phone
    // width) — plus the identity header row, which is a label, not a menuitem.
    // The identity query scopes INSIDE the open menu: the (hidden) desktop
    // name-as-trigger carries the same text elsewhere in the DOM.
    await expect(screen.getByRole('menuitem', { name: 'Campaigns' })).toBeInTheDocument()
    await expect(screen.getByRole('menuitem', { name: 'Add credits' })).toBeInTheDocument()
    await expect(within(screen.getByRole('menu')).getByText('Wren')).toBeInTheDocument()
  }
}

// Rest — the bar as it sits at the top of a freshly-opened screen: hairline
// transparent (the elevation border only paints once content slides beneath).
export const Rest: Story = {
  name: 'App frame · rest',
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} />,
  play: async ({ canvasElement }) => {
    await expectScreen('app-frame')({ canvasElement })
    const header = within(canvasElement).getByTestId('app-frame-header')
    await expect(header.className).toContain('border-transparent')
  },
}

// Elevated — the scrolled state, pinned via `forceElevated`: the bar's bottom
// border swaps transparent → --border (the zero-CLS hairline).
export const Elevated: Story = {
  name: 'App frame · elevated (scrolled hairline)',
  render: () => (
    <ScreenHarness
      entry="/home"
      session="ready"
      seedCampaigns={[]}
      routesOverride={ELEVATED_ROUTES}
    />
  ),
  play: async ({ canvasElement }) => {
    await expectScreen('app-frame')({ canvasElement })
    const header = within(canvasElement).getByTestId('app-frame-header')
    await expect(header.className).toContain('border-border')
    await expect(header.className).not.toContain('border-transparent')
  },
}

// Mobile — the two-item bar (credits · hamburger) at phone width. The desktop
// cluster (Add credits, name-menu) retreats into the menu below `sm`.
export const Mobile: Story = {
  name: 'App frame · mobile',
  globals: MOBILE_VIEWPORT,
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} />,
  play: expectScreen('app-frame'),
}

// Desktop menu open — the name-as-trigger dropped down: Sessions & billing ·
// Log out. Light + dark arms; the dark arm ArrowDown-highlights the first item
// to exercise the raised-tier highlight token (--surface-raised-hover — dark
// --surface-hover equals the raised popover surface, the Menu fix).
export const DesktopMenuOpen: Story = {
  name: 'App frame · desktop menu open',
  parameters: { overflowGate: OPEN_MENU_GATE, a11y: OPEN_MENU_A11Y },
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} />,
  play: async ({ canvasElement }) => {
    await openVisibleMenu(canvasElement)
  },
}

export const DesktopMenuOpenDark: Story = {
  name: 'App frame · desktop menu open (dark)',
  globals: { theme: 'dark' },
  parameters: { overflowGate: OPEN_MENU_GATE, a11y: OPEN_MENU_A11Y },
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} />,
  play: async ({ canvasElement }) => {
    await openVisibleMenu(canvasElement)
    await userEvent.keyboard('{ArrowDown}')
  },
}

// Mobile menu open — the hamburger's full list (identity header, Campaigns,
// Add credits, Sessions & billing, Log out) at the mobile1-locked width. Under
// the CI sweep (desktop width) the play adapts to the visible desktop arm; the
// mobile arm's list asserts when this story runs at its own locked viewport.
export const MobileMenuOpen: Story = {
  name: 'App frame · mobile menu open',
  globals: MOBILE_VIEWPORT,
  parameters: { overflowGate: OPEN_MENU_GATE, a11y: OPEN_MENU_A11Y },
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} />,
  play: async ({ canvasElement }) => {
    await openVisibleMenu(canvasElement)
  },
}

export const MobileMenuOpenDark: Story = {
  name: 'App frame · mobile menu open (dark)',
  globals: { ...MOBILE_VIEWPORT, theme: 'dark' },
  parameters: { overflowGate: OPEN_MENU_GATE, a11y: OPEN_MENU_A11Y },
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} />,
  play: async ({ canvasElement }) => {
    await openVisibleMenu(canvasElement)
    await userEvent.keyboard('{ArrowDown}')
  },
}

// Full bleed — the immersive stage (the play route's `handle.fullBleed`): the
// content region swaps to the viewport-fill column, the buy affordance stands
// down (myth-u5qro — the menu keeps the purchase reachable), and the bar never
// paints its hairline (nothing scrolls beneath it). The dead-network harness
// lands the play route on its calm identity hold; the frame composition is the
// subject here, not the play surface.
export const FullBleed: Story = {
  name: 'App frame · full bleed (immersive stage)',
  render: () => <ScreenHarness entry="/campaigns/c-1/play" session="ready" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(await canvas.findByTestId('app-frame-content-bleed')).toBeInTheDocument()
    await expect(canvas.queryByTestId('frame-buy-credits')).toBeNull()
    await expect(canvas.getByTestId('app-frame-header').className).toContain('border-transparent')
  },
}

// Adversarial name — the 70-char display name (the MYT-83 overflow class). The
// sweep measures both widths: desktop must truncate the name-as-trigger to a
// single quiet row; 375px hides the desktop cluster entirely.
export const AdversarialName: Story = {
  name: 'App frame · adversarial display name (70 chars)',
  render: () => <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} seedMe={LONG_NAME_ME} />,
  play: expectScreen('app-frame'),
}

// Adversarial balance — the five-digit credits readout at the mobile1-locked
// width. The 375px sweep arm asserts the two-item bar holds "Credits 98,750"
// without spilling; the readout itself must render (a mis-seeded cache would
// otherwise degrade the slot silently).
export const AdversarialBalance: Story = {
  name: 'App frame · adversarial balance (5 digits at 375)',
  globals: MOBILE_VIEWPORT,
  render: () => (
    <ScreenHarness entry="/home" session="ready" seedCampaigns={[]} seedBalance={FIVE_DIGIT_BALANCE} />
  ),
  play: async ({ canvasElement }) => {
    await expectScreen('app-frame')({ canvasElement })
    // findAll: the readout renders in BOTH always-mounted arrangement clusters
    // (Show CSS-switches them); asserting length pins both slots resolved.
    await expect(await within(canvasElement).findAllByText('98,750')).toHaveLength(2)
  },
}
