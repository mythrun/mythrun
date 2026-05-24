// backend/dev-tool/src/shell/sidebar.ts
//
// myth-0smu: workflow-per-page sidebar. Each leaf is one of the 6
// entity-scoped pages declared in workflow-registry.ts. Pages that
// require an active campaign (World, Characters) dim when none is set.

import { WORKFLOWS, type WorkflowDescriptor } from './workflow-registry.js'

export interface SidebarOpts {
  readonly onSelect: (workflow: WorkflowDescriptor) => void
  readonly getActiveCampaignId: () => string | null
}
export interface SidebarHandle {
  readonly root: HTMLElement
  unmount(): void
  refresh(): void
  setSelected(workflow: WorkflowDescriptor | null): void
}

export function mountSidebar(parent: HTMLElement, opts: SidebarOpts): SidebarHandle {
  const root = document.createElement('nav')
  root.style.flex = '0 0 220px'
  root.style.padding = '12px 14px'
  root.style.borderRight = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-elevated)'
  root.style.overflow = 'auto'
  root.style.maxHeight = '100vh'

  let selected: WorkflowDescriptor | null = null

  function render(): void {
    root.replaceChildren()
    const active = opts.getActiveCampaignId()
    const header = document.createElement('div')
    header.className = 'label-small'
    header.setAttribute('data-section', 'WORKFLOWS')
    header.style.marginTop = '4px'
    header.style.marginBottom = '6px'
    header.textContent = 'WORKFLOWS'
    root.appendChild(header)

    for (const w of WORKFLOWS) {
      const leaf = document.createElement('div')
      leaf.setAttribute('data-leaf', w.id)
      leaf.style.padding = '8px 10px'
      leaf.style.marginBottom = '2px'
      leaf.style.borderRadius = '3px'
      leaf.style.cursor = 'pointer'
      leaf.style.fontSize = '14px'
      leaf.style.lineHeight = '1.4'
      const disabled = w.requiresCampaign && active === null
      if (disabled) {
        leaf.setAttribute('data-disabled', 'true')
        leaf.style.color = 'var(--fg-muted)'
        leaf.style.cursor = 'not-allowed'
      } else {
        leaf.style.color = 'var(--fg-default)'
      }
      if (selected !== null && selected.id === w.id) {
        leaf.setAttribute('data-selected', 'true')
        leaf.style.background = 'var(--bg-banner)'
        leaf.style.color = 'var(--fg-emphasis)'
        leaf.style.borderLeft = '2px solid var(--accent)'
      }
      const label = document.createElement('span')
      label.textContent = w.title
      leaf.appendChild(label)
      leaf.addEventListener('click', () => {
        if (disabled) return
        opts.onSelect(w)
      })
      root.appendChild(leaf)
    }
  }

  render()
  parent.appendChild(root)

  return {
    root,
    unmount: () => { parent.removeChild(root) },
    refresh: render,
    setSelected: (w) => {
      selected = w
      render()
    },
  }
}
