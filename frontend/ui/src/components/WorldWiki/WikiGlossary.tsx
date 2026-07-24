import type { WikiViewModel } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// WikiGlossary (MYT-100 IA) — the world's invented vocabulary as a SCANNABLE,
// collapsible list: one row per term (alphabetical, as the view model sorts
// them), the term reading first in the mono data register, its definition
// COLLAPSED by default and disclosed on demand. The old flat term-over-definition
// wall made the list unscannable; here the eye runs the column of terms and opens
// only what it wants.
//
// Built on native <details>/<summary> (the DS's sanctioned disclosure idiom): a
// real, keyboard-operable disclosure with zero JS state — the summary is
// focusable, Enter/Space toggles, `aria-expanded` is native. Square / paper
// register: the default triangle marker is stripped for a flat +/− that flips
// with the open state; hairline rules separate rows; no chips, no circles. A
// <ul> of disclosure rows (NOT a <dl> — <dt>/<dd> may not nest inside <details>,
// which axe's dlitem rule enforces).
//
// Kind-grouping doesn't apply — glossary terms are world vocabulary, NOT entities
// — so the natural scan order is alphabetical, which the view model already
// guarantees. A world with no vocabulary renders nothing (the graceful absence;
// the shell shows no Glossary view at all).

const ROW_CLASS = 'border-b border-border last:border-b-0'

const SUMMARY_CLASS = cn(
  'flex w-full min-w-0 items-baseline justify-between gap-[var(--space-3)]',
  'px-[var(--space-3)] py-[var(--space-2)]',
  'cursor-pointer select-none list-none [&::-webkit-details-marker]:hidden',
  'hover:bg-surface-hover',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

// The term — the mono data register, the machine-typeset label the eye scans down.
const TERM_CLASS = 'min-w-0 font-ui text-sm text-ink'

// The flat +/− disclosure marker (square register, no triangle/circle): the '+'
// shows while collapsed, the '−' once the row's <details> is open — driven purely
// by the native open state via the `group-open` variant, no JS.
const MARKER_CLASS = 'shrink-0 font-ui text-sm text-ink-tertiary select-none'

// The definition — serif prose, revealed under the term when the row opens.
const DEF_CLASS = 'px-[var(--space-3)] pb-[var(--space-3)] font-body text-base leading-[1.6] text-ink'

export interface WikiGlossaryProps {
  /** The world's glossary entries (term + definition), term-sorted by the view model. */
  glossary: WikiViewModel['glossary']
}

export function WikiGlossary({ glossary }: WikiGlossaryProps): React.JSX.Element {
  return (
    <ul className="min-w-0 list-none">
      {glossary.map((entry, index) => (
        // Index keys are safe here (the list is static per render) and, unlike
        // term keys, two same-termed rows can't collide and drop one.
        <li key={index} className={ROW_CLASS}>
          <details className="group min-w-0">
            <summary className={SUMMARY_CLASS}>
              <span className={TERM_CLASS}>{entry.term}</span>
              <span aria-hidden="true" className={MARKER_CLASS}>
                <span className="group-open:hidden">+</span>
                <span className="hidden group-open:inline">−</span>
              </span>
            </summary>
            <p className={DEF_CLASS}>{entry.definition}</p>
          </details>
        </li>
      ))}
    </ul>
  )
}
