import { forwardRef } from 'react'
import type { SessionProgressBand, SessionProgressLineProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// SessionProgressLine (myth-atxhx) — where the table is in tonight's play, as ONE
// quiet line in the mono record register. It sits in the between-turns chrome above
// the transcript, beside the end control it also explains.
//
// WHY A LINE AND NOT A BAR. The underlying signal is mechanical and COST-derived
// (token budget + context fill). Rendered as a meter or a percentage it becomes a
// spend gauge parked over the fiction — "62% of your money used" — which is both the
// wrong thing to hold in mind mid-scene and squarely outside the paper-y, 1-bit,
// un-gamified register (no bars, no chips, no badges, no dots). So the number never
// reaches this component: the consumer bands it and passes a WORD. There is no
// numeric prop to regress into.
//
// EMPHASIS IS TYPOGRAPHIC, NOT CHROMATIC. The one thing the line does with its band
// is lift its ink as the session closes — tertiary early, secondary at `late`, full
// ink at `close`. That is the register's only emphasis channel, and it means the last
// stretch reads without the line ever becoming an alarm.
//
// a11y: a polite live region. Band changes are rare (three per session at most), and
// the change is exactly the thing a player needs to hear — a session that quietly
// approached its end with no announcement is the failure mode. Not aria-hidden
// decoration.

// The mono record register — the same quiet chrome line the wait screens close on.
const BASE_CLASS = 'font-ui text-xs leading-[1.5] break-words'

// Ink by band: quiet while there is room, full ink when the landing is near.
const BAND_INK_CLASS: Record<SessionProgressBand, string> = {
  early: 'text-ink-tertiary',
  middle: 'text-ink-tertiary',
  late: 'text-ink-secondary',
  close: 'text-ink',
}

export const SessionProgressLine = forwardRef<HTMLParagraphElement, SessionProgressLineProps>(
  function SessionProgressLine({ label, band, 'data-testid': testId = 'session-progress-line' }, ref) {
    return (
      <p
        ref={ref}
        role="status"
        aria-live="polite"
        data-testid={testId}
        data-band={band}
        className={cn(BASE_CLASS, BAND_INK_CLASS[band])}
      >
        {label}
      </p>
    )
  },
)
