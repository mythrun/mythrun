import { forwardRef } from 'react'
import type { HatchLineProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// HatchLine — the flow escape-hatch line (ux-run2 myth-vjl7d). One quiet mono
// line: the framing prompt in the ambient muted chrome register, then the
// actionable phrase as a REAL link affordance — persistent underline + accent
// ink — rendered as a `<button>` (an in-flow mode switch, not navigation). The
// run-2 player never read the bare ghost-text hatch as pressable; the underline
// is the affordance, not decoration, so it is always on (Link's hover-only
// underline is for prose links whose accent colour already marks them — here
// the phrase sits alone on chrome and needs the mark at rest).
//
// The line is left-aligned block chrome (the consumer's column grid aligns it);
// spacing above/below belongs to the consumer's Stack rhythm.

// The framing prompt: quiet mono caption, muted — ambient chrome, not a label.
const PROMPT_CLASS = 'font-ui text-xs font-medium text-ink-secondary'

// The action: same mono scale, accent ink, persistent underline; hover deepens
// (the Link idiom), focus is the shared DS ring. An inline text control (WCAG
// target-size inline exemption — it sits in a line of text at text scale).
const ACTION_CLASS = cn(
  'font-ui text-xs font-medium cursor-pointer',
  'text-accent-fg underline underline-offset-2 hover:text-accent-fg-hover',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

export const HatchLine = forwardRef<HTMLParagraphElement, HatchLineProps>(function HatchLine(
  { prompt, action, onPress, ...rest },
  ref,
) {
  return (
    <p ref={ref} className={PROMPT_CLASS} {...rest}>
      {prompt !== undefined && prompt !== '' ? <>{prompt} </> : null}
      <button type="button" onClick={onPress} className={ACTION_CLASS}>
        {action}
      </button>
    </p>
  )
})
