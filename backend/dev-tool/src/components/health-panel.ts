// Smoke test card. Calls /health/ready on mount and on button click.
// Does NOT re-run on identity change — /health/ready is public, so
// identity has no observable effect; re-running would pollute logs
// for no signal. Future panels that depend on identity will subscribe
// to onIdentityChanged in their own mountFoo().

import { apiCall } from '../api-client.js'

export function mountHealthPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'

  const title = document.createElement('h2')
  title.textContent = 'GET /health/ready'

  const button = document.createElement('button')
  button.textContent = 'Run'

  const result = document.createElement('pre')
  result.className = 'result'
  result.textContent = '(not yet run)'

  async function run(): Promise<void> {
    result.textContent = 'running...'
    card.classList.remove('ok', 'err')
    const res = await apiCall('/health/ready')
    const lines = [
      `status:    ${String(res.status)}`,
      `ok:        ${String(res.ok)}`,
      `latency:   ${String(res.latencyMs)}ms`,
      `body:      ${res.body !== null ? JSON.stringify(res.body, null, 2) : '(empty)'}`,
    ]
    if (res.error !== undefined) lines.push(`error:     ${res.error}`)
    result.textContent = lines.join('\n')
    card.classList.toggle('ok', res.ok)
    card.classList.toggle('err', !res.ok)
  }

  button.addEventListener('click', () => {
    void run()
  })

  card.appendChild(title)
  card.appendChild(button)
  card.appendChild(result)
  parent.appendChild(card)

  void run()
}
