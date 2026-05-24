// backend/dev-tool/src/pages/campaigns-page.ts
//
// myth-0smu: Campaigns workflow page. Composes (in order):
//   - campaign-create-panel ("Create new")
//   - my-campaigns-panel ("My campaigns")
//   - active-campaign-only block:
//       campaign-details + campaign-rename + campaign-resume +
//       campaign-archive + campaign-delete
//
// The active-campaign block lives in a sub-container that mounts when
// an active campaign is set and unmounts when it's cleared. The page
// listens on onActiveCampaignChanged so picking a row in my-campaigns
// reveals the per-campaign actions inline without a full nav.

import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import {
  getActiveCampaignId,
  onActiveCampaignChanged,
} from '../shell/active-campaign.js'
import { registerWorkflowMount } from '../shell/workflow-registry.js'
import { buildPageBody } from './_shared/page-skeleton.js'

import { mountCampaignCreatePanel } from '../components/campaign-create-panel.js'
import { mountMyCampaignsPanel } from '../components/my-campaigns-panel.js'
import { mountCampaignDetailsPanel } from '../components/campaign-details-panel.js'
import { mountCampaignRenamePanel } from '../components/campaign-rename-panel.js'
import { mountCampaignResumePanel } from '../components/campaign-resume-panel.js'
import { mountCampaignArchivePanel } from '../components/campaign-archive-panel.js'
import { mountCampaignDeletePanel } from '../components/campaign-delete-panel.js'

const ACTIVE_SECTIONS: readonly {
  readonly id: string
  readonly mount: (parent: HTMLElement) => PanelHandle
}[] = [
  { id: 'campaign-details', mount: mountCampaignDetailsPanel },
  { id: 'campaign-rename', mount: mountCampaignRenamePanel },
  { id: 'campaign-resume', mount: mountCampaignResumePanel },
  { id: 'campaign-archive', mount: mountCampaignArchivePanel },
  { id: 'campaign-delete', mount: mountCampaignDeletePanel },
]

export function mountCampaignsPage(parent: HTMLElement): PanelHandle {
  const body = buildPageBody(parent, 'Campaigns')

  body.mountSection('campaign-create', mountCampaignCreatePanel)
  body.mountSection('my-campaigns', mountMyCampaignsPanel)

  function renderActiveSections(): void {
    for (const s of ACTIVE_SECTIONS) {
      body.removeSection(s.id)
    }
    if (getActiveCampaignId() === null) return
    for (const s of ACTIVE_SECTIONS) {
      body.mountSection(s.id, s.mount)
    }
  }

  renderActiveSections()

  const offActive = onActiveCampaignChanged(() => {
    renderActiveSections()
  })

  return {
    root: body.root,
    unmount: () => {
      offActive()
      body.unmountAll()
      if (body.root.parentNode !== null) body.root.parentNode.removeChild(body.root)
    },
  }
}

registerWorkflowMount('campaigns', mountCampaignsPage)
