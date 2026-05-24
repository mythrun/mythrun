// backend/dev-tool/src/pages/world-page.ts
//
// myth-0smu: World workflow page. Active-campaign required. Composes
// status + live-events + world-snapshot + hierarchy + random-tables in a
// single scrolling column so the operator can see live progress and the
// derived world state on the same page.

import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerWorkflowMount } from '../shell/workflow-registry.js'
import { buildPageBody } from './_shared/page-skeleton.js'

import { mountStatusPanel } from '../components/status-panel.js'
import { mountLiveEventsPanel } from '../components/live-events-panel.js'
import { mountWorldSnapshotPanel } from '../components/world-snapshot-panel.js'
import { mountHierarchyPanel } from '../components/hierarchy-panel.js'
import { mountRandomTablesPanel } from '../components/random-tables-panel.js'

const SECTIONS: readonly {
  readonly id: string
  readonly mount: (parent: HTMLElement) => PanelHandle
}[] = [
  { id: 'status', mount: mountStatusPanel },
  { id: 'live-events', mount: mountLiveEventsPanel },
  { id: 'world-snapshot', mount: mountWorldSnapshotPanel },
  { id: 'hierarchy', mount: mountHierarchyPanel },
  { id: 'random-tables', mount: mountRandomTablesPanel },
]

export function mountWorldPage(parent: HTMLElement): PanelHandle {
  const body = buildPageBody(parent, 'World')

  if (getActiveCampaignId() === null) {
    const note = document.createElement('div')
    note.style.color = 'var(--fg-muted)'
    note.style.fontSize = '13px'
    note.style.padding = '8px 4px'
    note.textContent =
      'Pick an active campaign on the Campaigns page to populate this view.'
    body.root.appendChild(note)
  } else {
    for (const s of SECTIONS) {
      body.mountSection(s.id, s.mount)
    }
  }

  return {
    root: body.root,
    unmount: () => {
      body.unmountAll()
      if (body.root.parentNode !== null) body.root.parentNode.removeChild(body.root)
    },
  }
}

registerWorkflowMount('world', mountWorldPage)
