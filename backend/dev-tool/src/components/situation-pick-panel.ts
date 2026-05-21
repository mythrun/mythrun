// backend/dev-tool/src/components/situation-pick-panel.ts
//
// myth-fn51 P6.C — POST /api/campaigns/:campaignId/starting-situation.
// Owner picks one of three starting situations by index. Action area
// presents three buttons (index 0/1/2); feedback shows the response.

import { apiCall } from '../api-client.js'
import { getActiveCampaignId } from '../shell/active-campaign.js'
import { registerPanelMount } from '../shell/shell.js'
import {
  buildSplitView,
  type PanelHandle,
} from './_shared/panel-skeleton.js'
import { renderErrorBlock } from './_shared/error-block.js'
import { appendJsonDisclosure } from './_shared/json-disclosure.js'

function readCode(body: unknown): string {
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const c = (body).code
    if (typeof c === 'string') return c
  }
  return 'unknown'
}

export function mountSituationPickPanel(parent: HTMLElement): PanelHandle {
  const { root, actionEl, feedbackEl, setState } = buildSplitView({
    parent,
    title: 'POST /api/campaigns/:campaignId/starting-situation',
  })

  const note = document.createElement('div')
  note.style.fontSize = '12px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Owner picks one of the three starting situations. See GET /starting-situations for prose.'
  actionEl.appendChild(note)

  const btnRow = document.createElement('div')
  btnRow.style.display = 'flex'
  btnRow.style.gap = '6px'
  actionEl.appendChild(btnRow)

  const buttons: HTMLButtonElement[] = []
  for (const idx of [0, 1, 2]) {
    const b = document.createElement('button')
    b.textContent = `Pick situation ${String(idx)}`
    b.addEventListener('click', () => {
      void pick(idx)
    })
    btnRow.appendChild(b)
    buttons.push(b)
  }

  const idle = document.createElement('div')
  idle.style.color = 'var(--fg-muted)'
  idle.style.fontSize = '12px'
  idle.textContent = '(not yet submitted)'
  feedbackEl.appendChild(idle)

  setState('ready')

  async function pick(index: number): Promise<void> {
    const id = getActiveCampaignId()
    if (id === null) {
      feedbackEl.replaceChildren()
      const m = document.createElement('div')
      m.style.color = 'var(--fg-muted)'
      m.textContent = '(no active campaign — pick one from My campaigns)'
      feedbackEl.appendChild(m)
      return
    }
    setState('loading')
    feedbackEl.replaceChildren()
    for (const b of buttons) b.disabled = true

    const res = await apiCall(`/api/campaigns/${id}/starting-situation`, {
      method: 'POST',
      body: JSON.stringify({ index }),
    })

    for (const b of buttons) b.disabled = false

    if (res.status !== 200 && res.status !== 204) {
      setState('error')
      renderErrorBlock(feedbackEl, {
        status: res.status,
        code: readCode(res.body),
        message: `Pick situation ${String(index)} failed`,
        raw: res.body,
      })
      return
    }

    setState('ready')
    const summary = document.createElement('div')
    summary.style.color = 'var(--fg-emphasis)'
    summary.textContent = `${String(res.status)} — picked index ${String(index)}`
    feedbackEl.appendChild(summary)
    appendJsonDisclosure(feedbackEl, res.body)
  }

  return {
    root,
    unmount: () => {
      // Listeners are bound inline above; removing the root from the
      // DOM lets GC reclaim the buttons + their handlers. No explicit
      // removeEventListener needed (handlers don't outlive the node).
      if (root.parentNode !== null) root.parentNode.removeChild(root)
    },
  }
}

registerPanelMount(
  'POST',
  '/api/campaigns/:campaignId/starting-situation',
  mountSituationPickPanel,
)
