// MYT-51 T13 — campaign-create-panel.
//
// Mode toggle (freeform | guided) over a single shared submit pipeline.
// Freeform: name + concept textarea. Guided: name + 3 picks ({title,
// whyILikeIt}) per spec D4. Submit goes through `apiCall` to
// POST /api/campaigns; the route's discriminated `code` field steers the
// rendered error UX per spec § "POST /api/campaigns flow":
//
//   400 invalid_body                          → field-level Zod hint
//   403 insufficient_credits                  → link to credit-grant
//   409 concurrent_generation_in_progress     → disable submit until clear
//   422 concept_rejected                      → rejectionMessage + (guided)
//                                                a collapsed "see what was
//                                                judged" expander
//   429 rejection_storm_cooldown              → Retry-After countdown
//   503 queue_full                            → Retry-After countdown
//   201                                       → dispatch a window event
//                                                 the status panel listens
//                                                 for and starts watching
//                                                 the new campaignId
//
// XSS: `rejectionMessage` is Sonnet-authored and adversarially-influenced
// by user input (Roc-C2). It is written via `el.textContent` ONLY, never
// `innerHTML` — same rule applies to every server-returned string field
// in this panel.

import { apiCall } from '../api-client.js'

// Events broadcast on the window so the status-panel can pick the new
// campaignId up without create-panel reaching across module boundaries.
// The credit-ledger panel listens on a separate event for the "scroll
// to grant button" link in the 403 branch.
export const WATCH_CAMPAIGN_EVENT = 'mythrun.watchcampaign'
export const CLOSE_WATCH_EVENT = 'mythrun.closewatch'
export const SCROLL_TO_GRANT_EVENT = 'mythrun.scrolltogrant'

interface ConceptRejectedBody {
  readonly code: 'concept_rejected'
  readonly reason: 'srd_incompat' | 'clone_intent' | 'inappropriate'
  readonly rejectionMessage: string | null
  readonly synthesizedConcept?: string
}

interface CreateSuccess {
  readonly campaignId: string
}

// Best-effort narrowing — the dev tool's apiCall returns the JSON-parsed
// body as `unknown`; we never trust the shape, just probe the fields we
// care about per the discriminator. No `as` casts (lint ban).

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readCode(body: unknown): string | null {
  if (!isObject(body)) return null
  const code = body.code
  return typeof code === 'string' ? code : null
}

function readConceptRejected(body: unknown): ConceptRejectedBody | null {
  if (!isObject(body)) return null
  if (body.code !== 'concept_rejected') return null
  const reason = body.reason
  if (reason !== 'srd_incompat' && reason !== 'clone_intent' && reason !== 'inappropriate') {
    return null
  }
  const msg = body.rejectionMessage
  const synth = body.synthesizedConcept
  const result: ConceptRejectedBody = {
    code: 'concept_rejected',
    reason,
    rejectionMessage: typeof msg === 'string' ? msg : null,
    ...(typeof synth === 'string' ? { synthesizedConcept: synth } : {}),
  }
  return result
}

function readCreateSuccess(body: unknown): CreateSuccess | null {
  if (!isObject(body)) return null
  const id = body.campaignId
  return typeof id === 'string' && id.length > 0 ? { campaignId: id } : null
}

function readRetryAfterSeconds(body: unknown): number | null {
  if (!isObject(body)) return null
  const v = body.retryAfterSeconds
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null
}

type Mode = 'freeform' | 'guided'

interface ModeToggle {
  readonly row: HTMLElement
  readonly freeformRadio: HTMLInputElement
  readonly guidedRadio: HTMLInputElement
}

function buildModeToggle(): ModeToggle {
  const row = document.createElement('div')
  row.style.display = 'flex'
  row.style.gap = '12px'
  row.style.marginBottom = '12px'

  const freeformLabel = document.createElement('label')
  const freeformRadio = document.createElement('input')
  freeformRadio.type = 'radio'
  freeformRadio.name = 'mythrun-create-mode'
  freeformRadio.value = 'freeform'
  freeformRadio.checked = true
  freeformLabel.appendChild(freeformRadio)
  freeformLabel.append(' freeform')

  const guidedLabel = document.createElement('label')
  const guidedRadio = document.createElement('input')
  guidedRadio.type = 'radio'
  guidedRadio.name = 'mythrun-create-mode'
  guidedRadio.value = 'guided'
  guidedLabel.appendChild(guidedRadio)
  guidedLabel.append(' guided (3 picks)')

  row.appendChild(freeformLabel)
  row.appendChild(guidedLabel)
  return { row, freeformRadio, guidedRadio }
}

interface GuidedFields {
  readonly wrap: HTMLElement
  readonly titleInputs: readonly HTMLInputElement[]
  readonly whyInputs: readonly HTMLTextAreaElement[]
}

function buildGuidedFields(): GuidedFields {
  const wrap = document.createElement('div')
  wrap.style.display = 'none'
  const titleInputs: HTMLInputElement[] = []
  const whyInputs: HTMLTextAreaElement[] = []
  for (let i = 0; i < 3; i++) {
    const row = document.createElement('div')
    row.style.marginBottom = '8px'

    const heading = document.createElement('div')
    heading.style.fontSize = '12px'
    heading.style.color = 'var(--fg-muted)'
    heading.style.marginBottom = '4px'
    heading.textContent = `Pick ${String(i + 1)}`

    const titleEl = document.createElement('input')
    titleEl.type = 'text'
    titleEl.placeholder = 'title (≤200 chars)'
    titleEl.style.width = '100%'
    titleEl.style.marginBottom = '4px'

    const whyEl = document.createElement('textarea')
    whyEl.placeholder = 'whyILikeIt (≤800 chars)'
    whyEl.rows = 2
    whyEl.style.width = '100%'
    whyEl.style.fontFamily = 'inherit'
    whyEl.style.fontSize = '13px'

    row.appendChild(heading)
    row.appendChild(titleEl)
    row.appendChild(whyEl)
    wrap.appendChild(row)
    titleInputs.push(titleEl)
    whyInputs.push(whyEl)
  }
  return { wrap, titleInputs, whyInputs }
}

function buildFreeformFields(): { wrap: HTMLElement; textarea: HTMLTextAreaElement } {
  const wrap = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.placeholder = 'concept (20-4000 chars)'
  textarea.rows = 5
  textarea.style.width = '100%'
  textarea.style.fontFamily = 'inherit'
  textarea.style.fontSize = '13px'
  wrap.appendChild(textarea)
  return { wrap, textarea }
}

export function mountCampaignCreatePanel(parent: HTMLElement): void {
  const card = document.createElement('section')
  card.className = 'card'

  const title = document.createElement('h2')
  title.textContent = 'POST /api/campaigns (create)'

  const modeToggle = buildModeToggle()
  const guided = buildGuidedFields()
  const freeform = buildFreeformFields()

  // Local aliases for compact reference downstream.
  const modeFreeformRadio = modeToggle.freeformRadio
  const modeGuidedRadio = modeToggle.guidedRadio
  const conceptTextarea = freeform.textarea
  const freeformWrap = freeform.wrap
  const guidedWrap = guided.wrap
  const titleInputs = guided.titleInputs
  const whyInputs = guided.whyInputs

  // ---- shared name field -----------------------------------------------
  const nameInput = document.createElement('input')
  nameInput.type = 'text'
  nameInput.placeholder = 'campaign name'
  nameInput.style.width = '320px'
  nameInput.style.marginBottom = '8px'
  nameInput.style.display = 'block'

  // ---- submit + status --------------------------------------------------
  const submitBtn = document.createElement('button')
  submitBtn.textContent = 'Create'
  submitBtn.style.marginTop = '8px'

  const result = document.createElement('div')
  result.className = 'result'
  result.textContent = '(not yet submitted)'

  // Optional details container (used for guided-mode "see what was
  // judged" expander + 403 grant-link + countdowns).
  const extraDetails = document.createElement('div')
  extraDetails.className = 'result'

  // ---- internal state ---------------------------------------------------
  let mode: Mode = 'freeform'
  let inFlightConcurrentBlock = false
  let cooldownTimer: ReturnType<typeof setInterval> | null = null

  function setMode(next: Mode): void {
    mode = next
    if (mode === 'freeform') {
      freeformWrap.style.display = 'block'
      guidedWrap.style.display = 'none'
    } else {
      freeformWrap.style.display = 'none'
      guidedWrap.style.display = 'block'
    }
  }

  modeFreeformRadio.addEventListener('change', () => {
    if (modeFreeformRadio.checked) setMode('freeform')
  })
  modeGuidedRadio.addEventListener('change', () => {
    if (modeGuidedRadio.checked) setMode('guided')
  })

  function clearCooldown(): void {
    if (cooldownTimer !== null) {
      clearInterval(cooldownTimer)
      cooldownTimer = null
    }
  }

  function startCooldown(seconds: number, code: string): void {
    clearCooldown()
    let remaining = seconds
    const render = (): void => {
      extraDetails.textContent =
        remaining > 0
          ? `${code}: retry in ${String(remaining)}s`
          : `${code}: retry now (cooldown elapsed)`
    }
    render()
    cooldownTimer = setInterval(() => {
      remaining -= 1
      if (remaining <= 0) {
        clearCooldown()
      }
      render()
    }, 1000)
  }

  function buildBody(): Record<string, unknown> | null {
    const name = nameInput.value.trim()
    if (name.length === 0) {
      result.textContent = 'name is required'
      return null
    }
    if (mode === 'freeform') {
      const concept = conceptTextarea.value.trim()
      return {
        name,
        world: {
          kind: 'new',
          source: { mode: 'freeform', concept },
        },
      }
    }
    const picks = titleInputs.map((titleEl, i) => ({
      title: titleEl.value.trim(),
      // whyInputs is the matching parallel array; length is the same
      // by construction (the for-loop above pushes both per row).
      whyILikeIt: (whyInputs[i]?.value ?? '').trim(),
    }))
    return {
      name,
      world: {
        kind: 'new',
        source: { mode: 'guided', picks },
      },
    }
  }

  function renderConceptRejected(body: ConceptRejectedBody, submittedMode: Mode): void {
    // CRITICAL XSS NOTE: rejectionMessage is Sonnet-authored and may
    // contain attacker-influenced strings. ALWAYS use textContent here.
    const msg = body.rejectionMessage ?? '(no message returned by gate)'
    result.textContent = `concept_rejected (${body.reason}): ${msg}`
    extraDetails.replaceChildren()
    if (submittedMode === 'guided' && typeof body.synthesizedConcept === 'string') {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = 'see what was judged (synthesized concept)'
      const pre = document.createElement('pre')
      pre.style.whiteSpace = 'pre-wrap'
      pre.style.margin = '8px 0 0 0'
      // Same XSS rule applies — synthesizedConcept is LLM output.
      pre.textContent = body.synthesizedConcept
      details.appendChild(summary)
      details.appendChild(pre)
      extraDetails.appendChild(details)
    }
  }

  function renderInsufficientCredits(): void {
    result.textContent = '403 insufficient_credits (creditType: world_gen)'
    extraDetails.replaceChildren()
    const grantLink = document.createElement('button')
    grantLink.textContent = 'Open credit-ledger panel'
    grantLink.style.fontFamily = 'var(--mono)'
    grantLink.style.fontSize = '12px'
    grantLink.addEventListener('click', () => {
      window.dispatchEvent(new CustomEvent(SCROLL_TO_GRANT_EVENT))
    })
    extraDetails.appendChild(grantLink)
  }

  function renderConcurrentGen(): void {
    result.textContent = '409 concurrent_generation_in_progress'
    extraDetails.textContent =
      'a world-gen for this user is already running; submit re-enables when it settles'
    inFlightConcurrentBlock = true
    submitBtn.disabled = true
  }

  function parseRetryAfter(body: unknown, fallback: number): number {
    // ApiResponse doesn't expose headers (the wrapper text-decodes and
    // discards the Response object). Fall back to the documented per-
    // route defaults from spec — the rejection-storm window is the
    // configured window length (15 min), queue_full is 60s. Both are
    // worst-case overestimates; user can hit Create earlier without harm.
    return readRetryAfterSeconds(body) ?? fallback
  }

  async function submit(): Promise<void> {
    if (inFlightConcurrentBlock) return
    clearCooldown()
    extraDetails.replaceChildren()
    const body = buildBody()
    if (body === null) return

    submitBtn.disabled = true
    result.textContent = 'submitting...'
    const submittedMode = mode

    const res = await apiCall('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (res.status === 201) {
      const success = readCreateSuccess(res.body)
      if (success !== null) {
        result.textContent = `201 created — campaignId: ${success.campaignId}`
        // Dispatch to the status-panel; it will populate its input and
        // begin watching the SSE stream.
        window.dispatchEvent(
          new CustomEvent<string>(WATCH_CAMPAIGN_EVENT, { detail: success.campaignId }),
        )
        submitBtn.disabled = false
        return
      }
    }

    const code = readCode(res.body) ?? '(no code)'

    if (res.status === 422 && code === 'concept_rejected') {
      const rejected = readConceptRejected(res.body)
      if (rejected !== null) {
        renderConceptRejected(rejected, submittedMode)
      } else {
        result.textContent = '422 concept_rejected (malformed body)'
      }
    } else if (res.status === 403 && code === 'insufficient_credits') {
      renderInsufficientCredits()
    } else if (res.status === 409 && code === 'concurrent_generation_in_progress') {
      renderConcurrentGen()
      return
    } else if (res.status === 429 && code === 'rejection_storm_cooldown') {
      result.textContent = `429 ${code}`
      startCooldown(parseRetryAfter(res.body, 15 * 60), code)
    } else if (res.status === 503 && code === 'queue_full') {
      result.textContent = `503 ${code}`
      startCooldown(parseRetryAfter(res.body, 60), code)
    } else if (res.status === 400) {
      // Zod body errors — render as JSON for the dev's debugging.
      result.textContent = `400 invalid_body: ${JSON.stringify(res.body, null, 2)}`
    } else {
      result.textContent = `unexpected ${String(res.status)} (${code})${
        res.error !== undefined ? ` — ${res.error}` : ''
      }`
    }

    submitBtn.disabled = false
  }

  submitBtn.addEventListener('click', () => {
    void submit()
  })

  // External clear hook (identity switch). Resets the form + closes any
  // pending cooldown timer + clears extra-details. Does NOT toggle mode
  // (user's choice persists across identity switches by design).
  window.addEventListener('mythrun.createpanel.clear', () => {
    nameInput.value = ''
    conceptTextarea.value = ''
    for (const t of titleInputs) t.value = ''
    for (const w of whyInputs) w.value = ''
    result.textContent = '(not yet submitted)'
    extraDetails.replaceChildren()
    clearCooldown()
    inFlightConcurrentBlock = false
    submitBtn.disabled = false
  })

  card.appendChild(title)
  card.appendChild(modeToggle.row)
  card.appendChild(nameInput)
  card.appendChild(freeformWrap)
  card.appendChild(guidedWrap)
  card.appendChild(submitBtn)
  card.appendChild(result)
  card.appendChild(extraDetails)
  parent.appendChild(card)
}
