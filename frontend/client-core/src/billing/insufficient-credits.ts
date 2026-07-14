// The session-start 402 seam MYT-92 consumes. When a live session-start fails on
// the campaign OWNER's session-credit shortfall (regardless of who clicked Start),
// the route emits `{ code:'insufficient_credits', available, required }`. MYT-95
// unit-tests against this mocked shape and exports the guard + the prompt-model
// builder; MYT-92 wires and E2E-verifies the LIVE arm at the 92-merge point (spec
// §4 coupling note). The contract here is normative — 92's classifier is built
// against these exact types, so keep the guard total.

/** The 402 body the session-start route emits on the OWNER's session shortfall. */
export interface InsufficientCreditsError {
  readonly code: 'insufficient_credits'
  readonly available: number
  readonly required: number
}

/** Structural guard for the 402 body. Total over `unknown` — a wrong code, a
 *  missing/non-number field, null, or a non-object are all rejected. */
export function isInsufficientCredits(body: unknown): body is InsufficientCreditsError {
  if (typeof body !== 'object' || body === null) return false
  const b = body as { code?: unknown; available?: unknown; required?: unknown }
  return (
    b.code === 'insufficient_credits' &&
    typeof b.available === 'number' &&
    typeof b.required === 'number'
  )
}

/** The model the PurchasePrompt renders. `viewerIsOwner` is decided by the caller
 *  (MYT-92's play route) from campaign ownership: NON-owners get a calm notice with
 *  NO buy CTA — buying would credit the wrong ledger and not fix the session. */
export interface PurchasePromptModel {
  readonly variant: 'owner' | 'nonOwner'
  readonly available: number
  readonly required: number
}

export function purchasePromptModel(
  err: InsufficientCreditsError,
  viewerIsOwner: boolean,
): PurchasePromptModel {
  return {
    variant: viewerIsOwner ? 'owner' : 'nonOwner',
    available: err.available,
    required: err.required,
  }
}
