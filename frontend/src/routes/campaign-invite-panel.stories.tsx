import type { Meta, StoryObj } from '@storybook/react-vite'
import { MemoryRouter } from 'react-router-dom'
import { ApiClientProvider, type ApiContext } from '@mythrun/client-core'
import { CampaignInvitePanel, type InvitePanelDeps } from './campaign-invite-panel.tsx'

// The wired owner invite panel (MYT-91). Deps are injected so every state is a
// deterministic specimen — the sweep measures the resolved link, the cap-reached
// advisory, and the transient-error arm at both gate widths. No network.

const STORYBOOK_CTX: ApiContext = {
  baseUrl: 'http://storybook.invalid',
  getAuthHeaders: () => Promise.resolve({}),
}

const LINK = { inviteCode: 'stor1bookcode', inviteUrl: 'https://mythrun.test/join/stor1bookcode' }
const CAMPAIGN_ID = 'storybook-campaign'

const RESOLVED: InvitePanelDeps = {
  ensurePrimary: () => Promise.resolve(LINK),
  copyText: () => Promise.resolve(),
  canShare: false,
}

const CAP_REACHED: InvitePanelDeps = {
  ensurePrimary: () => Promise.resolve(LINK),
  revoke: () => Promise.resolve(),
  create: () =>
    Promise.reject(
      Object.assign(new Error('cap'), { name: 'HttpError', status: 409, code: 'invite_cap_reached' }),
    ),
  copyText: () => Promise.resolve(),
}

const FAILING: InvitePanelDeps = {
  ensurePrimary: () => Promise.reject(new Error('storybook: resolve failed')),
}

function mount(deps: InvitePanelDeps): React.JSX.Element {
  return (
    <MemoryRouter>
      <ApiClientProvider value={STORYBOOK_CTX}>
        <CampaignInvitePanel campaignId={CAMPAIGN_ID} deps={deps} />
      </ApiClientProvider>
    </MemoryRouter>
  )
}

const meta: Meta<typeof CampaignInvitePanel> = {
  title: 'Screens/CampaignInvitePanel',
  component: CampaignInvitePanel,
  parameters: { layout: 'padded' },
}
// eslint-disable-next-line no-restricted-syntax -- Storybook CSF requires the meta object as the module's default export.
export default meta
type Story = StoryObj<typeof CampaignInvitePanel>

export const Resolved: Story = { render: () => mount(RESOLVED) }
export const CapReached: Story = { render: () => mount(CAP_REACHED) }
export const ResolveFailed: Story = { render: () => mount(FAILING) }
