// backend/dev-tool/src/components/_shared/progress-strip.ts
//
// myth-mbdc: stage progress visualization for long-running panels.
// Renders a label + n/total counter + a horizontal bar. Used by
// POST /api/campaigns, POST /start-character-creation, POST /characters.

export interface ProgressStripOpts {
  readonly total: number
}
interface ProgressUpdate {
  readonly current: number
  readonly label: string
}
export interface ProgressStripHandle {
  readonly root: HTMLElement
  update(u: ProgressUpdate): void
}

export function createProgressStrip(
  parent: HTMLElement,
  opts: ProgressStripOpts,
): ProgressStripHandle {
  const root = document.createElement('div')
  root.setAttribute('data-progress', '0')
  root.style.margin = '6px 0'

  const labelEl = document.createElement('div')
  labelEl.style.fontSize = '11px'
  labelEl.style.color = 'var(--fg-emphasis)'
  labelEl.textContent = `0/${String(opts.total)}`
  root.appendChild(labelEl)

  const barWrap = document.createElement('div')
  barWrap.style.background = 'var(--bg-elevated)'
  barWrap.style.height = '6px'
  barWrap.style.marginTop = '3px'
  barWrap.style.border = '1px solid var(--border-soft)'
  const barFill = document.createElement('div')
  barFill.style.height = '100%'
  barFill.style.width = '0%'
  barFill.style.background = 'var(--accent)'
  barWrap.appendChild(barFill)
  root.appendChild(barWrap)

  parent.appendChild(root)

  return {
    root,
    update: ({ current, label }) => {
      const pct = Math.min(100, Math.round((current / opts.total) * 100))
      labelEl.textContent = `${String(current)}/${String(opts.total)}  ${label}`
      barFill.style.width = `${String(pct)}%`
      root.setAttribute('data-progress', String(pct))
    },
  }
}
