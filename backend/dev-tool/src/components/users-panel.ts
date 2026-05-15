// User onboarding inspector panel.
//
// Exercises:
//   - GET /api/users/me              — fetches the current dev sub's user row
//   - GET /api/users/check-username  — checks username availability
//
// /api/users/me is fetched on mount + on identity change so the dev can
// see at a glance which row backs the active sub (id, username, display
// name, free_trial_used, stripe_customer_id). The username-availability
// row is an action surface: type a username, hit Check, see available
// + reason.
//
// POST /api/users/register is intentionally NOT exposed here — the dev
// tool's identity bootstrap (scripts/verify.ts + main.ts) handles
// onboarding the active sub. A second register button would only be
// useful for adversarial tests (wrong username vs sub, profanity, etc.)
// and those are covered by the backend route tests.
//
// Pattern: fetch-on-mount (the /me probe is the on-mount fetch).

import { apiCall } from '../api-client.js'
import { onIdentityChanged } from '../identity.js'

interface UserRow {
  readonly id: string
  readonly cognitoSub: string
  readonly username: string
  readonly displayName: string
  readonly stripeCustomerId: string | null
  readonly freeTrialUsed: boolean
}

interface CheckResult {
  readonly available: boolean
  readonly reason?: string
  readonly suggestion?: string
}

function renderMe(row: UserRow): string {
  return [
    `id:               ${row.id}`,
    `cognitoSub:       ${row.cognitoSub}`,
    `username:         ${row.username}`,
    `displayName:      ${row.displayName}`,
    `stripeCustomerId: ${row.stripeCustomerId ?? '(none)'}`,
    `freeTrialUsed:    ${String(row.freeTrialUsed)}`,
  ].join('\n')
}

export function mountUsersPanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'
  card.setAttribute('data-state', 'loading')

  const title = document.createElement('h2')
  title.textContent = 'GET /api/users/me + check-username'

  const meBlock = document.createElement('pre')
  meBlock.className = 'result'
  meBlock.textContent = '(loading...)'

  const checkRow = document.createElement('div')
  checkRow.style.display = 'flex'
  checkRow.style.gap = '8px'
  checkRow.style.marginTop = '12px'
  checkRow.style.alignItems = 'center'

  const usernameInput = document.createElement('input')
  usernameInput.type = 'text'
  usernameInput.placeholder = 'username (3-20 chars)'
  usernameInput.style.width = '240px'

  const checkBtn = document.createElement('button')
  checkBtn.textContent = 'Check availability'

  const checkResult = document.createElement('div')
  checkResult.className = 'result'

  checkRow.appendChild(usernameInput)
  checkRow.appendChild(checkBtn)

  async function loadMe(): Promise<void> {
    meBlock.textContent = 'loading...'
    card.setAttribute('data-state', 'loading')
    const res = await apiCall<{ user: UserRow }>('/api/users/me')
    if (res.status === 200 && res.body !== null) {
      meBlock.textContent = renderMe(res.body.user)
      card.setAttribute('data-state', 'loaded')
      return
    }
    if (res.status === 403) {
      // username_required — the active sub doesn't have a users row yet.
      // The dev tool's bootstrap (main.ts) should have registered it; if
      // this fires the dev is on a fresh DB or a swapped sub. Surface it
      // as a loaded "no row" state, not a hard error (the verify harness
      // bootstraps dev-user-1 explicitly).
      meBlock.textContent =
        'no user row for the active sub (403 username_required).\n' +
        'Use the register helper or switch identity to one that\'s been bootstrapped.'
      card.setAttribute('data-state', 'loaded')
      return
    }
    meBlock.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
    card.setAttribute('data-state', 'error')
  }

  async function checkUsername(): Promise<void> {
    const u = usernameInput.value.trim()
    if (u.length === 0) {
      checkResult.textContent = 'enter a username first'
      return
    }
    checkBtn.disabled = true
    checkResult.textContent = 'checking...'
    const res = await apiCall<CheckResult>(
      `/api/users/check-username?username=${encodeURIComponent(u)}`,
    )
    if (res.status === 200 && res.body !== null) {
      const { available, reason, suggestion } = res.body
      const parts = [`available: ${String(available)}`]
      if (reason !== undefined) parts.push(`reason: ${reason}`)
      if (suggestion !== undefined) parts.push(`suggestion: ${suggestion}`)
      checkResult.textContent = parts.join(' | ')
    } else {
      checkResult.textContent = `error ${String(res.status)}: ${res.error ?? JSON.stringify(res.body)}`
    }
    checkBtn.disabled = false
  }

  checkBtn.addEventListener('click', () => {
    void checkUsername()
  })

  onIdentityChanged(() => {
    checkResult.textContent = ''
    usernameInput.value = ''
    void loadMe()
  })

  card.appendChild(title)
  card.appendChild(meBlock)
  card.appendChild(checkRow)
  card.appendChild(checkResult)
  parent.appendChild(card)

  void loadMe()
}
