import type { ReactNode } from 'react'

// TableTalk (myth-1msig) — the marked out-of-character block in the live-play
// transcript: an Ask-the-DM exchange (the attributed @dm question + the DM's
// answer) framed in the table-note register so the fiction/meta boundary
// survives reread. The frame carries a terse mono eyebrow ("Table talk") and a
// ruled edge; the rows INSIDE keep their own registers (the question in the
// players' mono, the answer in the DM's serif — the boundary lives on the
// frame, not the faces). "Back to you." stays the DM's own graceful close of
// the marked block; it no longer carries the boundary alone.
//
// Platform-neutral (§9): a resolved i18n eyebrow + a children slot — no
// className/style, no DOM events. The grouping itself is computed route-side
// (client-core `buildTableTalkView`) and threaded through MessageStream.

/** Props for the marked table-talk (OOC exchange) frame. */
export interface TableTalkProps {
  /** The resolved mono eyebrow ("Table talk") — chrome, i18n-resolved route-side. */
  label: string
  /** The framed exchange — the attributed question + answer rows. */
  children: ReactNode
}
