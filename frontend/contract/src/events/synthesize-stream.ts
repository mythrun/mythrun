// The one-shot SSE event union for the STREAMED guided synthesis
// (POST /api/campaigns/synthesize-preview/stream, myth-umggn). The guided
// create flow streams the world brief live instead of making the player wait
// for the whole synthesis; each frame is a `data: {json}` SSE frame whose
// payload is one of these arms (same framing as the pipeline status stream —
// a `type`-discriminated wire union the client trusts; no runtime schema).
//
// Lifecycle (exactly one terminal arm per stream, then the server closes):
//   delta*  → (complete | rejected | error)
//
// Pre-stream failures are NOT events: the route's guard chain (body 400,
// rate-limit 429, rejection-storm 429, credit peek 403) rejects with a plain
// JSON status BEFORE the response is ever hijacked into SSE, so the client
// treats a non-200 open exactly like the non-streaming endpoint's errors.
//
// `rejected` mirrors the non-streaming 422 `concept_rejected` payload
// byte-for-byte (reason / rejectionMessage / synthesizedConcept) — the text
// the player watched arrive resolves into the SAME rejection state the
// synchronous route produces. `synthesizedConcept` is always present: every
// rejection on this stream lands on the rejection SCREEN, which has nothing
// but this frame to render the judged text and seed "adjust it yourself".
//
// myth-6t06f: the stream serves BOTH funnel paths. A brainstorm body carries 3
// picks and the judged text is the synthesis; a freeform body carries the
// player's own concept and the judged text is their own words (gated before the
// synthesis runs). The frames are identical either way — the screens that
// render them never branch on which path opened the stream.

import type { GateReason } from '../rest/campaign-create.js'

/** Terminal error codes a stream can end with. `content_filtered` mirrors the
 *  non-streaming route's 422 (terminal — the same prompt re-hits the same
 *  filter); `llm_upstream_unavailable` mirrors its 503 (transient — worth a
 *  retry); `internal_error` is the honest catch-all for a non-LLM failure
 *  after the stream opened (e.g. the preview store write). */
export type SynthesizeStreamErrorCode =
  | 'content_filtered'
  | 'llm_upstream_unavailable'
  | 'internal_error'

/** One frame of the streamed synthesis. */
export type SynthesizeStreamEvent =
  /** A chunk of the brief's prose, in arrival order. Concatenating every
   *  `text` yields the concept as streamed (the terminal `complete.concept`
   *  is authoritative — a post-stream schema repair can diverge from it). */
  | { readonly type: 'delta'; readonly text: string }
  /** The gate passed and the concept is parked: same payload as the
   *  non-streaming 201. The rework/commit flows proceed unchanged. `title` is
   *  the world's name (myth-z3icr) — the proposal page headlines it instead of
   *  leaving it buried in the first words of the prose. */
  | {
      readonly type: 'complete'
      readonly previewId: string
      readonly title: string
      readonly concept: string
    }
  /** The input gate rejected the synthesized concept: same payload as the
   *  non-streaming 422 `concept_rejected` (guided mode). */
  | {
      readonly type: 'rejected'
      readonly code: 'concept_rejected'
      readonly reason: GateReason
      readonly rejectionMessage: string | null
      readonly synthesizedConcept: string
    }
  /** The stream failed after opening — a clear terminal, never a hung
   *  half-brief. */
  | { readonly type: 'error'; readonly code: SynthesizeStreamErrorCode }
