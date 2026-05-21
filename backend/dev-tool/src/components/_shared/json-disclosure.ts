// backend/dev-tool/src/components/_shared/json-disclosure.ts
//
// myth-mbdc: collapsed raw-json viewer for panel feedback panes.
// Default-collapsed so the rendered structured view (list, detail
// card, etc.) is what the operator sees first; expand for the raw
// response body.

export function appendJsonDisclosure(parent: HTMLElement, body: unknown): void {
  const details = document.createElement('details')
  details.style.marginTop = '8px'
  const summary = document.createElement('summary')
  summary.textContent = '▸ raw json'
  summary.style.color = 'var(--fg-muted)'
  summary.style.fontSize = '10px'
  summary.style.cursor = 'pointer'
  const pre = document.createElement('pre')
  pre.style.fontSize = '10px'
  pre.style.background = 'rgba(0,0,0,0.2)'
  pre.style.padding = '4px'
  pre.style.margin = '4px 0 0 0'
  pre.style.overflow = 'auto'
  pre.style.maxHeight = '300px'
  pre.textContent = JSON.stringify(body, null, 2)
  details.appendChild(summary)
  details.appendChild(pre)
  parent.appendChild(details)
}
