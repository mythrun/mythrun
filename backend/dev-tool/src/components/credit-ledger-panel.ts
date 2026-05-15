// MYT-51 T13 — credit-ledger-panel.
//
// Force-grant button + balance + last-20-entries log for the credit
// ledger. Drives the dev-only POST /api/dev/credits/grant route (spec
// D13). That route is `AUTH_MODE=bypass`-gated and always grants to the
// canonical `bypass:dev-1` identity — the dev-tool's identity switcher
// (which selects `dev-user-1`..`dev-user-5`) is intentionally NOT honored
// here, so the displayed balance is `bypass:dev-1`'s.
//
// No dev-only GET endpoint exists for the ledger, so the panel maintains
// an in-session log of grants it issued (last 20). Balance comes from
// the `newBalance` field on the POST response. This is sufficient for
// the cost-cap smoke loop's "grant, retry, observe" pattern — every
// change to `bypass:dev-1`'s ledger that the dev cares about flows
// through this panel.
//
// SCROLL_TO_GRANT_EVENT (dispatched by the create panel's 403 branch)
// scrolls the page to this panel.

import { apiCall } from '../api-client.js'
import { SCROLL_TO_GRANT_EVENT } from './campaign-create-panel.js'

interface GrantResponse {
  readonly ledgerId: string
  readonly newBalance: number
}

type CreditType = 'world_gen' | 'session'

interface LocalEntry {
  readonly at: string // ISO timestamp
  readonly creditType: CreditType
  readonly amount: number
  readonly ledgerId: string
  readonly newBalance: number
}

interface GrantFormDom {
  readonly row: HTMLElement
  readonly typeSelect: HTMLSelectElement
  readonly amountInput: HTMLInputElement
  readonly grantBtn: HTMLButtonElement
}

function buildGrantForm(): GrantFormDom {
  const row = document.createElement('div')
  row.style.display = 'flex'
  row.style.gap = '8px'
  row.style.marginBottom = '12px'
  row.style.alignItems = 'center'

  const typeSelect = document.createElement('select')
  for (const t of ['world_gen', 'session']) {
    const opt = document.createElement('option')
    opt.value = t
    opt.textContent = t
    typeSelect.appendChild(opt)
  }

  const amountInput = document.createElement('input')
  amountInput.type = 'number'
  amountInput.min = '1'
  amountInput.max = '100'
  amountInput.value = '5'
  amountInput.style.width = '80px'

  const grantBtn = document.createElement('button')
  grantBtn.textContent = 'Force grant'

  row.appendChild(typeSelect)
  row.appendChild(amountInput)
  row.appendChild(grantBtn)
  return { row, typeSelect, amountInput, grantBtn }
}

function buildLogElements(): { heading: HTMLElement; log: HTMLElement } {
  const heading = document.createElement('div')
  heading.style.fontFamily = 'var(--mono)'
  heading.style.fontSize = '12px'
  heading.style.color = 'var(--fg-muted)'
  heading.style.marginBottom = '4px'
  heading.textContent = 'grants this session (last 20):'

  const log = document.createElement('pre')
  log.style.whiteSpace = 'pre-wrap'
  log.style.fontFamily = 'var(--mono)'
  log.style.fontSize = '12px'
  log.style.margin = '0'
  log.textContent = '(no grants yet)'

  return { heading, log }
}

interface LedgerState {
  worldGenBalance: number | null
  sessionBalance: number | null
  readonly entries: LocalEntry[]
}

interface LedgerDom {
  readonly balanceEl: HTMLElement
  readonly logEl: HTMLElement
  readonly status: HTMLElement
  readonly grantBtn: HTMLButtonElement
  readonly refreshBtn: HTMLButtonElement
  readonly typeSelect: HTMLSelectElement
  readonly amountInput: HTMLInputElement
}

function renderBalance(state: LedgerState, balanceEl: HTMLElement): void {
  const wg = state.worldGenBalance === null
    ? '(unknown — issue a grant to query)'
    : String(state.worldGenBalance)
  const ss = state.sessionBalance === null
    ? '(unknown — issue a grant to query)'
    : String(state.sessionBalance)
  balanceEl.textContent = `world_gen: ${wg}\nsession:   ${ss}`
}

function renderLog(entries: readonly LocalEntry[], logEl: HTMLElement): void {
  if (entries.length === 0) {
    logEl.textContent = '(no grants yet)'
    return
  }
  logEl.textContent = entries
    .map(
      (e) =>
        `${e.at} ${e.creditType.padEnd(10)} +${String(e.amount).padStart(3)} → ${String(e.newBalance).padStart(4)} (id=${e.ledgerId})`,
    )
    .join('\n')
}

async function doGrant(state: LedgerState, dom: LedgerDom): Promise<void> {
  const creditType = dom.typeSelect.value === 'session' ? 'session' : 'world_gen'
  const amount = Number.parseInt(dom.amountInput.value, 10)
  if (!Number.isInteger(amount) || amount < 1 || amount > 100) {
    dom.status.textContent = 'amount must be an integer 1..100'
    return
  }
  dom.grantBtn.disabled = true
  dom.status.textContent = 'granting...'
  const res = await apiCall<GrantResponse>('/api/dev/credits/grant', {
    method: 'POST',
    body: JSON.stringify({ creditType, amount }),
  })
  if (res.status === 201 && res.body !== null) {
    const body = res.body
    if (creditType === 'world_gen') state.worldGenBalance = body.newBalance
    else state.sessionBalance = body.newBalance
    renderBalance(state, dom.balanceEl)
    state.entries.unshift({
      at: new Date().toISOString(),
      creditType,
      amount,
      ledgerId: body.ledgerId,
      newBalance: body.newBalance,
    })
    if (state.entries.length > 20) state.entries.length = 20
    renderLog(state.entries, dom.logEl)
    dom.status.textContent = `201 — ledgerId ${body.ledgerId}, newBalance ${String(body.newBalance)}`
  } else {
    dom.status.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
  }
  dom.grantBtn.disabled = false
}

async function doRefresh(state: LedgerState, dom: LedgerDom): Promise<void> {
  dom.refreshBtn.disabled = true
  dom.status.textContent = 'fetching balance from server...'
  const res = await apiCall<{
    sub: string
    balances: { world_gen: number; session: number }
  }>('/api/dev/credits/me')
  if (res.status === 200 && res.body !== null) {
    state.worldGenBalance = res.body.balances.world_gen
    state.sessionBalance = res.body.balances.session
    renderBalance(state, dom.balanceEl)
    dom.status.textContent = `balance refreshed from server (sub=${res.body.sub})`
  } else {
    dom.status.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
  }
  dom.refreshBtn.disabled = false
}

export function mountCreditLedgerPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  // Action-only panel: the grant form is the steady state. Mark the card
  // root with data-state="ready" so the verify harness recognizes it as
  // a healthy idle mount, distinct from a fetch panel that has not yet
  // finished loading. Principle 5 (explicit error surface): the
  // "(unknown — issue a grant to query)" copy is the idle balance display,
  // not a stuck placeholder; the marker makes that intent legible.
  card.setAttribute('data-state', 'ready')

  const title = document.createElement('h2')
  title.textContent = 'POST /api/dev/credits/grant (bypass:dev-1 only)'

  const balanceEl = document.createElement('div')
  balanceEl.className = 'result'
  balanceEl.style.marginBottom = '12px'

  const form = buildGrantForm()
  const { typeSelect, amountInput, grantBtn } = form

  // Refresh-from-server button exercises GET /api/dev/credits/me so the
  // panel's displayed balance reflects DB state — not just grants we
  // issued this session (debits from campaign creation + cost-cap refunds
  // are otherwise invisible to the in-session log).
  const refreshBtn = document.createElement('button')
  refreshBtn.textContent = 'Refresh balance'
  refreshBtn.style.marginLeft = '8px'
  form.row.appendChild(refreshBtn)

  const logParts = buildLogElements()
  const status = document.createElement('div')
  status.className = 'result'

  const state: LedgerState = { worldGenBalance: null, sessionBalance: null, entries: [] }
  const dom: LedgerDom = {
    balanceEl,
    logEl: logParts.log,
    status,
    grantBtn,
    refreshBtn,
    typeSelect,
    amountInput,
  }

  renderBalance(state, balanceEl)
  grantBtn.addEventListener('click', () => {
    void doGrant(state, dom)
  })
  refreshBtn.addEventListener('click', () => {
    void doRefresh(state, dom)
  })

  window.addEventListener(SCROLL_TO_GRANT_EVENT, () => {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' })
    grantBtn.focus()
  })

  window.addEventListener('mythrun.ledgerpanel.clear', () => {
    // Identity switch — the grant route is pinned to bypass:dev-1, but
    // the dev's mental model is "I switched users, the panel should
    // forget my last-known view". Clear the in-session log + balances.
    state.entries.length = 0
    state.worldGenBalance = null
    state.sessionBalance = null
    renderBalance(state, balanceEl)
    renderLog(state.entries, logParts.log)
    status.textContent = ''
  })

  card.appendChild(title)
  card.appendChild(balanceEl)
  card.appendChild(form.row)
  card.appendChild(logParts.heading)
  card.appendChild(logParts.log)
  card.appendChild(status)
  parent.appendChild(card)
}
