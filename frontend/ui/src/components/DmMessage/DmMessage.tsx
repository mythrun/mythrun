import { forwardRef, Fragment } from 'react'
import type { DmMessageProps } from '@mythrun/client-core/contract'
import { Divider } from '../Divider/Divider.tsx'
import { StreamingProse } from '../StreamingProse/StreamingProse.tsx'
import { HighlightedProse } from './HighlightedProse.tsx'

// DmMessage (MYT-92) — the DM's narrative register in the live transcript: one
// row of Source Serif 4 prose (the feeling of a book being read). A THIN wrapper
// that fixes the DM register (serif, paper) over the shipped StreamingProse — it
// does NOT re-implement the caret. StreamingProse renders `text` as a single,
// stable text node inside a `prose-body` <p>, so token-wise growth updates that
// node in place (append-only, zero reflow) and the settled row hands off to
// static prose with no flash; `streaming` drives the writing caret + the SR
// annotation. The DM/player distinction is carried by TWO signals (UX §7): the
// serif face (players are `--font-ui`) AND a distinct background tint — the DM
// sits on a quiet warm paper lift (`bg-surface`, a utility so it flips under
// `.dark`), the player row on its own tint. Square register (no radius, no
// avatar/bubble). `text` is DATA (LLM prose), never an i18n key; `writingLabel`
// is a resolved i18n key the consumer passes.
//
// MYT-94 (Task 11) — SETTLE-ONLY entity highlighting. When the turn has settled
// AND the caller supplies both a compiled `highlight` index and its `highlightLabels`
// chrome, the prose renders through HighlightedProse (recognized entity names become
// mentions → popovers), which reuses StreamingProse's exact settled `prose-body`
// paragraph so the stream→settle handoff never reflows. While `streaming` (or absent a
// highlight index / its labels) the row is byte-identical to MYT-92 (spec §6: no
// mid-stream reflow; a missing label bundle degrades gracefully to plain prose).
//
// myth-yvk8p — the DM narration is the product's HERO reading surface, so its typography
// is set HERE (not in the shared StreamingProse, which the world brief also uses): the
// prose `<p>` is capped to a book measure (~66ch) and bumped to ~19px. `em`-relative
// max-width ties the measure to the (larger) size, so the cap absorbs the size without
// re-inflating characters-per-line (the run-1 hero ran ~100 CPL, over the WCAG-AAA 80
// ceiling). Applied via a child-variant on the row so BOTH the streaming StreamingProse
// `<p>` and the settled StreamingProse/HighlightedProse `<p>` get identical metrics —
// the zero-reflow handoff is preserved; only the DM register (not player/mechanical
// rows) is affected. The `<p>` keeps its `prose-body` role classes; the child-variant's
// higher specificity overrides only the size + adds the measure.
//
// `whitespace-pre-wrap` honours the paragraph breaks the FT writes: the model emits
// `\n\n` between beats (a quoted ledger line, the three initials on their own line),
// but a default `<p>` collapses that run of whitespace to a single space — the run-1
// narration read as one undifferentiated wall. pre-wrap keeps the breaks while still
// soft-wrapping long lines, and rides the same single text node so the streaming
// append + zero-reflow handoff are untouched.
//
// myth-6e0ao — SETTLED prose maps a bare markdown horizontal-rule paragraph
// (---/***) to the design system's divider: the token is a serialization artifact
// that must never print verbatim on the flagship reading surface (structural
// validation — squarely inside the ZFC exceptions). While `streaming` the text
// stays ONE append-only node (no mid-stream splitting; a transient raw token
// resolves into the divider at settle). An edge rule (leading/trailing) strips
// outright — no dangling divider.
//
// myth-304gc — every direct child rides the same centred measure column
// (`w-full max-w mx-auto`): the prose measure no longer sits crammed against the
// card's left edge with a slab of slack on the right, and every paragraph +
// divider shares one left grid line.
const RULE_PARAGRAPH = /(?:^|\n)[ \t]*(?:-{3,}|\*{3,})[ \t]*(?:\n|$)/

/** Split settled prose at bare rule paragraphs; drop edge/empty segments (and a
 *  defensive stray rule token) so a divider only ever stands BETWEEN prose. */
function splitAtRules(text: string): readonly string[] {
  return text
    .split(RULE_PARAGRAPH)
    .map((seg) => seg.replace(/^\n+|\n+$/g, ''))
    .filter((seg) => seg.trim() !== '' && !/^[-*]{3,}$/.test(seg.trim()))
}

export const DmMessage = forwardRef<HTMLDivElement, DmMessageProps>(function DmMessage(
  { text, streaming, writingLabel, highlight, onEntityOpen, highlightLabels },
  ref,
) {
  const canHighlight = !streaming && highlight !== undefined && highlightLabels !== undefined
  const segments = streaming ? [text] : splitAtRules(text)
  return (
    <div
      ref={ref}
      data-dm-message=""
      className="flex flex-col gap-[var(--space-3)] rounded-none bg-surface px-[var(--space-5)] py-[var(--space-4)] [&>*]:mx-auto [&>*]:w-full [&>*]:max-w-[34em] [&>p]:whitespace-pre-wrap [&>p]:text-[1.1875rem]"
    >
      {segments.map((seg, i) => (
        // Settled static content — the position IS the identity here.
        <Fragment key={i}>
          {i > 0 ? <Divider /> : null}
          {canHighlight ? (
            <HighlightedProse text={seg} highlight={highlight} labels={highlightLabels} onEntityOpen={onEntityOpen} />
          ) : (
            <StreamingProse
              text={seg}
              writing={streaming}
              {...(writingLabel !== undefined ? { writingLabel } : {})}
            />
          )}
        </Fragment>
      ))}
    </div>
  )
})
