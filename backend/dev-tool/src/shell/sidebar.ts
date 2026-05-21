// backend/dev-tool/src/shell/sidebar.ts
//
// myth-mbdc: endpoint × action leaves grouped by section. Disabled
// leaves render dim when their route requires an active campaign
// and none is set.

import { ROUTE_PANELS, type RoutePanel, type SidebarSection } from './route-registry.js'

export interface SidebarOpts {
  readonly onSelect: (panel: RoutePanel) => void
  readonly getActiveCampaignId: () => string | null
}
export interface SidebarHandle {
  readonly root: HTMLElement
  unmount(): void
  refresh(): void
  setSelected(panel: RoutePanel | null): void
}

const SECTION_ORDER: readonly SidebarSection[] = ['CAMPAIGNS', 'WORLD', 'CHARACTERS', 'USERS', 'BILLING', 'SYSTEM']

export function mountSidebar(parent: HTMLElement, opts: SidebarOpts): SidebarHandle {
  const root = document.createElement('nav')
  root.style.flex = '0 0 220px'
  root.style.padding = '12px 14px'
  root.style.borderRight = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-elevated)'
  root.style.overflow = 'auto'
  root.style.maxHeight = '100vh'

  let selected: RoutePanel | null = null

  function leafKey(p: RoutePanel): string {
    return `${p.method} ${p.path}`
  }

  function render(): void {
    root.replaceChildren()
    const active = opts.getActiveCampaignId()
    for (const section of SECTION_ORDER) {
      const panels = ROUTE_PANELS.filter((p) => p.section === section)
      if (panels.length === 0) continue
      const header = document.createElement('div')
      header.className = 'label-small'
      header.setAttribute('data-section', section)
      header.style.marginTop = '10px'
      header.textContent = section
      root.appendChild(header)
      for (const p of panels) {
        const leaf = document.createElement('div')
        leaf.setAttribute('data-leaf', leafKey(p))
        leaf.style.padding = '2px 6px'
        leaf.style.cursor = 'pointer'
        leaf.style.lineHeight = '1.6'
        const disabled = p.requiresCampaign && active === null
        if (disabled) {
          leaf.setAttribute('data-disabled', 'true')
          leaf.style.color = 'var(--fg-muted)'
          leaf.style.cursor = 'not-allowed'
        } else {
          leaf.style.color = 'var(--fg-default)'
        }
        if (selected !== null && leafKey(selected) === leafKey(p)) {
          leaf.style.background = 'var(--bg-banner)'
          leaf.style.color = 'var(--fg-emphasis)'
          leaf.style.borderLeft = '2px solid var(--accent)'
        }
        const method = document.createElement('span')
        method.style.color = 'var(--fg-muted)'
        method.style.marginRight = '4px'
        method.textContent = p.method
        leaf.appendChild(method)
        const label = document.createElement('span')
        label.textContent = p.label
        leaf.appendChild(label)
        leaf.addEventListener('click', () => {
          if (disabled) return
          opts.onSelect(p)
        })
        root.appendChild(leaf)
      }
    }
  }

  render()
  parent.appendChild(root)

  return {
    root,
    unmount: () => { parent.removeChild(root) },
    refresh: render,
    setSelected: (p) => {
      selected = p
      render()
    },
  }
}
