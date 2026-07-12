import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import {
  ApiClientProvider,
  type ApiContext,
  type WorldGenSnapshot,
} from '@mythrun/client-core'
import { i18n } from '../../i18n/config.ts'
import { JoinSummaryRoute } from './join-summary.tsx'

// JoinSummaryRoute — the brief world-intro summary a member reaches after
// accepting an invite (MYT-90 D9): the world's name + a short intro paragraph in
// the paper/serif introduction register, then the "create your character" CTA.
// The specimens feed the route fixed snapshot data through the `fetchSnapshot`
// seam so they settle to a fixed world WITHOUT a live backend (the reveal wiki's
// snapshot endpoint is owner-only, so a real member fetch 403s — the Unavailable
// specimen renders that fail-closed notice). The route reads its `:id` from the
// URL, so each specimen mounts under a MemoryRouter at the join path. These exist
// for the responsive/a11y sweep; the wiring is covered by join-summary.test.tsx.

const STORY_CID = 'story-campaign'
const STORY_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

const SNAPSHOT: WorldGenSnapshot = {
  introduction: {
    title: 'Emberdeep Hollow',
    prose:
      'A drowned mining town where the lamps never went out — the water rose one winter and never left, and the folk who stayed learned to live between the flooded shafts and the light that still burns somewhere below.',
    references: [],
  },
  entities: [],
  facts: [],
  entityHierarchy: [],
  relationships: [],
}

function renderWith(fetchSnapshot: (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>): React.JSX.Element {
  return (
    <MemoryRouter initialEntries={[`/campaigns/${STORY_CID}/join`]}>
      <I18nextProvider i18n={i18n}>
        <ApiClientProvider value={STORY_CTX}>
          <JoinSummaryRoute fetchSnapshot={fetchSnapshot} />
        </ApiClientProvider>
      </I18nextProvider>
    </MemoryRouter>
  )
}

const meta: Meta<typeof JoinSummaryRoute> = {
  title: 'Screens/JoinSummary',
  component: JoinSummaryRoute,
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta

type Story = StoryObj<typeof JoinSummaryRoute>

// The common case — the world resolves, name + intro + the create CTA.
export const Default: Story = {
  name: 'A world to join',
  render: () => renderWith(() => Promise.resolve(SNAPSHOT)),
}

// Fail-closed — the snapshot could not be fetched (a member hitting the owner-only
// endpoint, or a transient failure). The calm, retryable notice.
export const Unavailable: Story = {
  name: 'Unavailable (fail-closed notice)',
  render: () => renderWith(() => Promise.reject(new Error('forbidden'))),
}
