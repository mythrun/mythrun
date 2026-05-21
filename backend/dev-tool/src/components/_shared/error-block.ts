// backend/dev-tool/src/components/_shared/error-block.ts
//
// myth-mbdc: renders the canonical error block — status + code +
// message + optional collapsed raw response. Used in every panel's
// feedback pane on non-2xx responses. Danger-500 left border signals
// failure; raw response disclosure is collapsed by default.

export interface ErrorBlockOpts {
  readonly status: number
  readonly code: string
  readonly message: string
  readonly raw?: unknown
}

export function renderErrorBlock(parent: HTMLElement, opts: ErrorBlockOpts): void {
  parent.replaceChildren()
  const block = document.createElement('div')
  block.style.borderLeft = '2px solid var(--danger)'
  block.style.padding = '6px 8px'
  block.style.background = 'var(--bg-elevated)'

  const line = document.createElement('div')
  line.style.color = 'var(--danger)'
  line.textContent = `${String(opts.status)} · ${opts.code}`
  block.appendChild(line)

  const msg = document.createElement('div')
  msg.style.color = 'var(--fg-default)'
  msg.style.marginTop = '2px'
  msg.textContent = opts.message
  block.appendChild(msg)

  if (opts.raw !== undefined) {
    const details = document.createElement('details')
    details.style.marginTop = '6px'
    const summary = document.createElement('summary')
    summary.textContent = 'raw response'
    summary.style.color = 'var(--fg-muted)'
    summary.style.fontSize = '10px'
    summary.style.cursor = 'pointer'
    const pre = document.createElement('pre')
    pre.style.fontSize = '10px'
    pre.style.background = 'rgba(0,0,0,0.2)'
    pre.style.padding = '4px'
    pre.style.margin = '4px 0 0 0'
    pre.textContent = JSON.stringify(opts.raw, null, 2)
    details.appendChild(summary)
    details.appendChild(pre)
    block.appendChild(details)
  }

  parent.appendChild(block)
}
