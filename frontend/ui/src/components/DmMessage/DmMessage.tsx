import { forwardRef } from 'react'
import type { DmMessageProps } from '@mythrun/client-core/contract'
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
export const DmMessage = forwardRef<HTMLDivElement, DmMessageProps>(function DmMessage(
  { text, streaming, writingLabel, highlight, onEntityOpen, highlightLabels },
  ref,
) {
  return (
    <div
      ref={ref}
      data-dm-message=""
      className="rounded-none bg-surface px-[var(--space-5)] py-[var(--space-4)]"
    >
      {!streaming && highlight !== undefined && highlightLabels !== undefined ? (
        <HighlightedProse text={text} highlight={highlight} labels={highlightLabels} onEntityOpen={onEntityOpen} />
      ) : (
        <StreamingProse
          text={text}
          writing={streaming}
          {...(writingLabel !== undefined ? { writingLabel } : {})}
        />
      )}
    </div>
  )
})
