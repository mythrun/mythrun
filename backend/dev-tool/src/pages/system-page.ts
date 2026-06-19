// backend/dev-tool/src/pages/system-page.ts
//
// myth-0smu: System workflow page. Operational probes — liveness,
// readiness, session-ticket issuance.

import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import { registerWorkflowMount } from '../shell/workflow-registry.js'
import { buildPageBody } from './_shared/page-skeleton.js'

import { mountHealthLivePanel } from '../components/health-live-panel.js'
import { mountHealthReadyPanel } from '../components/health-ready-panel.js'
import { mountSessionTicketPanel } from '../components/session-ticket-panel.js'
import { mountSessionStartPanel } from '../components/session-start-panel.js'
import { mountSessionActivePanel } from '../components/session-active-panel.js'
import { mountSessionMessagesPanel } from '../components/session-messages-panel.js'
import { mountFireTurnPanel } from '../components/fire-turn-panel.js'
import { mountCombatPanel } from '../components/combat-panel.js'

const SECTIONS: readonly {
  readonly id: string
  readonly mount: (parent: HTMLElement) => PanelHandle
}[] = [
  { id: 'health-live', mount: mountHealthLivePanel },
  { id: 'health-ready', mount: mountHealthReadyPanel },
  { id: 'session-ticket', mount: mountSessionTicketPanel },
  { id: 'session-start', mount: mountSessionStartPanel },
  { id: 'session-active', mount: mountSessionActivePanel },
  { id: 'session-messages', mount: mountSessionMessagesPanel },
  { id: 'fire-turn', mount: mountFireTurnPanel },
  { id: 'combat', mount: mountCombatPanel },
]

export function mountSystemPage(parent: HTMLElement): PanelHandle {
  const body = buildPageBody(parent, 'System')
  for (const s of SECTIONS) {
    body.mountSection(s.id, s.mount)
  }
  return {
    root: body.root,
    unmount: () => {
      body.unmountAll()
      if (body.root.parentNode !== null) body.root.parentNode.removeChild(body.root)
    },
  }
}

registerWorkflowMount('system', mountSystemPage)
