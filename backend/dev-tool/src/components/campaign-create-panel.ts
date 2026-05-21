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
//   201                                       → set the new campaignId as
//                                                 the shell's active campaign
//                                                 so the drawer + other panels
//                                                 pick it up
//
// XSS: `rejectionMessage` is Sonnet-authored and adversarially-influenced
// by user input (Roc-C2). It is written via `el.textContent` ONLY, never
// `innerHTML` — same rule applies to every server-returned string field
// in this panel.

import { apiCall } from '../api-client.js'
import { setActiveCampaignId } from '../shell/active-campaign.js'
import { openSse, type SseConnection } from '../sse-client.js'
import { registerPanelMount } from '../shell/shell.js'
import type { PanelHandle } from './_shared/panel-skeleton.js'

// The credit-ledger panel listens on this event for the "scroll to grant
// button" link in the 403 branch.
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

// Mirror of PipelineStageDiagnostic from
// backend/src/contract/pipeline-events.ts — kept structural to avoid
// pulling backend types into the dev-tool bundle (the dev-tool ships as
// its own Vite app per AUTHORING.md). Wire-format-only.
export interface StageDiagnostic {
  readonly callSite: string
  readonly schemaName: string
  readonly modelId: string
  readonly repairStrategy: string
  readonly repairAttempted: boolean
  readonly repairOutcome: string
  readonly rawTextSnippet: string | null
  readonly zodIssues: readonly { readonly path: string; readonly message: string }[] | null
}

export interface StageFailedEvent {
  readonly type: 'stage-failed'
  readonly stage: string
  readonly errorCode: string
  readonly willRetry: boolean
  readonly diagnostic: StageDiagnostic | null
}

interface StageStartedEvent {
  readonly type: 'stage-started'
  readonly stage: string
}

interface StageCompletedEvent {
  readonly type: 'stage-completed'
  readonly stage: string
}

function readZodIssues(
  value: unknown,
): readonly { readonly path: string; readonly message: string }[] | null {
  if (!Array.isArray(value)) return null
  const out: { path: string; message: string }[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const path = entry.path
    const message = entry.message
    if (typeof path === 'string' && typeof message === 'string') {
      out.push({ path, message })
    }
  }
  return out.length > 0 ? out : null
}

function readDiagnostic(value: unknown): StageDiagnostic | null {
  if (!isObject(value)) return null
  const callSite = value.callSite
  const schemaName = value.schemaName
  const modelId = value.modelId
  const repairStrategy = value.repairStrategy
  const repairAttempted = value.repairAttempted
  const repairOutcome = value.repairOutcome
  const rawTextSnippet = value.rawTextSnippet
  if (
    typeof callSite !== 'string' ||
    typeof schemaName !== 'string' ||
    typeof modelId !== 'string' ||
    typeof repairStrategy !== 'string' ||
    typeof repairAttempted !== 'boolean' ||
    typeof repairOutcome !== 'string'
  ) {
    return null
  }
  return {
    callSite,
    schemaName,
    modelId,
    repairStrategy,
    repairAttempted,
    repairOutcome,
    rawTextSnippet: typeof rawTextSnippet === 'string' ? rawTextSnippet : null,
    zodIssues: readZodIssues(value.zodIssues),
  }
}

export function readStageFailed(value: unknown): StageFailedEvent | null {
  if (!isObject(value)) return null
  if (value.type !== 'stage-failed') return null
  const stage = value.stage
  const errorCode = value.errorCode
  const willRetry = value.willRetry
  if (typeof stage !== 'string' || typeof errorCode !== 'string' || typeof willRetry !== 'boolean') {
    return null
  }
  return {
    type: 'stage-failed',
    stage,
    errorCode,
    willRetry,
    diagnostic: readDiagnostic(value.diagnostic),
  }
}

function readStageStarted(value: unknown): StageStartedEvent | null {
  if (!isObject(value)) return null
  if (value.type !== 'stage-started') return null
  const stage = value.stage
  return typeof stage === 'string' ? { type: 'stage-started', stage } : null
}

function readStageCompleted(value: unknown): StageCompletedEvent | null {
  if (!isObject(value)) return null
  if (value.type !== 'stage-completed') return null
  const stage = value.stage
  return typeof stage === 'string' ? { type: 'stage-completed', stage } : null
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

// Best-effort parse of the paint-job rawTextSnippet (the last judgement
// payload). Returns the parsed object only if it has the expected
// shape, null otherwise. Never throws.
interface PaintJobJudgement {
  readonly mirroredWork?: unknown
  readonly specificDriftAxes?: unknown
}

function tryParseJudgement(snippet: string): PaintJobJudgement | null {
  try {
    const parsed: unknown = JSON.parse(snippet)
    if (!isObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

// Maps errorCode → human-readable headline. Dev-tool only — the
// production frontend will own its own wording.
export function buildHeadline(ev: StageFailedEvent): string {
  switch (ev.errorCode) {
    case 'concept_intake_paint_job_loop_exhausted':
      return 'Your concept appears to mirror an existing copyrighted work. Try describing your world in your own terms.'
    case 'llm_content_filtered':
      return "Anthropic's content filter rejected this concept. Rephrase to avoid graphic violence, hate, or other policy-flagged content."
    case 'llm_structured_output_failed':
      return "Couldn't generate a world from this concept after multiple retries. Try adding more detail (setting, conflict, tone) or rephrasing for clarity."
    case 'llm_auth_failed':
      return 'LLM auth failed (operator). Check Anthropic API key wiring.'
    case 'llm_invalid_request':
      return 'LLM invalid_request (operator). Likely a prompt-construction bug.'
    case 'llm_context_too_long':
      return 'LLM context too long (operator). The prompt + history exceeded the model window.'
    default: {
      const repair = ev.diagnostic?.repairOutcome
      return repair !== undefined
        ? `Stage failed: ${ev.errorCode} (repair: ${repair})`
        : `Stage failed: ${ev.errorCode}`
    }
  }
}

export function mountCampaignCreatePanel(parent: HTMLElement): PanelHandle {
  const card = document.createElement('section')
  card.className = 'card'
  // Action-only panel: the form is the steady state. data-state="ready"
  // tells the verify harness the panel reached its expected post-mount
  // state without conflating with fetch-on-mount panels.
  card.setAttribute('data-state', 'ready')

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

  // ---- auto-name notice ------------------------------------------------
  // myth-4lhr: campaign + world names are auto-generated by concept_intake
  // from the LLM-synthesized world.name. No name input here; the user
  // renames later via the campaign-details panel.
  const autoNameNote = document.createElement('div')
  autoNameNote.textContent =
    'Campaign name is auto-generated during concept_intake. Rename later from the campaign-details panel.'
  autoNameNote.style.fontSize = '12px'
  autoNameNote.style.color = '#888'
  autoNameNote.style.marginBottom = '8px'

  // ---- dev bypass (myth-exac T22) --------------------------------------
  // When checked, the POST body includes `devBypassAccessFilter: true`,
  // which surfaces secret-tier facts in the SSE stream + snapshot so the
  // dev can inspect what's normally hidden from the player. Default off.
  const bypassRow = document.createElement('div')
  bypassRow.style.display = 'flex'
  bypassRow.style.alignItems = 'center'
  bypassRow.style.gap = '6px'
  bypassRow.style.marginTop = '8px'
  const bypassCheckbox = document.createElement('input')
  bypassCheckbox.type = 'checkbox'
  bypassCheckbox.id = 'dev-bypass-access-filter'
  const bypassLabel = document.createElement('label')
  bypassLabel.setAttribute('for', 'dev-bypass-access-filter')
  bypassLabel.textContent =
    'Bypass access tiers (dev mode — see secrets in stream + snapshot)'
  bypassLabel.style.fontSize = '12px'
  bypassRow.appendChild(bypassCheckbox)
  bypassRow.appendChild(bypassLabel)

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

  // ---- terminal-failure surface (myth-yfxf) ---------------------------
  // Hidden until a stage-failed{willRetry:false} arrives. Replaces no
  // existing element; appended to the card after extraDetails so the
  // form + result remain visible (user edits + resubmits).
  const failureCard = document.createElement('div')
  failureCard.className = 'result'
  failureCard.style.display = 'none'
  failureCard.style.border = '1px solid #c33'
  failureCard.style.background = 'rgba(204, 51, 51, 0.08)'
  failureCard.style.padding = '8px'
  failureCard.style.marginTop = '8px'

  // Transient-retry badge. Tiny, non-scary, appears near `result` while
  // BullMQ is mid-retry. Clears on next stage-started or final success.
  const retryBadge = document.createElement('div')
  retryBadge.className = 'result'
  retryBadge.style.display = 'none'
  retryBadge.style.fontSize = '12px'
  retryBadge.style.color = '#a60'
  retryBadge.style.marginTop = '4px'

  // ---- internal state ---------------------------------------------------
  let mode: Mode = 'freeform'
  let inFlightConcurrentBlock = false
  let cooldownTimer: ReturnType<typeof setInterval> | null = null
  // SSE connection for the just-created campaign. Closed and replaced on
  // every submit, and closed when the pipeline reaches coherence_pass
  // stage-completed. (Identity-switch unmounts the panel via the shell's
  // identity-bridge, which calls our unmount → closeSse.)
  let sseConn: SseConnection | null = null

  function closeSse(): void {
    if (sseConn !== null) {
      sseConn.close()
      sseConn = null
    }
  }

  function setState(state: 'ready' | 'submitting' | 'submitted' | 'failed_terminal' | 'failed_retrying'): void {
    card.setAttribute('data-state', state)
  }

  function clearFailureSurfaces(): void {
    failureCard.style.display = 'none'
    failureCard.replaceChildren()
    retryBadge.style.display = 'none'
    retryBadge.textContent = ''
  }

  // Build the prominent red error card. ALL server-returned strings go
  // through textContent — never innerHTML — because errorCode comes from
  // the wire, diagnostic.rawTextSnippet is LLM output (potentially
  // adversarially-influenced), and zodIssues paths are model-driven too.
  function renderTerminalFailure(ev: StageFailedEvent): void {
    failureCard.replaceChildren()

    const stageLine = document.createElement('div')
    stageLine.style.fontWeight = 'bold'
    stageLine.style.marginBottom = '4px'
    stageLine.textContent = `stage failed: ${ev.stage}`
    failureCard.appendChild(stageLine)

    const headline = document.createElement('div')
    headline.style.marginBottom = '6px'
    headline.textContent = buildHeadline(ev)
    failureCard.appendChild(headline)

    // Paint-job-loop: try parsing diagnostic.rawTextSnippet as JSON to
    // pull mirroredWork + specificDriftAxes. The snippet is the last
    // judgement payload when the paint-job loop exhausts — providing it
    // here is the cleanest debug surface in dev mode.
    if (
      ev.errorCode === 'concept_intake_paint_job_loop_exhausted' &&
      ev.diagnostic !== null &&
      ev.diagnostic.rawTextSnippet !== null
    ) {
      const judgement = tryParseJudgement(ev.diagnostic.rawTextSnippet)
      if (judgement !== null) {
        if (typeof judgement.mirroredWork === 'string' && judgement.mirroredWork.length > 0) {
          const m = document.createElement('div')
          m.style.fontSize = '12px'
          m.style.marginTop = '4px'
          m.textContent = `mirrored work: ${judgement.mirroredWork}`
          failureCard.appendChild(m)
        }
        if (Array.isArray(judgement.specificDriftAxes) && judgement.specificDriftAxes.length > 0) {
          const axesEl = document.createElement('div')
          axesEl.style.fontSize = '12px'
          axesEl.style.marginTop = '4px'
          const axes = judgement.specificDriftAxes
            .filter((a): a is string => typeof a === 'string')
            .join(', ')
          axesEl.textContent = `drift axes: ${axes}`
          failureCard.appendChild(axesEl)
        }
      }
    }

    if (ev.diagnostic !== null) {
      failureCard.appendChild(buildDiagnosticExpander(ev.diagnostic))
    }

    failureCard.style.display = 'block'
  }

  function buildDiagnosticExpander(diag: StageDiagnostic): HTMLElement {
    const details = document.createElement('details')
    details.style.marginTop = '6px'
    const summary = document.createElement('summary')
    summary.textContent = 'diagnostic'
    summary.style.cursor = 'pointer'
    summary.style.fontSize = '12px'
    details.appendChild(summary)

    const pre = document.createElement('pre')
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.margin = '8px 0 0 0'
    pre.style.fontSize = '11px'
    pre.style.fontFamily = 'var(--mono)'
    // Object-shape build (not template-string) keeps each field's value
    // an independent textContent assignment via JSON.stringify — there's
    // no innerHTML path here. Stringify is safe because the values
    // never contain HTML-execution context once they're in a <pre>.
    const dump = {
      callSite: diag.callSite,
      schemaName: diag.schemaName,
      modelId: diag.modelId,
      repairStrategy: diag.repairStrategy,
      repairAttempted: diag.repairAttempted,
      repairOutcome: diag.repairOutcome,
      rawTextSnippet: diag.rawTextSnippet,
      zodIssues: diag.zodIssues,
    }
    pre.textContent = JSON.stringify(dump, null, 2)
    details.appendChild(pre)
    return details
  }

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
    // myth-4lhr: no name in the body — concept_intake auto-names.
    const body: Record<string, unknown> =
      mode === 'freeform'
        ? {
            world: {
              kind: 'new',
              source: { mode: 'freeform', concept: conceptTextarea.value.trim() },
            },
          }
        : {
            world: {
              kind: 'new',
              source: {
                mode: 'guided',
                picks: titleInputs.map((titleEl, i) => ({
                  title: titleEl.value.trim(),
                  // whyInputs is the matching parallel array; length is the same
                  // by construction (the for-loop above pushes both per row).
                  whyILikeIt: (whyInputs[i]?.value ?? '').trim(),
                })),
              },
            },
          }
    // myth-exac T22: dev-only flag to surface secret-tier facts.
    if (bypassCheckbox.checked) {
      body.devBypassAccessFilter = true
    }
    return body
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

  // Open a private SSE subscription to the just-created campaign's status
  // stream. Distinct from the status-panel's connection (different
  // consumers, different lifecycle): this one only cares about
  // stage-failed (for terminal-failure UX) and stage-started /
  // stage-completed (to clear the transient retry badge + close the
  // stream on final coherence_pass success).
  function subscribeToStream(campaignId: string): void {
    closeSse()
    sseConn = openSse(`/api/campaigns/${campaignId}/status/stream`, {
      onEvent: (ev) => {
        if (ev.event !== 'message') return
        let parsed: unknown
        try {
          parsed = JSON.parse(ev.data)
        } catch {
          return
        }
        const failed = readStageFailed(parsed)
        if (failed !== null) {
          if (failed.willRetry) {
            // Transient — show a small retry badge but keep state
            // recoverable; BullMQ will issue another stage-started soon.
            setState('failed_retrying')
            retryBadge.textContent = `stage ${failed.stage} hit a transient error (${failed.errorCode}); retrying...`
            retryBadge.style.display = 'block'
          } else {
            // Terminal — render the prominent card; keep the form
            // populated so the user can edit and resubmit.
            setState('failed_terminal')
            retryBadge.style.display = 'none'
            retryBadge.textContent = ''
            renderTerminalFailure(failed)
            submitBtn.disabled = false
            // Terminal failure means the pipeline is done; nothing more
            // to watch on this campaignId.
            closeSse()
          }
          return
        }
        const started = readStageStarted(parsed)
        if (started !== null) {
          // Any new stage-started clears a transient retry banner.
          if (card.getAttribute('data-state') === 'failed_retrying') {
            setState('submitted')
            retryBadge.style.display = 'none'
            retryBadge.textContent = ''
          }
          return
        }
        const completed = readStageCompleted(parsed)
        if (completed !== null) {
          // coherence_pass is the final stage — world-gen success;
          // nothing more to watch on this connection.
          if (completed.stage === 'coherence_pass') {
            // Also clear any lingering transient banner.
            retryBadge.style.display = 'none'
            retryBadge.textContent = ''
            closeSse()
          }
        }
      },
      onError: () => {
        // Silent on connection errors — the status-panel surfaces them.
        // We just stop listening; the user can resubmit.
        closeSse()
      },
    })
  }

  async function submit(): Promise<void> {
    if (inFlightConcurrentBlock) return
    clearCooldown()
    extraDetails.replaceChildren()
    // A fresh submit clears any prior failure surface and tears down
    // any prior SSE subscription (we'll open a new one on 201).
    closeSse()
    clearFailureSurfaces()
    const body = buildBody()
    if (body === null) return

    submitBtn.disabled = true
    result.textContent = 'submitting...'
    setState('submitting')
    const submittedMode = mode

    const res = await apiCall('/api/campaigns', {
      method: 'POST',
      body: JSON.stringify(body),
    })

    if (res.status === 201) {
      const success = readCreateSuccess(res.body)
      if (success !== null) {
        result.textContent = `201 created — campaignId: ${success.campaignId}`
        // Make the new campaign the shell's active one — the drawer +
        // other panels react via onActiveCampaignChanged.
        setActiveCampaignId(success.campaignId)
        // Also subscribe privately so this panel can react to
        // stage-failed events directly (separate consumer, separate
        // lifecycle from the drawer's connection).
        subscribeToStream(success.campaignId)
        setState('submitted')
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

    // Any non-201 response leaves the panel back at 'ready' so the
    // user can edit and retry. (Concurrent-gen returned early above and
    // owns its own state — submit stays disabled until clear.)
    setState('ready')
    submitBtn.disabled = false
  }

  submitBtn.addEventListener('click', () => {
    void submit()
  })

  card.appendChild(title)
  card.appendChild(modeToggle.row)
  card.appendChild(autoNameNote)
  card.appendChild(freeformWrap)
  card.appendChild(guidedWrap)
  card.appendChild(bypassRow)
  card.appendChild(submitBtn)
  card.appendChild(retryBadge)
  card.appendChild(failureCard)
  card.appendChild(result)
  card.appendChild(extraDetails)
  parent.appendChild(card)

  return {
    root: card,
    unmount: () => {
      closeSse()
      clearCooldown()
      if (card.parentNode !== null) card.parentNode.removeChild(card)
    },
  }
}

registerPanelMount('POST', '/api/campaigns', mountCampaignCreatePanel)
