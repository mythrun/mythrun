// Billing panel.
//
// Exercises every MYT-42 billing route in a single action surface:
//   GET  /api/billing/skus          — public pricing catalogue
//   GET  /api/billing/balance       — credit balances + active sub summary
//   GET  /api/billing/subscription  — full active subscription row or null
//   GET  /api/billing/history       — cursor-paginated billing audit feed
//   POST /api/billing/checkout      — cart → Stripe Checkout Session
//   POST /api/billing/portal        — Stripe Customer Portal session
//   POST /api/billing/upgrade-tier  — monotonic tier upgrade
//
// The Stripe integration isn't necessarily wired in local dev (no
// stripe.com network call expected), so most POST routes are expected
// to surface 502 stripe_unavailable, 400 body_invalid, or 503
// sku_cache_unavailable. The panel renders whatever the backend returns
// without trying to interpret it — the dev's job is to see the wire
// shape and confirm the route is registered + authenticated.
//
// Pattern: action-only. Each row is a one-button probe rendering its
// raw JSON response below the row.

import { apiCall } from '../api-client.js'
import { onIdentityChanged } from '../identity.js'

interface ProbeRowDom {
  readonly row: HTMLElement
  readonly result: HTMLElement
}

function buildProbeRow(label: string): ProbeRowDom {
  const row = document.createElement('div')
  row.style.marginBottom = '10px'

  const heading = document.createElement('div')
  heading.style.fontFamily = 'var(--mono)'
  heading.style.fontSize = '12px'
  heading.style.color = 'var(--fg-muted)'
  heading.style.marginBottom = '2px'
  heading.textContent = label

  const result = document.createElement('pre')
  result.className = 'result'
  result.textContent = '(not yet run)'
  result.style.margin = '4px 0 0 0'

  row.appendChild(heading)
  row.appendChild(result)
  return { row, result }
}

async function runProbe(
  display: HTMLElement,
  fn: () => Promise<{ status: number; body: unknown; error?: string }>,
): Promise<void> {
  display.textContent = 'running...'
  const res = await fn()
  const tag = res.status >= 200 && res.status < 300 ? '✓' : '✗'
  const bodyPart = res.body !== null ? JSON.stringify(res.body, null, 2) : '(empty)'
  display.textContent = `${tag} ${String(res.status)}\n${bodyPart}${
    res.error !== undefined ? `\nerror: ${res.error}` : ''
  }`
}

interface DomRefs {
  readonly skus: ProbeRowDom
  readonly balance: ProbeRowDom
  readonly subscription: ProbeRowDom
  readonly history: ProbeRowDom
  readonly checkout: ProbeRowDom
  readonly portal: ProbeRowDom
  readonly upgrade: ProbeRowDom
  readonly targetTierInput: HTMLInputElement
  readonly lookupKeyInput: HTMLInputElement
}

function buildSimpleProbe(label: string, btnText: string): ProbeRowDom & { btn: HTMLButtonElement } {
  const probe = buildProbeRow(label)
  const btn = document.createElement('button')
  btn.textContent = btnText
  probe.row.insertBefore(btn, probe.result)
  return { ...probe, btn }
}

function buildInputProbe(
  label: string,
  placeholder: string,
  btnText: string,
): ProbeRowDom & { btn: HTMLButtonElement; input: HTMLInputElement } {
  const probe = buildProbeRow(label)
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = placeholder
  input.style.width = '280px'
  input.style.marginRight = '6px'
  const btn = document.createElement('button')
  btn.textContent = btnText
  probe.row.insertBefore(input, probe.result)
  probe.row.insertBefore(btn, probe.result)
  return { ...probe, btn, input }
}

function buildAllRows(): { dom: DomRefs; root: HTMLElement } {
  const root = document.createElement('div')

  const skus = buildSimpleProbe('GET /api/billing/skus', 'Fetch SKUs')
  const balance = buildSimpleProbe('GET /api/billing/balance', 'Fetch balance')
  const subscription = buildSimpleProbe('GET /api/billing/subscription', 'Fetch subscription')
  const history = buildSimpleProbe('GET /api/billing/history', 'Fetch history (first page)')
  const checkout = buildInputProbe(
    'POST /api/billing/checkout (sample one-time cart)',
    'lookup_key for checkout/upgrade',
    'Submit checkout',
  )
  const portal = buildSimpleProbe('POST /api/billing/portal', 'Open portal session')
  const upgrade = buildInputProbe(
    'POST /api/billing/upgrade-tier',
    'target_tier_lookup_key',
    'Submit upgrade',
  )

  for (const r of [skus, balance, subscription, history, checkout, portal, upgrade]) {
    root.appendChild(r.row)
  }

  skus.btn.addEventListener('click', () => {
    void runProbe(skus.result, () => apiCall('/api/billing/skus'))
  })
  balance.btn.addEventListener('click', () => {
    void runProbe(balance.result, () => apiCall('/api/billing/balance'))
  })
  subscription.btn.addEventListener('click', () => {
    void runProbe(subscription.result, () => apiCall('/api/billing/subscription'))
  })
  history.btn.addEventListener('click', () => {
    void runProbe(history.result, () => apiCall('/api/billing/history'))
  })
  checkout.btn.addEventListener('click', () => {
    const lk = checkout.input.value.trim()
    if (lk.length === 0) {
      checkout.result.textContent = 'enter a lookup_key first (e.g. sku_session)'
      return
    }
    void runProbe(checkout.result, () =>
      apiCall('/api/billing/checkout', {
        method: 'POST',
        body: JSON.stringify({
          items: [{ lookup_key: lk, quantity: 1 }],
          success_url: 'http://127.0.0.1:5273/billing/success',
          cancel_url: 'http://127.0.0.1:5273/billing/cancel',
        }),
      }),
    )
  })
  portal.btn.addEventListener('click', () => {
    void runProbe(portal.result, () =>
      apiCall('/api/billing/portal', {
        method: 'POST',
        body: JSON.stringify({ return_url: 'http://127.0.0.1:5273/billing/return' }),
      }),
    )
  })
  upgrade.btn.addEventListener('click', () => {
    const lk = upgrade.input.value.trim()
    if (lk.length === 0) {
      upgrade.result.textContent = 'enter a target_tier_lookup_key first'
      return
    }
    void runProbe(upgrade.result, () =>
      apiCall('/api/billing/upgrade-tier', {
        method: 'POST',
        body: JSON.stringify({ target_tier_lookup_key: lk }),
      }),
    )
  })

  return {
    dom: {
      skus,
      balance,
      subscription,
      history,
      checkout,
      portal,
      upgrade,
      targetTierInput: upgrade.input,
      lookupKeyInput: checkout.input,
    },
    root,
  }
}

export function mountBillingPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  card.setAttribute('data-state', 'ready')

  const title = document.createElement('h2')
  title.textContent = 'Billing routes'

  const note = document.createElement('div')
  note.className = 'result'
  note.style.fontSize = '11px'
  note.style.color = 'var(--fg-muted)'
  note.style.marginBottom = '8px'
  note.textContent =
    'Each row probes one billing route. Stripe-bound POSTs may return 502 stripe_unavailable in local dev — the panel surfaces whatever the backend returns.'

  const { dom, root } = buildAllRows()

  card.appendChild(title)
  card.appendChild(note)
  card.appendChild(root)
  parent.appendChild(card)

  onIdentityChanged(() => {
    dom.skus.result.textContent = '(not yet run)'
    dom.balance.result.textContent = '(not yet run)'
    dom.subscription.result.textContent = '(not yet run)'
    dom.history.result.textContent = '(not yet run)'
    dom.checkout.result.textContent = '(not yet run)'
    dom.portal.result.textContent = '(not yet run)'
    dom.upgrade.result.textContent = '(not yet run)'
    dom.targetTierInput.value = ''
    dom.lookupKeyInput.value = ''
  })
}
