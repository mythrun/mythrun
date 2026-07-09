import type { WikiRelatedLink } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { Divider } from '../Divider/Divider.tsx'

// RelatedFooter (MYT-89 D4) — a page's "see also": the entity's `related`
// links (D2's UUID-resolved, both-directions field). Field-guide register, not
// a chip tray: a hairline rule, a quiet mono section label, then plain rows —
// the target NAME painted as the link (accent ink, underline on hover), the
// de-snaked relationship label as a quiet mono annotation at the row's right
// edge (the entity-list kind-tag idiom). Whole row is one native <button>
// (native keyboard activation, a full-width target); only the name carries the
// accent, so nothing reads as a pill.

// The mono small-caps annotation idiom — shared vocabulary with the
// entity-list kind tag and WikiPage's kind/section labels.
const LABEL_CLASS = 'shrink-0 font-ui text-[0.65rem] uppercase tracking-wide text-ink-tertiary'

const ROW_CLASS = cn(
  'group flex w-full min-w-0 items-baseline justify-between gap-[var(--space-3)] text-left',
  'bg-transparent rounded-none cursor-pointer select-none',
  'px-[var(--space-3)] py-[var(--space-2)]',
  'hover:bg-surface-hover active:bg-surface-active',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

// The link paint rides the NAME span only (not the row), so the quiet mono
// annotation stays ink and the row never reads as one big tinted chip.
const NAME_CLASS = cn(
  'min-w-0 truncate font-body text-base leading-[1.6]',
  'text-accent-fg underline-offset-2 group-hover:underline group-hover:text-accent-fg-hover',
)

export interface RelatedFooterProps {
  /** The page entity's cross-links — D2's `WikiEntity.related`. */
  related: readonly WikiRelatedLink[]
  /** The section label — an i18n'd value supplied by the consumer. */
  label: string
  /** Neutral navigation callback — carries the target entity id. */
  onOpen: (entityId: string) => void
}

export function RelatedFooter({ related, label, onOpen }: RelatedFooterProps): React.JSX.Element | null {
  if (related.length === 0) return null
  return (
    <footer className="flex min-w-0 flex-col gap-[var(--space-2)] pt-[var(--space-4)]">
      <Divider tone="border" />
      <p className={cn(LABEL_CLASS, 'px-[var(--space-3)]')}>{label}</p>
      <ul className="min-w-0">
        {related.map((link) => (
          <li key={`${link.entityId}:${link.label}`}>
            <button
              type="button"
              onClick={() => {
                onOpen(link.entityId)
              }}
              className={ROW_CLASS}
            >
              <span className={NAME_CLASS}>{link.name}</span>
              <span className={LABEL_CLASS}>{link.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </footer>
  )
}
