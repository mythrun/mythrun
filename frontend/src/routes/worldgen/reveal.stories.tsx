import type { Meta, StoryObj } from '@storybook/react-vite'
import { I18nextProvider } from 'react-i18next'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import {
  ApiClientProvider,
  type ApiContext,
  type WorldGenSnapshot,
  type WorldGenStream,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { WorldReveal } from './reveal.tsx'

// WorldReveal — the world-reveal screen (MYT-89 Phase D): the interactive graph
// beside the browsable wiki (desktop true-50/50; a full-bleed graph + wiki drawer
// at ≤375). These specimens exist to pin the CONTINUE-GATE states for the visual
// audit: the affordance is PRESENT FROM FIRST PAINT and honest about its state —
// DISABLED with a quiet settling indicator (`Settling`) while the silent tail of
// world-gen is still finishing, then ENABLED IN PLACE with the indicator gone
// (`Ready`). The button never appears from nothing and never moves at the flip.
//
// The wiki reads its model through the injected `fetchSnapshot` seam (a resolved
// intro-bearing snapshot here — no live backend); the graph nodes arrive as props.
// A data router (createMemoryRouter) is used because the narrow regime mounts the
// Back-closes-the-drawer layer (useBlocker), which requires one.

const STORY_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

const STORY_CID = 'story-campaign'

const NODES: WorldGenStream['nodes'] = [
  { synthKey: 'n/reach', kind: 'location', name: 'Ashfen Reach', displayId: 'ent-loc-1', state: 'finalized', lastEventIndex: 0 },
  { synthKey: 'n/maeris', kind: 'npc', name: 'Maeris Vale', displayId: 'ent-npc-1', state: 'finalized', lastEventIndex: 1 },
  { synthKey: 'n/wardens', kind: 'faction', name: 'The Bell-Wardens', displayId: 'ent-fac-1', state: 'finalized', lastEventIndex: 2 },
  { synthKey: 'n/tallow', kind: 'location', name: 'Tallow Steps', displayId: 'ent-loc-2', state: 'finalized', lastEventIndex: 3 },
  { synthKey: 'n/ledger', kind: 'item', name: 'The Salt Ledger', displayId: 'ent-item-1', state: 'finalized', lastEventIndex: 4 },
]

const EDGES: WorldGenStream['edges'] = [
  { synthKey: 'entity_relationships/e1', from: 'ent-npc-1', to: 'ent-loc-1', relationship: 'harbourmaster_of', arrivalIndex: 0, sourceStage: 'weave' },
  { synthKey: 'entity_relationships/e2', from: 'ent-fac-1', to: 'ent-loc-2', relationship: 'keeps_watch_over', arrivalIndex: 1, sourceStage: 'weave' },
  { synthKey: 'entity_relationships/e3', from: 'ent-npc-1', to: 'ent-item-1', relationship: 'keeper_of', arrivalIndex: 2, sourceStage: 'weave' },
]

const SNAPSHOT: WorldGenSnapshot = {
  entities: [
    { id: 'ent-loc-1', entityType: 'location', name: 'Ashfen Reach' },
    { id: 'ent-npc-1', entityType: 'npc', name: 'Maeris Vale' },
    { id: 'ent-fac-1', entityType: 'faction', name: 'The Bell-Wardens' },
    { id: 'ent-loc-2', entityType: 'location', name: 'Tallow Steps' },
    { id: 'ent-item-1', entityType: 'item', name: 'The Salt Ledger' },
  ],
  facts: [
    { id: 'f-1', entityId: 'ent-npc-1', topic: 'Role', content: 'Harbourmaster of the Reach, keeper of its tide-ledgers.' },
    { id: 'f-2', entityId: 'ent-fac-1', topic: 'Standing', content: 'Ring the drowned-bell for every ship the Reach takes back.' },
  ],
  entityHierarchy: [],
  relationships: [
    { sourceEntityId: 'ent-npc-1', targetEntityId: 'ent-loc-1', relationshipType: 'harbourmaster_of' },
    { sourceEntityId: 'ent-fac-1', targetEntityId: 'ent-loc-2', relationshipType: 'keeps_watch_over' },
  ],
  introduction: {
    title: 'The Ashfen Reaches',
    prose: 'A tidewater world of salt and tallow, where the harbours keep uneasy ledgers.\n\nWhat the sea takes, the Bell-Wardens count.',
    references: [
      { entityId: 'ent-npc-1', name: 'Maeris Vale' },
      { entityId: 'ent-fac-1', name: 'The Bell-Wardens' },
    ],
  },
}

function renderReveal(continueReady: boolean): React.JSX.Element {
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: (
          <WorldReveal
            campaignId={STORY_CID}
            nodes={NODES}
            edges={EDGES}
            continueReady={continueReady}
            fetchSnapshot={() => Promise.resolve(SNAPSHOT)}
          />
        ),
      },
    ],
    { initialEntries: ['/'] },
  )
  return (
    <I18nextProvider i18n={i18n}>
      <ApiClientProvider value={STORY_CTX}>
        {/* Mimic the AppFrame content box (padding={6} on bg-bg) so the mobile
            FullBleedStage's inset={6} cancels against a real frame inset. A raw
            layout root because the page bg + content padding is the AppFrame's job,
            not expressible via @mythrun/ui Box props here (no bg-bg surface). */}
        {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- story-only AppFrame stand-in: viewport-fill layout root painting the page bg + content inset the mobile FullBleedStage cancels against; not expressible via @mythrun/ui props */}
        <div className="min-h-dvh bg-bg p-[var(--space-6)] text-ink">
          <RouterProvider router={router} />
        </div>
      </ApiClientProvider>
    </I18nextProvider>
  )
}

const meta: Meta<typeof WorldReveal> = {
  title: 'Screens/WorldReveal',
  component: WorldReveal,
  // A composed screen specimen (graph canvas + wiki + router): the a11y sweep for
  // the reveal's own surfaces lives in @mythrun/ui + the route tests; this gate is
  // the visual/overflow one (the Screens/* convention, cf. CampaignDetail).
  parameters: { layout: 'fullscreen', a11y: { test: 'off' } },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof WorldReveal>

// Settling — the tail is still running: Continue is present but DISABLED, with the
// quiet settling indicator (spinner + muted mono line) to its right.
export const Settling: Story = {
  name: 'Settling (Continue gated)',
  render: () => renderReveal(false),
}

// Ready — the pipeline has completed: the SAME Continue is enabled in place and the
// settling indicator is gone.
export const Ready: Story = {
  name: 'Ready (Continue enabled)',
  render: () => renderReveal(true),
}
