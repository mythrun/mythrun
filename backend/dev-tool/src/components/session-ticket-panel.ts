// WS ticket panel.
//
// Exercises POST /api/sessions/:id/ws-ticket — the HTTP half of the
// WebSocket-ticket exchange. The dev tool doesn't speak WebSockets
// yet (the upgrade handler lands in the Session Runtime milestone),
// but the ticket-mint route needs an action surface so the route audit
// can confirm coverage.
//
// Form: paste a sessionId (UUID), click Mint. The response carries
// `{ ticket, expiresAt }`; the panel renders both. 404 (session not
// found) and 403 (not a member) are the common error paths and render
// as plain status text.
//
// Pattern: action-only.

import { apiCall } from '../api-client.js'
import { onIdentityChanged } from '../identity.js'

interface TicketResponse {
  readonly ticket: string
  readonly expiresAt: string
}

export function mountSessionTicketPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  card.setAttribute('data-state', 'ready')

  const title = document.createElement('h2')
  title.textContent = 'POST /api/sessions/:id/ws-ticket'

  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'sessionId (paste a UUID)'
  input.style.width = '320px'

  const btn = document.createElement('button')
  btn.textContent = 'Mint ticket'
  btn.style.marginLeft = '8px'

  const inputRow = document.createElement('div')
  inputRow.style.display = 'flex'
  inputRow.style.gap = '8px'
  inputRow.style.marginBottom = '12px'
  inputRow.appendChild(input)
  inputRow.appendChild(btn)

  const result = document.createElement('pre')
  result.className = 'result'
  result.textContent = '(no ticket yet)'

  async function mint(): Promise<void> {
    const id = input.value.trim()
    if (id.length === 0) {
      result.textContent = 'paste a sessionId first'
      return
    }
    btn.disabled = true
    result.textContent = 'minting...'
    const res = await apiCall<TicketResponse>(`/api/sessions/${id}/ws-ticket`, {
      method: 'POST',
    })
    if (res.status === 200 && res.body !== null) {
      result.textContent = `ticket:    ${res.body.ticket}\nexpiresAt: ${res.body.expiresAt}`
    } else {
      result.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
    }
    btn.disabled = false
  }

  btn.addEventListener('click', () => {
    void mint()
  })

  onIdentityChanged(() => {
    input.value = ''
    result.textContent = '(no ticket yet)'
  })

  card.appendChild(title)
  card.appendChild(inputRow)
  card.appendChild(result)
  parent.appendChild(card)
}
