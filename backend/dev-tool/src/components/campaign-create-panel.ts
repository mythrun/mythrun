// MYT-51 T13 — campaign-create-panel.
//
// Mode toggle (freeform | guided) over a shared submit pipeline.
//
// Freeform commits its concept directly to POST /api/campaigns.
//
// Guided (MYT-89 A5) is now a TWO-STEP flow: the 3 picks ({title, whyILikeIt},
// spec D4) go to POST /api/campaigns/synthesize-preview (Sonnet synth + input
// gate, non-charging), which returns an opaque `previewId`; the panel then
// commits `{mode:'guided', previewId}` to POST /api/campaigns. This is the
// dev-tool's preview→commit E2E path. Synthesis + the gate no longer run on the
// create commit — so the guided 422 concept_rejected now surfaces from the
// synthesize-preview step, and the commit adds a 410 (preview expired) case.
//
// Both steps share the SAME discriminated `code` error vocabulary, so one
// renderer steers the UX regardless of which call returned the non-201:
//
//   400 invalid_body                          → field-level Zod hint
//   403 insufficient_credits                  → link to credit-grant
//   409 concurrent_generation_in_progress     → disable submit until clear
//   410 preview_expired (guided commit)       → prompt a re-synthesize
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
//
// myth-qtw77: this file is now the thin mount entry. The internals live in
// four cohesive siblings — campaign-create-wire (wire-format readers),
// campaign-create-fields (form scaffolding), campaign-create-dom (element
// assembly), campaign-create-failure (terminal-failure rendering), and
// campaign-create-controller (mode + submit pipeline + SSE + error UX).

import { registerPanelMount } from '../shell/shell.js'
import type { PanelHandle } from './_shared/panel-skeleton.js'
import { buildCreatePanelDom } from './campaign-create-dom.js'
import {
  createInitialState,
  disposeController,
  setMode,
  submitCreate,
  type CreatePanelCtx,
} from './campaign-create-controller.js'

// Public-surface re-exports. External importers (dev-credits-grant-panel,
// the unit test) and past call sites reference these via the panel module,
// so they stay re-exported from here even though the definitions moved.
export { SCROLL_TO_GRANT_EVENT } from './campaign-create-controller.js'
export { buildHeadline } from './campaign-create-failure.js'
export { readStageFailed, type StageFailedEvent } from './campaign-create-wire.js'

export function mountCampaignCreatePanel(parent: HTMLElement): PanelHandle {
  const dom = buildCreatePanelDom()
  const ctx: CreatePanelCtx = { dom, state: createInitialState() }

  const { freeformRadio, guidedRadio } = dom.modeToggle
  freeformRadio.addEventListener('change', () => {
    if (freeformRadio.checked) setMode(ctx, 'freeform')
  })
  guidedRadio.addEventListener('change', () => {
    if (guidedRadio.checked) setMode(ctx, 'guided')
  })
  dom.submitBtn.addEventListener('click', () => {
    void submitCreate(ctx)
  })

  parent.appendChild(dom.card)

  return {
    root: dom.card,
    unmount: () => {
      disposeController(ctx)
      if (dom.card.parentNode !== null) dom.card.parentNode.removeChild(dom.card)
    },
  }
}

registerPanelMount('POST', '/api/campaigns', mountCampaignCreatePanel)
