// backend/dev-tool/src/components/_shared/panel-skeleton.ts
//
// myth-mbdc: split-view DOM builder shared by every endpoint × action
// panel. Builds the standard skeleton (title + two-pane action/feedback
// region) and returns handles for the panel implementation to fill in.
// Plus the PanelHandle interface every panel returns from its mount fn
// per spec §10 (mount lifecycle contract).

export type PanelState = 'idle' | 'loading' | 'ready' | 'error'

export interface SplitViewOpts {
  readonly parent: HTMLElement
  readonly title: string
}

export interface SplitViewHandles {
  readonly root: HTMLElement
  readonly actionEl: HTMLElement
  readonly feedbackEl: HTMLElement
  readonly setState: (state: PanelState) => void
}

export function buildSplitView(opts: SplitViewOpts): SplitViewHandles {
  const root = document.createElement('section')
  root.setAttribute('data-state', 'idle')
  root.style.padding = '12px 16px'
  root.style.background = 'var(--bg-page)'
  root.style.color = 'var(--fg-default)'

  const titleEl = document.createElement('h1')
  titleEl.style.fontFamily = 'var(--mono)'
  titleEl.style.fontSize = '14px'
  titleEl.style.fontWeight = '500'
  titleEl.style.color = 'var(--fg-emphasis)'
  titleEl.style.margin = '0 0 8px 0'
  titleEl.textContent = opts.title
  root.appendChild(titleEl)

  const splitWrap = document.createElement('div')
  splitWrap.style.display = 'flex'
  splitWrap.style.gap = '12px'

  const actionEl = document.createElement('div')
  actionEl.setAttribute('data-region', 'action')
  actionEl.style.flex = '0 0 38%'
  actionEl.style.borderRight = '1px solid var(--border-soft)'
  actionEl.style.paddingRight = '12px'

  const feedbackEl = document.createElement('div')
  feedbackEl.setAttribute('data-region', 'feedback')
  feedbackEl.style.flex = '1'

  splitWrap.appendChild(actionEl)
  splitWrap.appendChild(feedbackEl)
  root.appendChild(splitWrap)

  opts.parent.appendChild(root)

  return {
    root,
    actionEl,
    feedbackEl,
    setState: (state: PanelState) => {
      root.setAttribute('data-state', state)
    },
  }
}

// myth-mbdc spec §10: the lifecycle contract every panel implements.
// Every mount<Panel> function returns this so the shell can tear down
// on sidebar-leaf switch.
export interface PanelHandle {
  readonly root: HTMLElement
  unmount(): void
}
