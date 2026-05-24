// backend/dev-tool/src/pages/_shared/page-skeleton.ts
//
// myth-0smu: shared composer for workflow pages. A page mount fn
// returns a PanelHandle (same contract as a panel) but its root is a
// scrolling column containing N child panel mounts. The helper here
// builds the column, mounts each composed panel into a section card,
// tracks their handles, and unmounts them all in reverse order on
// page unmount.
//
// Pages that need conditional sections (e.g. campaign-required sections
// that hide until an active campaign is picked) build their own
// reactive layer on top — the helper is intentionally dumb.

import type { PanelHandle } from '../../components/_shared/panel-skeleton.js'

export interface PageSection {
  readonly id: string
  readonly mount: (parent: HTMLElement) => PanelHandle
}

export interface PageBody {
  readonly root: HTMLElement
  /** Mount a section into the page body. Returns the section host element. */
  mountSection: (id: string, mount: (parent: HTMLElement) => PanelHandle) => HTMLElement
  /** Remove the section by id (unmounts the child panel + drops the host). */
  removeSection: (id: string) => void
  /** Unmount every section in reverse order + clear children. */
  unmountAll: () => void
}

export function buildPageBody(parent: HTMLElement, title: string): PageBody {
  const root = document.createElement('div')
  root.setAttribute('data-page', title)
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.style.gap = '16px'
  root.style.padding = '12px 16px'

  const heading = document.createElement('h1')
  heading.textContent = title
  heading.style.fontFamily = 'var(--mono)'
  heading.style.fontSize = '15px'
  heading.style.fontWeight = '600'
  heading.style.color = 'var(--fg-emphasis)'
  heading.style.margin = '0 0 4px 0'
  root.appendChild(heading)

  parent.appendChild(root)

  // Ordered: insertion order matters for visual flow + reverse-unmount.
  const handles: { id: string; host: HTMLElement; handle: PanelHandle }[] = []

  function mountSection(id: string, mount: (p: HTMLElement) => PanelHandle): HTMLElement {
    const host = document.createElement('div')
    host.setAttribute('data-section-id', id)
    host.style.background = 'var(--bg-page)'
    host.style.border = '1px solid var(--border-soft)'
    host.style.borderRadius = '4px'
    root.appendChild(host)
    const handle = mount(host)
    handles.push({ id, host, handle })
    return host
  }

  function removeSection(id: string): void {
    const idx = handles.findIndex((h) => h.id === id)
    if (idx < 0) return
    const entry = handles[idx]
    if (entry === undefined) return
    try {
      entry.handle.unmount()
    } catch {
      // Best-effort; we still want to drop the host even if unmount throws.
    }
    if (entry.host.parentNode !== null) entry.host.parentNode.removeChild(entry.host)
    handles.splice(idx, 1)
  }

  function unmountAll(): void {
    // Reverse order — last-mounted first.
    while (handles.length > 0) {
      const entry = handles.pop()
      if (entry === undefined) continue
      try {
        entry.handle.unmount()
      } catch {
        // continue
      }
      if (entry.host.parentNode !== null) entry.host.parentNode.removeChild(entry.host)
    }
  }

  return { root, mountSection, removeSection, unmountAll }
}
