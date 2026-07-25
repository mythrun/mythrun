import { forwardRef } from 'react'
import type { TableTalkProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// TableTalk (myth-1msig) — the marked OUT-OF-CHARACTER block in the live-play
// transcript: an Ask-the-DM exchange framed in the table-note register so the
// fiction/meta boundary survives reread. The run-3 critique: the OOC answer
// rendered in the narration serif with no frame, so the durable transcript —
// the artifact the product's memory systems and the players' shared history are
// built on — discarded a boundary the system knew with certainty at authorship.
//
// The frame marks the START of the aside (a door on the way in, not only the
// answer's "Back to you." on the way out): a terse uppercase mono eyebrow
// ("TABLE TALK") over a ruled slip. The rows INSIDE keep their own registers —
// the attributed question in the players' mono (PlayerMessage), the answer in
// the DM's serif (DmMessage, kept for readability at answer length) — the
// boundary lives on the FRAME, not the faces.
//
// Register: the sibling of DmCorrection's errata slip — square 1-bit
// (rounded-none), a faint slip edge + the heavier ink left rule (the ledger
// margin), UNFILLED on the ambient transcript ground so the aside never shares
// the narration's warm paper. No chips, no badges. `role="note"` marks it as an
// annotation to AT; the eyebrow is its accessible lead-in. The DS owns no copy:
// `label` arrives resolved (i18n route-side).

// The slip: a square block ruled at the left margin, unfilled (the ambient
// ground shows through — off the narration lift). min-w-0 so long exchange rows
// wrap inside the column at ~375px.
const FRAME_CLASS = cn(
  'rounded-none border border-border border-l-2 border-l-ink',
  'px-[var(--space-4)] py-[var(--space-3)]',
  'flex min-w-0 flex-col gap-[var(--space-2)]',
)

// The eyebrow: the terse uppercase mono marker (ui-label register), muted — the
// aside's quiet lead-in, not a loud badge.
const EYEBROW_CLASS = cn(TYPE_ROLE_CLASS['ui-label'], 'text-ink-secondary')

export const TableTalk = forwardRef<HTMLDivElement, TableTalkProps>(function TableTalk(
  { label, children },
  ref,
) {
  return (
    <div ref={ref} data-table-talk="" role="note" className={FRAME_CLASS}>
      <p className={EYEBROW_CLASS}>{label}</p>
      {children}
    </div>
  )
})
