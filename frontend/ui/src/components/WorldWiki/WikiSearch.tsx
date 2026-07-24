import { useId } from 'react'
import { cn } from '../../lib/cn.ts'

// WikiSearch (MYT-100 hierarchy fix) — the wiki's FILTER control. A working
// control, sized like one: a body-scale borderless baseline field in the flat
// 1-bit paper register (no box, no pill), NOT the display-scale conversational
// prose field the creation flow uses (SeamlessInput). The whole point of the
// redesign: the search field is not a hero. Its type sits at body scale, below
// the browse-by-kind group headings and well below the world-name title — the
// honest ladder the panel reads top to bottom.
//
// THE LABEL is a QUIET prompt, not a heading (the old text-lg/600 label read as
// one, competing with the group titles): a small secondary serif line, tightly
// coupled ABOVE the field (persistent + programmatically associated, WCAG
// 3.3.2). The mono INDEX eyebrow above it — a different register — organizes the
// whole index (search + browse + glossary); this label names only the field.
//
// A NON-BOX focus affordance (WCAG 2.4.13, the borderless-field requirement,
// same idiom the creation ghost field documents): a thin low-emphasis baseline
// rule that thickens to 2px and colors to the foreground accent on focus; the
// default box outline is removed because the accent baseline IS the indicator.
// The branded ember caret (`--accent-fg`) reads against parchment in both themes.
//
// Neutral `onChange(value)` (§9): the impl pulls `e.target.value` and hands the
// consumer a plain string — the DS never leaks the DOM ChangeEvent. Copy is the
// consumer's (the DS owns none): `label` + `placeholder` arrive resolved.

// The label — a QUIET secondary serif prompt (text-sm / normal / ink-secondary),
// distinctly smaller and lighter than the text-lg group headings so it never
// reads as a heading; a different register from the mono INDEX eyebrow above.
const LABEL_CLASS = cn('block mb-[var(--space-1)] font-body text-sm font-normal leading-[1.4] text-ink-secondary')

// The field — BODY scale (text-base), the control register: a working filter, not
// the display-scale creation prompt. Borderless paper idiom (no box, 0px corners,
// transparent fill) with the non-box focus baseline.
const FIELD_CLASS = cn(
  'block w-full font-body text-base leading-[1.6] text-ink',
  'rounded-none border-0 bg-transparent',
  'caret-accent-fg placeholder:text-ink-tertiary',
  // The non-box focus affordance (WCAG 2.4.13): a thin baseline rule that
  // thickens + colors to accent on focus; the box outline is removed because the
  // baseline IS the indicator.
  'border-b border-border',
  'focus-visible:outline-none focus-visible:border-b-2 focus-visible:border-accent-fg',
)

export interface WikiSearchProps {
  /** The field's visible + accessible label (WCAG 3.3.2) — an i18n'd value from
   *  the consumer. */
  label: string
  /** The controlled query value. */
  value: string
  /** Neutral value callback — a plain string, never the DOM event. */
  onChange: (value: string) => void
  /** The faint placeholder hint (never the label) — an i18n'd value. */
  placeholder: string
}

export function WikiSearch({ label, value, onChange, placeholder }: WikiSearchProps): React.JSX.Element {
  // A stable id wires label ↔ field so the label always names the control for AT.
  const fieldId = useId()
  return (
    <div className="px-[var(--space-3)]">
      <label htmlFor={fieldId} className={LABEL_CLASS}>
        {label}
      </label>
      <input
        id={fieldId}
        type="text"
        value={value}
        onChange={(e) => {
          onChange(e.target.value)
        }}
        placeholder={placeholder}
        className={FIELD_CLASS}
      />
    </div>
  )
}
