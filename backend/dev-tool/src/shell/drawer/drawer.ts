// backend/dev-tool/src/shell/drawer/drawer.ts
//
// myth-mbdc: right-side persistent wire-log drawer. UI shell for
// the subscriptions / buffer / event-bus trio. Collapsible; default
// open. Pause + clear + export controls land in P4.5.

import type { EventBus } from './event-bus.js'
import type { SubscriptionManager, DrawerEvent } from './subscriptions.js'
import type { RingBuffer } from './buffer.js'

export interface DrawerDeps {
  readonly subscriptions: SubscriptionManager
  readonly bus: EventBus<DrawerEvent>
  readonly buffer: RingBuffer<DrawerEvent>
}

export interface DrawerHandle {
  readonly root: HTMLElement
  unmount(): void
}

const STORAGE_OPEN = 'devtool.drawer.open'
const STORAGE_PAUSED = 'devtool.drawer.paused'

export function mountDrawer(parent: HTMLElement, deps: DrawerDeps): DrawerHandle {
  const root = document.createElement('aside')
  root.setAttribute('data-region', 'drawer')
  root.setAttribute('data-state', 'ready')
  root.style.flex = '0 0 320px'
  root.style.borderLeft = '1px solid var(--border-soft)'
  root.style.background = 'var(--bg-elevated)'
  root.style.display = 'flex'
  root.style.flexDirection = 'column'
  root.style.maxHeight = '100vh'

  const header = document.createElement('div')
  header.style.padding = '6px 10px'
  header.style.borderBottom = '1px solid var(--border-soft)'
  header.style.display = 'flex'
  header.style.justifyContent = 'space-between'
  header.style.alignItems = 'center'
  const title = document.createElement('div')
  title.className = 'label-small'
  title.style.color = 'var(--fg-emphasis)'
  title.textContent = `WIRE LOG · ${String(deps.buffer.size())}`
  header.appendChild(title)
  root.appendChild(header)

  const list = document.createElement('div')
  list.style.padding = '6px 10px'
  list.style.overflow = 'auto'
  list.style.flex = '1'
  list.style.fontSize = '10px'
  list.style.lineHeight = '1.4'
  root.appendChild(list)

  const paused = localStorage.getItem(STORAGE_PAUSED) === 'true'

  function render(): void {
    list.replaceChildren()
    for (const e of deps.buffer.items()) {
      const row = document.createElement('div')
      row.style.marginBottom = '4px'
      const ts = document.createElement('span')
      ts.style.color = 'var(--fg-muted)'
      const d = new Date(e.receivedAt)
      ts.textContent = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`
      row.appendChild(ts)
      const type = document.createElement('span')
      type.style.color = 'var(--accent)'
      type.style.marginLeft = '6px'
      type.textContent = e.type
      row.appendChild(type)
      const cid = document.createElement('span')
      cid.style.color = 'var(--fg-muted)'
      cid.style.marginLeft = '4px'
      cid.textContent = `· ${e.campaignId.slice(0, 8)}`
      row.appendChild(cid)
      list.appendChild(row)
    }
    title.textContent = `WIRE LOG · ${String(deps.buffer.size())}`
  }

  const unsubBus = deps.bus.subscribe((event) => {
    deps.buffer.push(event)
    if (!paused) {
      render()
      list.scrollTop = list.scrollHeight
    }
  })

  render()

  // Apply persisted open/collapsed state
  if (localStorage.getItem(STORAGE_OPEN) === 'false') {
    root.style.flex = '0 0 36px'
    list.style.display = 'none'
    header.style.justifyContent = 'center'
  }

  parent.appendChild(root)

  return {
    root,
    unmount: () => {
      unsubBus()
      parent.removeChild(root)
    },
  }
}
