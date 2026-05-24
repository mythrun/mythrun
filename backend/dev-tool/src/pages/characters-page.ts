// backend/dev-tool/src/pages/characters-page.ts
//
// myth-0smu: Characters workflow page. Active-campaign required.
// Composes (in order):
//   - starting-situations + situation-pick (owner picks)
//   - submit-character-concept (any member)
//   - character-creation-progress (member-visible auto-refresh)
//   - characters-roster (lists PCs; clicking "view" sets active char)
//   - character-view (renders for the active character)
//   - members
//   - finalize-character-creation (owner)

import type { PanelHandle } from '../components/_shared/panel-skeleton.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerWorkflowMount } from '../shell/workflow-registry.js'
import { buildPageBody } from './_shared/page-skeleton.js'

import { mountStartingSituationsPanel } from '../components/starting-situations-panel.js'
import { mountSituationPickPanel } from '../components/situation-pick-panel.js'
import { mountSubmitCharacterConceptPanel } from '../components/submit-character-concept-panel.js'
import { mountCharacterCreationProgressPanel } from '../components/character-creation-progress-panel.js'
import { mountCharactersRosterPanel } from '../components/characters-roster-panel.js'
import { mountCharacterViewPanel } from '../components/character-view-panel.js'
import { mountMembersPanel } from '../components/members-panel.js'
import { mountFinalizeCharacterCreationPanel } from '../components/finalize-character-creation-panel.js'

const SECTIONS: readonly {
  readonly id: string
  readonly mount: (parent: HTMLElement) => PanelHandle
}[] = [
  { id: 'starting-situations', mount: mountStartingSituationsPanel },
  { id: 'situation-pick', mount: mountSituationPickPanel },
  { id: 'submit-character-concept', mount: mountSubmitCharacterConceptPanel },
  { id: 'character-creation-progress', mount: mountCharacterCreationProgressPanel },
  { id: 'characters-roster', mount: mountCharactersRosterPanel },
  { id: 'character-view', mount: mountCharacterViewPanel },
  { id: 'members', mount: mountMembersPanel },
  { id: 'finalize-character-creation', mount: mountFinalizeCharacterCreationPanel },
]

export function mountCharactersPage(parent: HTMLElement): PanelHandle {
  const body = buildPageBody(parent, 'Characters')

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

registerWorkflowMount('characters', mountCharactersPage)
