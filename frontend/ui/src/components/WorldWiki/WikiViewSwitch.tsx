import { cn } from '../../lib/cn.ts'

// WikiViewSwitch (MYT-100 IA) — the wiki's Index ⇄ Glossary view switch. A
// SEGMENTED toggle group, deliberately NOT the DS's underlined `Tabs`: the play
// KnowledgeSidebar already wraps the wiki in an underlined tab bar (World / Ties
// / Sheet), so a second underlined bar inside it would read as nested tabs (the
// smell). A segmented control in the same token vocabulary (square, 1px
// --border-strong, --ink active / --ink-tertiary idle, the shared focus ring) is
// one visual language with the system while sitting at a distinct altitude from
// the sidebar's tabs — so it reads as sub-navigation within the panel, in either
// skin.
//
// A11y: two native toggle buttons, each carrying its OWN accessible name (the
// Index / Glossary labels) + `aria-pressed`, so the group needs no separate
// (copy-owning) label — the DS invents no strings. Tab focuses each segment;
// Enter/Space activates. Exactly one segment is pressed at a time (the caller
// holds the value). Flat 1-bit / square register: no pills, no rounded group.

/** The two peer views of the wiki home. */
export type WikiView = 'index' | 'glossary'

const GROUP_CLASS = 'inline-flex self-start rounded-none border border-border-strong bg-surface'

const SEGMENT_BASE = cn(
  'px-[var(--space-4)] py-[var(--space-1)] font-ui text-sm rounded-none cursor-pointer select-none',
  'border-r border-border-strong last:border-r-0',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

interface SegmentProps {
  active: boolean
  label: string
  onSelect: () => void
}

function Segment({ active, label, onSelect }: SegmentProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onSelect}
      className={cn(
        SEGMENT_BASE,
        active ? 'bg-surface-active font-medium text-ink' : 'bg-transparent text-ink-tertiary hover:text-ink',
      )}
    >
      {label}
    </button>
  )
}

export interface WikiViewSwitchProps {
  /** The active view (controlled by the shell). */
  value: WikiView
  /** Fired with the picked view — a neutral value callback. */
  onChange: (view: WikiView) => void
  /** The Index segment's copy — the same resolved string the index eyebrow used. */
  indexLabel: string
  /** The Glossary segment's copy — the same resolved string the glossary eyebrow used. */
  glossaryLabel: string
}

export function WikiViewSwitch({ value, onChange, indexLabel, glossaryLabel }: WikiViewSwitchProps): React.JSX.Element {
  return (
    <div className={GROUP_CLASS}>
      <Segment active={value === 'index'} label={indexLabel} onSelect={() => { onChange('index') }} />
      <Segment active={value === 'glossary'} label={glossaryLabel} onSelect={() => { onChange('glossary') }} />
    </div>
  )
}
