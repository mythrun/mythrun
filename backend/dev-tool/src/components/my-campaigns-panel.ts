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

export function mountMyCampaignsPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'

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
    list.replaceChildren()
    const res = await apiCall<{ campaigns: CampaignRow[] }>('/api/campaigns/mine')
    if (!res.ok) {
      status.textContent = `error: ${String(res.status)} ${res.error ?? ''}`
      return
    }
    const campaigns = res.body?.campaigns ?? []
    if (campaigns.length === 0) {
      status.textContent = 'no campaigns yet — create one above'
      return
    }
    status.textContent = `${String(campaigns.length)} campaign(s)`
    for (const c of campaigns) {
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

      row.appendChild(label)
      row.appendChild(watchBtn)
      row.appendChild(detailsBtn)
      list.appendChild(row)
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
