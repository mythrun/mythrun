import { forwardRef } from 'react'
import type { DmCorrectionProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'

// DmCorrection (myth-d6knq) — the DM's ERRATA register in the live transcript: a
// rare, legitimate amendment of something previously narrated. It is deliberately
// NOT the DM narrative register (DmMessage sits on a warm serif paper lift). This
// row is a set-apart errata slip — a ruled ledger-margin note laid into the
// record — so a correction reads as the record being kept honest, never as the
// fiction it corrects.
//
// Two signals carry the distinction, no chrome furniture (brand: square 1-bit,
// no circles / dots / badges / chips):
//   • the MONO face (`--font-ui`) — narration is serif, so the machine face alone
//     says "this is not the story, it is a note about it";
//   • a heavy INK left rule — the ledger margin; the slip is annotated, not narrated.
// It sits UNFILLED on the ambient transcript ground (DmMessage lifts onto
// `bg-surface`), so the errata never shares the narration's warm paper.
//
// Quiet by design: muted-but-AA ink (`text-ink-secondary`, a token — flips under
// `.dark`, never a sub-AA opacity dim), a terse uppercase eyebrow (the resolved
// `label` — chrome, i18n-resolved route-side), then the amendment `text`
// (DM DATA, never an i18n key). `role="note"` marks it as an annotation to AT; the
// eyebrow is its accessible lead-in.

// The slip: a square (rounded-none) block ruled at the left margin. `border-border`
// draws the faint slip edge; the heavier `border-l-2 border-l-ink` is the ledger
// margin. Unfilled — the ambient ground shows through, off the narration lift.
const SLIP_CLASS = cn(
  'rounded-none border border-border border-l-2 border-l-ink',
  'px-[var(--space-4)] py-[var(--space-3)]',
  // min-w-0 so a long unbroken amendment wraps rather than spilling the column at ~375px.
  'flex min-w-0 flex-col gap-[var(--space-1)]',
)

// The eyebrow: a terse uppercase mono marker (the ui-label register), muted — the
// errata's quiet lead-in, not a loud badge.
const EYEBROW_CLASS = cn(TYPE_ROLE_CLASS['ui-label'], 'text-ink-secondary')

// The amendment body: mono `data` register, muted-but-legible (AA) — a record line,
// not narration. `break-words` keeps a long token inside the slip on narrow viewports.
const BODY_CLASS = cn(TYPE_ROLE_CLASS.data, 'text-ink-secondary break-words')

export const DmCorrection = forwardRef<HTMLDivElement, DmCorrectionProps>(function DmCorrection(
  { text, label },
  ref,
) {
  return (
    <div ref={ref} data-dm-correction="" role="note" className={SLIP_CLASS}>
      <p className={EYEBROW_CLASS}>{label}</p>
      <p className={BODY_CLASS}>{text}</p>
    </div>
  )
})
