// Smoke test card. Calls /health AND /health/ready on mount and on
// button click. Does NOT re-run on identity change — both health
// routes are public, so identity has no observable effect; re-running
// would pollute logs for no signal. Future panels that depend on
// identity will subscribe to onIdentityChanged in their own mountFoo().
//
// Pattern: fetch-on-mount. Sets data-state="loading" → "loaded" |
// "error" on the card root. Both probes must complete before the
// panel transitions out of loading; the card renders the union of
// both responses so a single OK button shows the developer the full
// readiness picture (liveness + dependency probes).

import { apiCall } from '../api-client.js'

export function mountHealthPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  card.setAttribute('data-state', 'loading')

  const title = document.createElement('h2')
  title.textContent = 'GET /health + /health/ready'

  const button = document.createElement('button')
  button.textContent = 'Run'

  const result = document.createElement('pre')
  result.className = 'result'
  result.textContent = '(not yet run)'

  async function run(): Promise<void> {
    result.textContent = 'running...'
    card.setAttribute('data-state', 'loading')
    card.classList.remove('ok', 'err')
    const [live, ready] = await Promise.all([apiCall('/health'), apiCall('/health/ready')])
    const lines = [
      `GET /health        status=${String(live.status)} ok=${String(live.ok)} latency=${String(live.latencyMs)}ms`,
      `body: ${live.body !== null ? JSON.stringify(live.body) : '(empty)'}`,
      '',
      `GET /health/ready  status=${String(ready.status)} ok=${String(ready.ok)} latency=${String(ready.latencyMs)}ms`,
      `body: ${ready.body !== null ? JSON.stringify(ready.body, null, 2) : '(empty)'}`,
    ]
    if (live.error !== undefined) lines.push(`/health error: ${live.error}`)
    if (ready.error !== undefined) lines.push(`/health/ready error: ${ready.error}`)
    result.textContent = lines.join('\n')
    const bothOk = live.ok && ready.ok
    card.classList.toggle('ok', bothOk)
    card.classList.toggle('err', !bothOk)
    card.setAttribute('data-state', bothOk ? 'loaded' : 'error')
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
