// Lists campaigns owned by (or shared with) the current dev-user.
// Each row carries a Watch button that drives the status panel via
// the existing `mythrun.watchcampaign` event (per T13's wiring).
//
// Without this panel the user has no way to discover existing
// campaignIds short of querying Postgres directly — which makes the
// dev tool's other panels (status, details) feel marooned.
//
// Refreshes on initial mount, after the create panel reports a 201,
// and on identity switch.

import { apiCall } from '../api-client.js'

interface CampaignRow {
  readonly id: string
  readonly name: string | null
  readonly status: string
  readonly worldId: string
}

function buildCampaignRow(c: CampaignRow, onDelete: () => void): HTMLElement {
  const row = document.createElement('div')
  row.style.display = 'flex'
  row.style.alignItems = 'center'
  row.style.gap = '8px'
  row.style.fontFamily = 'monospace'
  row.style.fontSize = '12px'

  const label = document.createElement('span')
  label.style.flex = '1'
  label.textContent = `${c.id}  ${c.name ?? '(unnamed)'}  [${c.status}]`

  const watchBtn = document.createElement('button')
  watchBtn.textContent = 'Watch'
  watchBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent<string>('mythrun.watchcampaign', { detail: c.id }))
  })

  const detailsBtn = document.createElement('button')
  detailsBtn.textContent = 'Details'
  detailsBtn.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent<string>('mythrun.opendetails', { detail: c.id }))
  })

  const deleteBtn = document.createElement('button')
  deleteBtn.textContent = 'Delete'
  deleteBtn.addEventListener('click', onDelete)

  row.appendChild(label)
  row.appendChild(watchBtn)
  row.appendChild(detailsBtn)
  row.appendChild(deleteBtn)
  return row
}

async function deleteCampaign(c: CampaignRow, refresh: () => Promise<void>): Promise<void> {
  // Plain-text confirm — the dev tool doesn't ship a modal lib.
  // Production FE will replace this with a proper confirmation flow.
  if (!window.confirm(`Delete campaign ${c.name ?? c.id}? This is permanent.`)) return
  const res = await apiCall(`/api/campaigns/${c.id}`, { method: 'DELETE' })
  if (res.status === 204) {
    // If the user was watching this campaign, close the stream + clear panels.
    window.dispatchEvent(new CustomEvent('mythrun.closewatch'))
    window.dispatchEvent(new CustomEvent('mythrun.detailspanel.clear'))
    void refresh()
    return
  }
  if (res.status === 409) {
    window.alert(
      'Campaign is still generating — wait for it to complete or fail, then retry delete.',
    )
    return
  }
  window.alert(`Delete failed: ${String(res.status)} ${res.error ?? JSON.stringify(res.body)}`)
}

export function mountMyCampaignsPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  card.setAttribute('data-state', 'loading')

  const title = document.createElement('h2')
  title.textContent = 'My campaigns'

  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = 'Refresh'

  const status = document.createElement('div')
  status.className = 'result'
  status.style.marginBottom = '8px'

  const list = document.createElement('div')
  list.style.display = 'flex'
  list.style.flexDirection = 'column'
  list.style.gap = '6px'

  async function refresh(): Promise<void> {
    status.textContent = 'loading…'
    card.setAttribute('data-state', 'loading')
    list.replaceChildren()
    const res = await apiCall<{ campaigns: CampaignRow[] }>('/api/campaigns/mine')
    if (!res.ok) {
      status.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
      card.setAttribute('data-state', 'error')
      return
    }
    const campaigns = res.body?.campaigns ?? []
    if (campaigns.length === 0) {
      status.textContent = 'no campaigns yet — create one above'
      // Empty list is healthy "loaded" state, not error. Identity bootstrap
      // ensures a fresh dev sub always has a row by the time this fetches.
      card.setAttribute('data-state', 'loaded')
      return
    }
    status.textContent = `${String(campaigns.length)} campaign(s)`
    card.setAttribute('data-state', 'loaded')
    for (const c of campaigns) {
      list.appendChild(buildCampaignRow(c, () => void deleteCampaign(c, refresh)))
    }
  }

  refreshBtn.addEventListener('click', () => {
    void refresh()
  })

  // Refresh after every 201 from the create panel — the new campaign
  // should appear without manual refresh.
  window.addEventListener('mythrun.watchcampaign', () => {
    void refresh()
  })

  // Identity switch clears + reloads under the new identity.
  window.addEventListener('mythrun.closewatch', () => {
    void refresh()
  })

  const headerRow = document.createElement('div')
  headerRow.style.display = 'flex'
  headerRow.style.alignItems = 'center'
  headerRow.style.gap = '8px'
  headerRow.style.marginBottom = '12px'
  headerRow.appendChild(title)
  headerRow.appendChild(refreshBtn)

  card.appendChild(headerRow)
  card.appendChild(status)
  card.appendChild(list)
  parent.appendChild(card)

  // Initial load.
  void refresh()
}
