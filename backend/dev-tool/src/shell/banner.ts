// backend/dev-tool/src/shell/banner.ts
//
// myth-mbdc: active-campaign banner. Pinned below the header.
// Updates via setCampaign on phase / stage events.

export interface BannerCampaignInfo {
  readonly id: string
  readonly name: string
  readonly stage: string // current stage label
}

export interface BannerOpts {
  readonly getActiveCampaignId: () => string | null
}

export interface BannerHandle {
  readonly root: HTMLElement
  unmount(): void
  setCampaign(info: BannerCampaignInfo | null): void
}

export function mountBanner(parent: HTMLElement, opts: BannerOpts): BannerHandle {
  const root = document.createElement('div')
  root.setAttribute('data-region', 'banner')
  root.style.padding = '6px 14px'
  root.style.borderBottom = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-banner)'
  root.style.color = 'var(--fg-default)'
  root.style.fontFamily = 'var(--mono)'
  root.style.fontSize = '11px'

  function render(info: BannerCampaignInfo | null): void {
    root.replaceChildren()
    if (info === null) {
      root.style.color = 'var(--fg-muted)'
      root.textContent = '(no active campaign — pick one in GET /api/campaigns/mine or create one)'
      return
    }
    root.style.color = 'var(--fg-default)'
    const bar = document.createElement('span')
    bar.style.color = 'var(--accent)'
    bar.textContent = '▌ '
    root.appendChild(bar)
    const name = document.createElement('span')
    name.style.color = 'var(--fg-emphasis)'
    name.textContent = info.name
    root.appendChild(name)
    const id = document.createElement('span')
    id.style.color = 'var(--fg-muted)'
    id.style.marginLeft = '8px'
    id.textContent = info.id.slice(0, 8) + '…'
    root.appendChild(id)
    const stage = document.createElement('span')
    stage.style.color = 'var(--accent)'
    stage.style.marginLeft = '8px'
    stage.textContent = `stage ${info.stage}`
    root.appendChild(stage)
  }

  // Initial render — based on active id existence; full info filled
  // in by the shell when it has fetched the campaign detail.
  const initialId = opts.getActiveCampaignId()
  render(initialId === null ? null : { id: initialId, name: '(loading)', stage: '(unknown)' })

  parent.appendChild(root)
  return {
    root,
    unmount: () => {
      parent.removeChild(root)
    },
    setCampaign: render,
  }
}
