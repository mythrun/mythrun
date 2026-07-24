import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@mythrun/ui'
import type {
  ApiContext,
  SessionPrepStream,
  StartFlow,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { PlaySession } from './play-session.tsx'
import type { PlayViewer } from './play-viewer.ts'

// Screens/PlaySession — the two readiness beats the session-start fix (myth
// readiness gating) adds to the play route, driven through a stubbed start flow so
// the exact phase renders without a live transport:
//
//   • Integration wait — the owner has just begun; `/start` answers
//     `campaign_not_active` while the party is woven into the world. The calm
//     preparing hold (the SAME beat as the between-sessions wait) auto-polls in the
//     background; the reported "table isn't ready — try again" mash is gone. The
//     label reads the FIRST-session variant ("bringing your party into the world…").
//   • Integration failed — integration exhausted its repair chain (`campaign_failed`).
//     A calm return-to-setup notice (the campaign page owns the retry), never a
//     retry-in-place loop.
//
// Both reuse already-audited components (SessionPreparing / the RetryNotice shape);
// these stories gate the NEW copy + the phase→screen wiring.

const CTX: ApiContext = { baseUrl: 'http://storybook.invalid', getAuthHeaders: () => Promise.resolve({}) }

// Route params are DATA, not copy — hoisted so the JSX carries no literal string.
const CAMPAIGN_ID = 'c-1'

// A solo table (party of one) — `campaign_not_active` / self-integration read as the
// viewer's OWN character settling in.
const VIEWER: PlayViewer = {
  userId: 'u-owner',
  displayName: 'Wren',
  isOwner: true,
  party: new Map([['u-owner', 'Wren']]),
}

// A multi-member table — `campaign_not_active` reads as the whole party being woven in.
const PARTY_VIEWER: PlayViewer = {
  userId: 'u-owner',
  displayName: 'Wren',
  isOwner: true,
  party: new Map([
    ['u-owner', 'Wren'],
    ['u-2', 'Perrin'],
  ]),
}

/** A fixed start flow at a chosen phase — the beat never transitions (the story pins it). */
function stubStart(
  state: StartFlow['state'],
): (ctx: ApiContext, input: { campaignId: string; viewerIsOwner: boolean; viewerUserId: string }) => StartFlow {
  return () => ({ state, start: () => undefined, retry: () => undefined })
}

/** A prep stream stuck generating — the integration wait's PreparingHold reads it only
 *  to latch a TERMINAL prep failure, which never fires here. */
const generatingPrep: (ctx: ApiContext, campaignId: string) => SessionPrepStream = () => ({
  status: 'generating',
  terminal: false,
})

// The start-flow states these stories pin. The `code` values are contract tokens
// (DATA, not copy) — hoisted to module scope so the JSX carries no literal string.
const WAITING_INTEGRATION: StartFlow['state'] = { phase: 'waiting', code: 'campaign_not_active' }
const WAITING_SELF_SETTLING: StartFlow['state'] = { phase: 'waiting', code: 'members_without_characters' }
const BLOCKED_INTEGRATION_FAILED: StartFlow['state'] = { phase: 'blocked', code: 'campaign_failed' }

const meta: Meta<typeof PlaySession> = {
  title: 'Screens/PlaySession',
  component: PlaySession,
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <I18nextProvider i18n={i18n}>
          {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- story stand-in for the play route's full-bleed root (play.tsx): the min-h-dvh flex column that lets the CenteredHold's `grow` fill the viewport is not expressible via @mythrun/ui Stack props */}
          <div className="flex min-h-dvh flex-col">
            <Story />
          </div>
        </I18nextProvider>
      </ThemeProvider>
    ),
  ],
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof PlaySession>

export const IntegrationWaiting: Story = {
  name: 'Integration wait — party (bringing the party in)',
  render: () => (
    <PlaySession
      ctx={CTX}
      campaignId={CAMPAIGN_ID}
      viewer={PARTY_VIEWER}
      reducedMotion={false}
      useStart={stubStart(WAITING_INTEGRATION)}
      usePrep={generatingPrep}
    />
  ),
}

export const SelfSettling: Story = {
  name: 'Self-integration wait (your character settling in)',
  render: () => (
    <PlaySession
      ctx={CTX}
      campaignId={CAMPAIGN_ID}
      viewer={VIEWER}
      reducedMotion={false}
      useStart={stubStart(WAITING_SELF_SETTLING)}
      usePrep={generatingPrep}
    />
  ),
}

export const IntegrationFailed: Story = {
  name: 'Integration failed (back to setup)',
  render: () => (
    <PlaySession
      ctx={CTX}
      campaignId={CAMPAIGN_ID}
      viewer={VIEWER}
      reducedMotion={false}
      onExitToCampaign={() => undefined}
      useStart={stubStart(BLOCKED_INTEGRATION_FAILED)}
    />
  ),
}
