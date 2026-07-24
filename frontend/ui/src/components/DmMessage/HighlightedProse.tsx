import { Fragment, useMemo, useState } from 'react'
import type { DmMessageProps, EntityCard, EntityGlyph } from '@mythrun/client-core/contract'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { renderInlineEmphasis } from '../../lib/inline-emphasis.tsx'
import { EntityMention } from '../EntityMention/EntityMention.tsx'
import { EntityPopover } from '../EntityPopover/EntityPopover.tsx'

// HighlightedProse — the SETTLED-only render surface for entity-highlighted DM prose
// (MYT-94 Task 11). DmMessage swaps in this component (in place of StreamingProse) ONLY
// once a turn has settled AND the highlight index + its chrome labels are present; the
// streaming path stays byte-identical (spec §6 — no mid-stream reflow).
//
// ZERO-REFLOW HANDOFF: the paragraph carries EXACTLY the `prose-body` role classes
// StreamingProse's settled output applies, and the mentions inherit the paragraph's type
// metrics (EntityMention is inline body-serif with an out-of-flow hover glyph), so the
// stream→settle handoff never reflows the passage.
//
// SEGMENT ONCE PER ROW: `highlight.segment(text)` + the per-segment card lookups run inside
// a `useMemo` keyed on the (stable) settled `text` — segmentation is computed once per
// settled row, never on every render (spec §6: "without re-parsing on every render").
// Opening a mention popover re-renders this component but does NOT recompute the segments.
//
// Each entity segment renders an `EntityPopover` wrapping an `EntityMention`; open state is
// per-segment-index (only one popover open at a time). An entity segment whose card can't be
// resolved degrades to plain text — never a broken popover.
//
// Inline emphasis (myth-5syk3): a NON-entity text segment renders through
// `renderInlineEmphasis` so a settled ledger quote / initials render as <em>/<strong>
// here too — identical to the un-highlighted settled path. Emphasis composes at the
// segment level: entity NAMES are proper nouns that carry no markers, so the entity /
// emphasis markups do not overlap in the register in practice.

interface HighlightedProseProps {
  /** The settled DM prose (DATA). */
  text: string
  /** The compiled entity index (present ⇒ this component is mounted). */
  highlight: NonNullable<DmMessageProps['highlight']>
  /** Resolved mention / popover chrome. */
  labels: NonNullable<DmMessageProps['highlightLabels']>
  /** Fired when a mention's "open in wiki" action is chosen. */
  onEntityOpen?: DmMessageProps['onEntityOpen']
}

/** A resolved render part: plain text, or a matched entity WITH its resolved card. */
type RenderPart =
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'entity'
      readonly text: string
      readonly entityId: string
      readonly glyph: EntityGlyph
      readonly card: EntityCard
    }

export function HighlightedProse({ text, highlight, labels, onEntityOpen }: HighlightedProseProps): React.JSX.Element {
  const parts = useMemo<readonly RenderPart[]>(
    () =>
      highlight.segment(text).map((seg) => {
        if (seg.kind === 'text') return seg
        const card = highlight.card(seg.entityId)
        return card === null
          ? { kind: 'text', text: seg.text }
          : { kind: 'entity', text: seg.text, entityId: seg.entityId, glyph: seg.glyph, card }
      }),
    [highlight, text],
  )
  const [openIndex, setOpenIndex] = useState<number | null>(null)

  return (
    <p className={TYPE_ROLE_CLASS['prose-body']}>
      {parts.map((part, i) =>
        part.kind === 'text' ? (
          <Fragment key={i}>{renderInlineEmphasis(part.text)}</Fragment>
        ) : (
          <EntityPopover
            key={i}
            card={part.card}
            open={openIndex === i}
            onOpenChange={(next) => {
              setOpenIndex(next ? i : null)
            }}
            label={labels.mentionLabelFor(part.card.name)}
            typeLabel={labels.typeLabelFor(part.glyph)}
            openInWikiLabel={labels.openInWikiLabel}
            onOpenInWiki={() => {
              onEntityOpen?.(part.entityId)
              setOpenIndex(null)
            }}
          >
            <EntityMention text={part.text} glyph={part.glyph} label={labels.mentionLabelFor(part.card.name)} />
          </EntityPopover>
        ),
      )}
    </p>
  )
}
