// MYT-51 T13 — campaign-create terminal-failure rendering.
//
// Builds the prominent red error card shown when a stage-failed
// {willRetry:false} arrives on the status stream. Split out of
// campaign-create-panel.ts (myth-qtw77). The controller passes in the
// (closure-owned) failureCard element; everything here is otherwise pure
// given a StageFailedEvent.
//
// XSS: ALL server-returned strings go through textContent — never
// innerHTML — because errorCode comes from the wire, diagnostic
// .rawTextSnippet is LLM output (potentially adversarially-influenced),
// and zodIssues paths are model-driven too.

import {
  tryParseJudgement,
  type StageDiagnostic,
  type StageFailedEvent,
} from './campaign-create-wire.js'

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

// Append the paint-job-loop debug fields (mirroredWork + specificDriftAxes)
// parsed from diagnostic.rawTextSnippet — the last judgement payload when
// the paint-job loop exhausts. Providing it here is the cleanest debug
// surface in dev mode.
function appendPaintJobDetails(failureCard: HTMLElement, ev: StageFailedEvent): void {
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
}

export function renderTerminalFailure(failureCard: HTMLElement, ev: StageFailedEvent): void {
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

  appendPaintJobDetails(failureCard, ev)

  if (ev.diagnostic !== null) {
    failureCard.appendChild(buildDiagnosticExpander(ev.diagnostic))
  }

  failureCard.style.display = 'block'
}
