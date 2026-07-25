import { useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { cn } from '../../lib/cn.ts'
import { useScrollEdges } from './scroll-edges.ts'

// WikiScrollFrame (myth-lcvv2; fade rebuilt in ux-run2 myth-9dcfq) — the wiki's
// reading scroll region, made to ANNOUNCE its overflow. The reveal wiki panel is a
// fixed-height scroll region (the graph half owns the row height; the wiki half caps
// to it and scrolls internally), but two things hid that: macOS overlay scrollbars
// vanish at rest, and nothing marked the cut edge — so a definition that ran past the
// fold read as a hard clip mid-sentence, not as "scroll for more".
//
// The affordance, both halves:
//   1. a quiet, styled scrollbar — `scrollbar-color`/`-width` render it thin in the ink
//      register, and a stable gutter reserves its width so expanding a glossary row never
//      reflows the prose sideways (on platforms with classic scrollbars; macOS overlay
//      scrollbars still auto-hide, which is why the fade below is the still-frame cue).
//   2. shallow top/bottom edge FADES, gated by scroll position (`useScrollEdges`) — the
//      bottom fade appears whenever content extends past the fold and clears at the end;
//      the top fade mirrors it once the reader scrolls down.
//
// THE FADE IS A MASK, NOT AN OVERLAY (myth-9dcfq). The first cut painted a
// `--bg`→transparent gradient div OVER the content, which failed two ways: on a
// panel grounded on `--surface` (the char-fork rail) the wash was the WRONG tone —
// a visible gray smudge — and its 32px band rendered whole glossary rows at
// intermediate alpha, "the near-universal styling for DISABLED, exactly the wrong
// thing to imply about a tappable term." A CSS mask on the scroll element fades the
// CONTENT ITSELF to transparent, revealing whatever ground is truly behind (any
// panel tone, both themes, by construction), and the band is clamped to
// `FADE_BAND_PX` — shallower than one text line, so it can only graze the sliced
// edge of the line the fold cuts. A cleanly cropped line with a grazed edge is the
// honest cue (the praised reveal-pane crop); a ghosted full row never happens.
//
// The scroll element carries the caller's `scrollRef` (the shell's scroll-memory reads
// `scrollTop` off it) merged with the frame's own. Children are the scroll element's
// DIRECT content (no wrapper) so the shell's `article.parentElement`-relative scroll
// memory and the browser sweep's overflow probes are unchanged. The live edge state is
// stamped as `data-scroll-edges` (jsdom can't compute inline mask styles — the attribute
// is the testable surface, and a debugging aid in the inspector).

/** The scroll element's classes: the flex-filled scroll region plus the quiet styled
 *  scrollbar (thin, `--border-strong` thumb over a transparent track, a stable gutter
 *  so a classic scrollbar never reflows the text). Arbitrary-PROPERTY utilities, not
 *  `bg-[var(--…)]`-style color utilities — no-ad-hoc-color safe. */
const SCROLL_CLASS = cn(
  'min-h-0 min-w-0 flex-1 overflow-y-auto',
  '[scrollbar-width:thin] [scrollbar-color:var(--border-strong)_transparent] [scrollbar-gutter:stable]',
)

/** The edge-fade band (px). MUST stay below one text line (~20px at the wiki's
 *  tightest row, text-sm) — the mask may graze only the SLICED edge of the line
 *  the fold cuts, never render a full line or a tappable row at intermediate
 *  alpha (myth-9dcfq; the geometry pin lives in the test). */
export const FADE_BAND_PX = 12

/** The mask-image for the current edge state — `black` is only the alpha carrier
 *  (a mask reads alpha, it paints nothing), `transparent` is the fade-out. No
 *  edges → no mask (undefined). */
function maskFor(top: boolean, bottom: boolean): string | undefined {
  if (!top && !bottom) return undefined
  const from = top ? `transparent 0, black ${String(FADE_BAND_PX)}px` : 'black 0'
  const to = bottom ? `black calc(100% - ${String(FADE_BAND_PX)}px), transparent 100%` : 'black 100%'
  return `linear-gradient(to bottom, ${from}, ${to})`
}

export interface WikiScrollFrameProps {
  /** The semantic element for the scroll region — `article` for an entity page,
   *  `div` (default) for the home surface. */
  as?: 'div' | 'article'
  /** The shell's scroll-memory handle: the frame forwards the scroll element to it
   *  (merged with its own ref) so `scrollTop` capture/restore is unchanged. */
  scrollRef?: RefObject<HTMLElement | null>
  /** Fired on the scroll element (the shell captures scroll offsets on some paths). */
  onScroll?: () => void
  /** Padding / layout classes for the scroll element (kept ON it, as the pre-frame
   *  markup had them, so the scroll memory's direct-child structure is preserved). */
  contentClassName?: string
  children: ReactNode
  'data-testid'?: string
}

/** A vertical scroll region that announces its overflow with a styled scrollbar and
 *  scroll-gated, mask-built edge fades. */
export function WikiScrollFrame({
  as = 'div',
  scrollRef,
  onScroll,
  contentClassName,
  children,
  'data-testid': dataTestId,
}: WikiScrollFrameProps): React.JSX.Element {
  const localRef = useRef<HTMLElement | null>(null)
  const { top, bottom } = useScrollEdges(localRef)

  // Merge the caller's scroll-memory ref with the frame's own (the hook reads the
  // element off `localRef`; the shell reads `scrollTop` off its `scrollRef`).
  const setScroll = (el: HTMLElement | null): void => {
    localRef.current = el
    if (scrollRef !== undefined) scrollRef.current = el
  }

  const mask = maskFor(top, bottom)
  const edges = [top && 'top', bottom && 'bottom'].filter(Boolean).join(' ')
  const scrollProps = {
    ref: setScroll,
    onScroll,
    className: cn(SCROLL_CLASS, contentClassName),
    ...(mask !== undefined
      ? { style: { maskImage: mask, WebkitMaskImage: mask }, 'data-scroll-edges': edges }
      : {}),
    ...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {}),
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {as === 'article' ? (
        <article {...scrollProps}>{children}</article>
      ) : (
        <div {...scrollProps}>{children}</div>
      )}
    </div>
  )
}
