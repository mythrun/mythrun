import { forwardRef } from 'react'
import type { StreamingProseProps } from '@mythrun/client-core/contract'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { renderInlineEmphasis, stripInlineEmphasis } from '../../lib/inline-emphasis.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// Prose that ARRIVES (myth-umggn) — the render surface for LLM text streaming
// in live (the guided create flow's world brief; later, any streamed
// narration). The paragraph carries EXACTLY the `prose-body` role classes Text
// applies, so a finished stream hands off to a static
// `<Text role="prose-body" as="p">` with zero visual reflow.
//
// The caret: while `writing`, a small ember rectangle (paper register — a
// square mark, no circles) sits inline after the last character and pulses on
// `animate-pulse` — the brand's ONLY sanctioned motion (an opacity fade, §4;
// the WorldGenStatusCard's running cell is the precedent). Em-sized
// (h/w in em) so it scales with the type role. Under `prefers-reduced-motion`
// the global reset freezes the animation at full opacity — a steady caret,
// never a vanished one; the arriving text itself remains the progress signal.
//
// a11y: `aria-busy` marks the passage as updating while `writing`; the caret
// is decorative (`aria-hidden`). `writingLabel` (an i18n key the consumer
// resolves) is appended visually-hidden while writing so AT users reading the
// passage know it is still being written; it leaves with the caret.
//
// Inline emphasis (myth-5syk3) is SETTLE-ONLY, mirroring MYT-94's settle-only entity
// highlighting: while `writing` the body is a single stripped text node (no literal
// `*` flashes, the append-only streaming path preserved); on settle it re-renders
// through `renderInlineEmphasis` so `*present*` → <em> and `**V. L. K.**` → <strong>.
// For prose with no markers — the common case — both paths are byte-identical to the
// raw text, so the zero-reflow handoff to <Text role="prose-body"> is unchanged.
export const StreamingProse = forwardRef<HTMLParagraphElement, StreamingProseProps>(
  function StreamingProse({ text, writing = false, writingLabel, ...rest }, ref) {
    return (
      <p
        ref={ref}
        className={TYPE_ROLE_CLASS['prose-body']}
        {...(writing ? { 'aria-busy': true } : {})}
        {...rest}
      >
        {writing ? stripInlineEmphasis(text) : renderInlineEmphasis(text)}
        {writing ? (
          <span
            aria-hidden="true"
            data-streaming-caret=""
            className="ml-[0.12em] inline-block h-[0.95em] w-[0.5em] translate-y-[0.14em] animate-pulse bg-accent"
          />
        ) : null}
        {writing && writingLabel !== undefined ? (
          <VisuallyHidden>{writingLabel}</VisuallyHidden>
        ) : null}
      </p>
    )
  },
)
