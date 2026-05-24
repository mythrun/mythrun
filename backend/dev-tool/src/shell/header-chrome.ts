// backend/dev-tool/src/shell/header-chrome.ts
//
// myth-3lpf + myth-39ud: shell header chrome.
//
// Two always-visible widgets pinned above the banner:
//   1. A backend health pip — polls GET /health every 5s, renders a
//      green/red dot + last-known latency. Distinct from the per-route
//      health-live / health-ready panels (those test specific endpoints
//      against a deliberate trigger); this one is the operator's
//      always-on heartbeat.
//   2. An active-campaign dropdown — lists campaigns from
//      GET /api/campaigns/mine and lets the operator switch the active
//      one without navigating to my-campaigns first. Setting the active
//      campaign triggers the existing onActiveCampaignChanged listeners
//      in the shell (drawer re-subscription + banner refresh).

import { apiCall } from '../api-client.js'
import {
  getActiveCampaignId,
  onActiveCampaignChanged,
  setActiveCampaignId,
} from './active-campaign.js'

export interface HeaderChromeHandle {
  unmount(): void
}

interface MineCampaign {
  readonly id: string
  readonly name: string
  readonly status?: string
}

interface MineResponse {
  readonly campaigns: readonly MineCampaign[]
}

export function mountHeaderChrome(parent: HTMLElement): HeaderChromeHandle {
  const row = document.createElement('div')
  row.setAttribute('data-region', 'header-chrome')
  row.style.display = 'flex'
  row.style.alignItems = 'center'
  row.style.justifyContent = 'flex-end'
  row.style.gap = '12px'
  row.style.padding = '4px 14px'
  row.style.borderBottom = '1px solid var(--border-soft)'
  row.style.background = 'var(--bg-elevated)'
  row.style.color = 'var(--fg-muted)'
  row.style.fontFamily = 'var(--mono)'
  row.style.fontSize = '11px'

  // ---- active-campaign dropdown ----
  const dropdownLabel = document.createElement('span')
  dropdownLabel.textContent = 'campaign:'
  row.appendChild(dropdownLabel)
  const dropdown = document.createElement('select')
  dropdown.style.background = 'var(--bg-default)'
  dropdown.style.color = 'var(--fg-emphasis)'
  dropdown.style.border = '1px solid var(--border-soft)'
  dropdown.style.fontFamily = 'inherit'
  dropdown.style.fontSize = 'inherit'
  dropdown.style.padding = '2px 4px'
  dropdown.style.minWidth = '200px'
  row.appendChild(dropdown)

  // myth-jitter fix: cache the last rendered campaign-id list so the
  // 10s poll only rewrites the dropdown when the available campaigns
  // actually change. Re-rendering on every poll caused a visible
  // flicker + dropped any in-progress user gesture on the <select>.
  let lastSignature: string | null = null

  async function refreshDropdown(): Promise<void> {
    const res = await apiCall<MineResponse>('/api/campaigns/mine')
    const current = getActiveCampaignId()
    const items: MineCampaign[] =
      res.status === 200 && res.body !== null ? Array.from(res.body.campaigns) : []
    const signature = JSON.stringify({
      current,
      ids: items.map((c) => `${c.id}|${c.name}`),
    })
    if (signature === lastSignature) {
      // No change in available campaigns OR in the active id. Make sure
      // the dropdown's current selection still matches the active id
      // (covers the case where another consumer setActiveCampaignId'd
      // to one of the existing options) and bail without re-rendering.
      if (current !== null && dropdown.value !== current) dropdown.value = current
      return
    }
    lastSignature = signature
    dropdown.replaceChildren()
    const blank = document.createElement('option')
    blank.value = ''
    blank.textContent = '(none)'
    dropdown.appendChild(blank)
    for (const c of items) {
      const opt = document.createElement('option')
      opt.value = c.id
      opt.textContent = `${c.name} · ${c.id.slice(0, 8)}…`
      if (c.id === current) opt.selected = true
      dropdown.appendChild(opt)
    }
    if (current !== null && dropdown.value === '') {
      // Active campaign not in the mine list (might be a fresh creation
      // that hasn't propagated). Surface it explicitly so the dropdown
      // doesn't look out-of-sync.
      const opt = document.createElement('option')
      opt.value = current
      opt.textContent = `(active) ${current.slice(0, 8)}…`
      opt.selected = true
      dropdown.appendChild(opt)
    }
  }

  const onDropdownChange = (): void => {
    const v = dropdown.value
    setActiveCampaignId(v === '' ? null : v)
  }
  dropdown.addEventListener('change', onDropdownChange)

  // When the active campaign changes elsewhere (create panel,
  // my-campaigns row click), refresh the dropdown selection.
  const offActive = onActiveCampaignChanged(() => {
    void refreshDropdown()
  })

  // Initial load. Refresh every 10s so newly-created campaigns appear.
  void refreshDropdown()
  const dropdownTimer = setInterval(() => {
    void refreshDropdown()
  }, 10_000)

  // ---- health pip ----
  const sep = document.createElement('span')
  sep.textContent = '·'
  sep.style.color = 'var(--fg-subtle)'
  row.appendChild(sep)
  const healthLabel = document.createElement('span')
  healthLabel.textContent = 'backend:'
  row.appendChild(healthLabel)
  const pip = document.createElement('span')
  pip.style.display = 'inline-block'
  pip.style.width = '8px'
  pip.style.height = '8px'
  pip.style.borderRadius = '50%'
  pip.style.background = 'var(--fg-subtle)'
  row.appendChild(pip)
  const healthText = document.createElement('span')
  healthText.style.color = 'var(--fg-subtle)'
  healthText.textContent = '…'
  row.appendChild(healthText)

  async function refreshHealth(): Promise<void> {
    const start = performance.now()
    const res = await apiCall<{ status?: string }>('/health')
    const latency = Math.round(performance.now() - start)
    if (res.status === 200 && res.body?.status === 'ok') {
      pip.style.background = 'var(--accent)' // theme-defined healthy color
      healthText.textContent = `${String(latency)}ms`
      healthText.style.color = 'var(--fg-muted)'
    } else {
      pip.style.background = 'var(--danger)'
      healthText.textContent = String(res.status)
      healthText.style.color = 'var(--danger)'
    }
  }

  void refreshHealth()
  const healthTimer = setInterval(() => {
    void refreshHealth()
  }, 5_000)

  // Insert above everything else inside `parent` (main).
  parent.insertBefore(row, parent.firstChild)

  return {
    unmount: () => {
      clearInterval(dropdownTimer)
      clearInterval(healthTimer)
      offActive()
      dropdown.removeEventListener('change', onDropdownChange)
      if (row.parentNode !== null) row.parentNode.removeChild(row)
    },
  }
}
