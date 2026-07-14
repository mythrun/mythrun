// MYT-51 T13 — campaign-create panel controller.
//
// The stateful behavior behind the create panel: mode switching, the
// synthesize-preview → commit submit pipeline, the discriminated-`code`
// error UX, and the private SSE subscription that drives terminal-failure
// + transient-retry surfaces. Split out of campaign-create-panel.ts
// (myth-qtw77); the mount entry owns element wiring, this owns behavior.
//
// State + DOM are threaded through an explicit `CreatePanelCtx` (a
// readonly ref to the mutable `state` object + the `dom` struct) so every
// handler stays a module-level function rather than a nested closure.
//
// XSS: every server-returned string field goes through textContent —
// never innerHTML. rejectionMessage / synthesizedConcept are Sonnet-
// authored and adversarially-influenced by user input (Roc-C2).

import { apiCall, type ApiResponse } from '../api-client.js'
import { setActiveCampaignId } from '../shell/active-campaign.js'
import { openSse, type SseConnection } from '../sse-client.js'
import type { CreatePanelDom } from './campaign-create-dom.js'
import type { Mode } from './campaign-create-fields.js'
import { renderTerminalFailure } from './campaign-create-failure.js'
import {
  readCode,
  readConceptRejected,
  readCreateSuccess,
  readPreviewId,
  readRetryAfterSeconds,
  readStageCompleted,
  readStageFailed,
  readStageStarted,
  type ConceptRejectedBody,
  type CreateSuccess,
} from './campaign-create-wire.js'

// The credit-ledger panel listens on this event for the "scroll to grant
// button" link in the 403 branch.
export const SCROLL_TO_GRANT_EVENT = 'mythrun.scrolltogrant'

type CardState = 'ready' | 'submitting' | 'submitted' | 'failed_terminal' | 'failed_retrying'

export interface CreatePanelState {
  mode: Mode
  inFlightConcurrentBlock: boolean
  cooldownTimer: ReturnType<typeof setInterval> | null
  // SSE connection for the just-created campaign. Closed and replaced on
  // every submit, and closed when the pipeline reaches coherence_pass
  // stage-completed. (Identity-switch unmounts the panel via the shell's
  // identity-bridge, which calls our unmount → disposeController.)
  sseConn: SseConnection | null
}

export interface CreatePanelCtx {
  readonly dom: CreatePanelDom
  readonly state: CreatePanelState
}

export function createInitialState(): CreatePanelState {
  return { mode: 'freeform', inFlightConcurrentBlock: false, cooldownTimer: null, sseConn: null }
}

function closeSse(ctx: CreatePanelCtx): void {
  if (ctx.state.sseConn !== null) {
    ctx.state.sseConn.close()
    ctx.state.sseConn = null
  }
}

function setCardState(ctx: CreatePanelCtx, state: CardState): void {
  ctx.dom.card.setAttribute('data-state', state)
}

function clearFailureSurfaces(ctx: CreatePanelCtx): void {
  const { failureCard, retryBadge } = ctx.dom
  failureCard.style.display = 'none'
  failureCard.replaceChildren()
  retryBadge.style.display = 'none'
  retryBadge.textContent = ''
}

export function setMode(ctx: CreatePanelCtx, next: Mode): void {
  ctx.state.mode = next
  if (next === 'freeform') {
    ctx.dom.freeformWrap.style.display = 'block'
    ctx.dom.guidedWrap.style.display = 'none'
  } else {
    ctx.dom.freeformWrap.style.display = 'none'
    ctx.dom.guidedWrap.style.display = 'block'
  }
}

function clearCooldown(ctx: CreatePanelCtx): void {
  if (ctx.state.cooldownTimer !== null) {
    clearInterval(ctx.state.cooldownTimer)
    ctx.state.cooldownTimer = null
  }
}

function startCooldown(ctx: CreatePanelCtx, seconds: number, code: string): void {
  clearCooldown(ctx)
  let remaining = seconds
  const render = (): void => {
    ctx.dom.extraDetails.textContent =
      remaining > 0
        ? `${code}: retry in ${String(remaining)}s`
        : `${code}: retry now (cooldown elapsed)`
  }
  render()
  ctx.state.cooldownTimer = setInterval(() => {
    remaining -= 1
    if (remaining <= 0) {
      clearCooldown(ctx)
    }
    render()
  }, 1000)
}

// Guided picks → the synthesize-preview body. MYT-89 A5: guided create posts
// these to POST /api/campaigns/synthesize-preview (not /api/campaigns), which
// synthesizes + gates and returns a previewId we then commit.
function buildPicks(ctx: CreatePanelCtx): { title: string; whyILikeIt: string }[] {
  const { titleInputs, whyInputs } = ctx.dom
  return titleInputs.map((titleEl, i) => ({
    title: titleEl.value.trim(),
    // whyInputs is the matching parallel array; length is the same by
    // construction (the for-loop above pushes both per row).
    whyILikeIt: (whyInputs[i]?.value ?? '').trim(),
  }))
}

// The POST /api/campaigns commit body. Freeform commits the concept directly;
// guided commits the opaque previewId returned by synthesize-preview.
// myth-4lhr: no name in the body — concept_intake auto-names.
function buildCommitBody(
  ctx: CreatePanelCtx,
  committedMode: Mode,
  previewId: string,
): Record<string, unknown> {
  const source: Record<string, unknown> =
    committedMode === 'freeform'
      ? { mode: 'freeform', concept: ctx.dom.conceptTextarea.value.trim() }
      : { mode: 'guided', previewId }
  const body: Record<string, unknown> = { world: { kind: 'new', source } }
  // myth-exac T22: dev-only flag to surface secret-tier facts.
  if (ctx.dom.bypassCheckbox.checked) {
    body.devBypassAccessFilter = true
  }
  return body
}

function renderConceptRejected(
  ctx: CreatePanelCtx,
  body: ConceptRejectedBody,
  submittedMode: Mode,
): void {
  const { result, extraDetails } = ctx.dom
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

function renderInsufficientCredits(ctx: CreatePanelCtx): void {
  const { result, extraDetails } = ctx.dom
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

function renderConcurrentGen(ctx: CreatePanelCtx): void {
  ctx.dom.result.textContent = '409 concurrent_generation_in_progress'
  ctx.dom.extraDetails.textContent =
    'a world-gen for this user is already running; submit re-enables when it settles'
  ctx.state.inFlightConcurrentBlock = true
  ctx.dom.submitBtn.disabled = true
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
function subscribeToStream(ctx: CreatePanelCtx, campaignId: string): void {
  const { card, retryBadge, submitBtn } = ctx.dom
  closeSse(ctx)
  ctx.state.sseConn = openSse(`/api/campaigns/${campaignId}/status/stream`, {
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
          setCardState(ctx, 'failed_retrying')
          retryBadge.textContent = `stage ${failed.stage} hit a transient error (${failed.errorCode}); retrying...`
          retryBadge.style.display = 'block'
        } else {
          // Terminal — render the prominent card; keep the form
          // populated so the user can edit and resubmit.
          setCardState(ctx, 'failed_terminal')
          retryBadge.style.display = 'none'
          retryBadge.textContent = ''
          renderTerminalFailure(ctx.dom.failureCard, failed)
          submitBtn.disabled = false
          // Terminal failure means the pipeline is done; nothing more
          // to watch on this campaignId.
          closeSse(ctx)
        }
        return
      }
      const started = readStageStarted(parsed)
      if (started !== null) {
        // Any new stage-started clears a transient retry banner.
        if (card.getAttribute('data-state') === 'failed_retrying') {
          setCardState(ctx, 'submitted')
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
          closeSse(ctx)
        }
      }
    },
    onError: () => {
      // Silent on connection errors — the status-panel surfaces them.
      // We just stop listening; the user can resubmit.
      closeSse(ctx)
    },
  })
}

// The 201-created success surface: campaignId line + "Watch progress →"
// affordance, make it the shell's active campaign, open a private SSE sub.
function renderCreateSuccess(ctx: CreatePanelCtx, success: CreateSuccess): void {
  const { result, submitBtn } = ctx.dom
  result.replaceChildren()
  const line = document.createElement('div')
  line.textContent = `201 created — campaignId: ${success.campaignId}`
  result.appendChild(line)
  // myth-0smu: surface a "Watch progress →" affordance that navigates the
  // shell to the World workflow (status + snapshot + hierarchy + tables).
  const watch = document.createElement('button')
  watch.textContent = 'Watch progress →'
  watch.style.marginTop = '6px'
  watch.addEventListener('click', () => {
    window.dispatchEvent(
      new CustomEvent<{ workflowId: string }>('mythrun.navigate-workflow', {
        detail: { workflowId: 'world' },
      }),
    )
  })
  result.appendChild(watch)
  // Make the new campaign the shell's active one — the drawer + other panels
  // react via onActiveCampaignChanged.
  setActiveCampaignId(success.campaignId)
  // Also subscribe privately so this panel can react to stage-failed events
  // directly (separate consumer/lifecycle from the drawer's connection).
  subscribeToStream(ctx, success.campaignId)
  setCardState(ctx, 'submitted')
  submitBtn.disabled = false
}

// Steer the non-201 error UX off the discriminated `code`. Shared by BOTH
// guided steps (synthesize-preview and the commit) since they speak the same
// code vocabulary. Leaves the panel back at 'ready' so the user can edit and
// retry — except concurrent-gen, which owns its own disabled state and
// returns early.
function renderApiError(ctx: CreatePanelCtx, res: ApiResponse<unknown>, submittedMode: Mode): void {
  const { result, submitBtn } = ctx.dom
  const code = readCode(res.body) ?? '(no code)'

  if (res.status === 422 && code === 'concept_rejected') {
    const rejected = readConceptRejected(res.body)
    if (rejected !== null) {
      renderConceptRejected(ctx, rejected, submittedMode)
    } else {
      result.textContent = '422 concept_rejected (malformed body)'
    }
  } else if (res.status === 403 && code === 'insufficient_credits') {
    renderInsufficientCredits(ctx)
  } else if (res.status === 409 && code === 'concurrent_generation_in_progress') {
    renderConcurrentGen(ctx)
    return
  } else if (res.status === 429 && code === 'rejection_storm_cooldown') {
    result.textContent = `429 ${code}`
    startCooldown(ctx, parseRetryAfter(res.body, 15 * 60), code)
  } else if (res.status === 503 && code === 'queue_full') {
    result.textContent = `503 ${code}`
    startCooldown(ctx, parseRetryAfter(res.body, 60), code)
  } else if (res.status === 410 && code === 'preview_expired') {
    // MYT-89 A5: the guided preview lapsed between synthesize-preview and the
    // commit (30-min TTL). Prompt a re-synthesize.
    result.textContent =
      '410 preview_expired — the synthesized preview expired; synthesize again'
  } else if (res.status === 400) {
    // Zod body errors — render as JSON for the dev's debugging.
    result.textContent = `400 invalid_body: ${JSON.stringify(res.body, null, 2)}`
  } else {
    result.textContent = `unexpected ${String(res.status)} (${code})${
      res.error !== undefined ? ` — ${res.error}` : ''
    }`
  }

  setCardState(ctx, 'ready')
  submitBtn.disabled = false
}

// MYT-89 A5: guided commits an ALREADY-GATED preview. Synthesize-preview
// first (Sonnet synth + input gate, non-charging) to mint a previewId; any
// non-201 there renders with the shared error UX and bails. Freeform skips
// this and commits its concept directly. Returns the previewId ('' for
// freeform), or null if the preview step already rendered an error + bailed.
async function synthesizePreviewIfGuided(
  ctx: CreatePanelCtx,
  submittedMode: Mode,
): Promise<string | null> {
  if (submittedMode !== 'guided') return ''
  ctx.dom.result.textContent = 'synthesizing preview...'
  const previewRes = await apiCall('/api/campaigns/synthesize-preview', {
    method: 'POST',
    body: JSON.stringify({ picks: buildPicks(ctx) }),
  })
  const id = readPreviewId(previewRes.body)
  if (id === null) {
    renderApiError(ctx, previewRes, submittedMode)
    return null
  }
  ctx.dom.result.textContent = 'committing...'
  return id
}

export async function submitCreate(ctx: CreatePanelCtx): Promise<void> {
  if (ctx.state.inFlightConcurrentBlock) return
  clearCooldown(ctx)
  ctx.dom.extraDetails.replaceChildren()
  // A fresh submit clears any prior failure surface and tears down
  // any prior SSE subscription (we'll open a new one on 201).
  closeSse(ctx)
  clearFailureSurfaces(ctx)

  ctx.dom.submitBtn.disabled = true
  ctx.dom.result.textContent = 'submitting...'
  setCardState(ctx, 'submitting')
  const submittedMode = ctx.state.mode

  const previewId = await synthesizePreviewIfGuided(ctx, submittedMode)
  if (previewId === null) return

  const res = await apiCall('/api/campaigns', {
    method: 'POST',
    body: JSON.stringify(buildCommitBody(ctx, submittedMode, previewId)),
  })

  if (res.status === 201) {
    const success = readCreateSuccess(res.body)
    if (success !== null) {
      renderCreateSuccess(ctx, success)
      return
    }
  }

  renderApiError(ctx, res, submittedMode)
}

export function disposeController(ctx: CreatePanelCtx): void {
  closeSse(ctx)
  clearCooldown(ctx)
}
