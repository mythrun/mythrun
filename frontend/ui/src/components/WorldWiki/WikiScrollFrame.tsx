import { useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { cn } from '../../lib/cn.ts'
import { useScrollEdges } from './scroll-edges.ts'

// WikiScrollFrame (myth-lcvv2) — the wiki's reading scroll region, made to ANNOUNCE
// its overflow. The reveal wiki panel is a fixed-height scroll region (the graph half
// owns the row height; the wiki half caps to it and scrolls internally), but two things
// hid that: macOS overlay scrollbars vanish at rest, and nothing faded the cut edge — so
// a definition that ran past the fold read as a hard clip mid-sentence, not as "scroll
// for more" (the run-1 critique: "the flagship entry can't be finished").
//
// The fix, both halves of the run-1 prescription:
//   1. a quiet, styled scrollbar — `scrollbar-color`/`-width` render it thin in the ink
//      register, and a stable gutter reserves its width so expanding a glossary row never
//      reflows the prose sideways (on platforms with classic scrollbars; macOS overlay
//      scrollbars still auto-hide, which is why the fade below is the still-frame cue).
//   2. top / bottom FADE masks, gated by scroll position (`useScrollEdges`) — the bottom
//      fade appears whenever content extends past the fold and clears at the end, so the
//      truncation announces itself even in a still frame; the top fade mirrors it once the
//      reader scrolls down.
//
// The scroll element carries the caller's `scrollRef` (the shell's scroll-memory reads
// `scrollTop` off it) merged with the frame's own. Children are the scroll element's
// DIRECT content (no wrapper) so the shell's `article.parentElement`-relative scroll
// memory and the browser sweep's overflow probes are unchanged. The fades are
// `aria-hidden` paper masks — strictly two-tone (`--bg` → transparent), no new colour.

/** The scroll element's classes: the flex-filled scroll region plus the quiet styled
 *  scrollbar (thin, `--border-strong` thumb over a transparent track, a stable gutter
 *  so a classic scrollbar never reflows the text). Arbitrary-PROPERTY utilities, not
 *  `bg-[var(--…)]`-style color utilities — no-ad-hoc-color safe. */
const SCROLL_CLASS = cn(
  'min-h-0 min-w-0 flex-1 overflow-y-auto',
  '[scrollbar-width:thin] [scrollbar-color:var(--border-strong)_transparent] [scrollbar-gutter:stable]',
)

const FADE_BASE = 'pointer-events-none absolute inset-x-0 z-10 h-[var(--space-6)] transition-opacity duration-[var(--duration-fast)]'
// The paper masks: a gradient from the page ground to transparent (token `var(--bg)`,
// which flips with the theme — no raw colour, no color-function → no-ad-hoc-color safe).
const TOP_FADE_STYLE = { backgroundImage: 'linear-gradient(to bottom, var(--bg), transparent)' } as const
const BOTTOM_FADE_STYLE = { backgroundImage: 'linear-gradient(to top, var(--bg), transparent)' } as const

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
 *  scroll-gated top/bottom fades. */
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

  const scrollProps = {
    ref: setScroll,
    onScroll,
    className: cn(SCROLL_CLASS, contentClassName),
    ...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {}),
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      {as === 'article' ? (
        <article {...scrollProps}>{children}</article>
      ) : (
        <div {...scrollProps}>{children}</div>
      )}
      <div aria-hidden="true" style={TOP_FADE_STYLE} className={cn(FADE_BASE, 'top-0', top ? 'opacity-100' : 'opacity-0')} />
      <div aria-hidden="true" style={BOTTOM_FADE_STYLE} className={cn(FADE_BASE, 'bottom-0', bottom ? 'opacity-100' : 'opacity-0')} />
    </div>
  )
}
