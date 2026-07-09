import { useLayoutEffect, useRef, useState } from 'react'
import type { FullBleedStageProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { BLEED_CLASS } from '../../lib/space.ts'
import { useViewportNarrow } from '../../lib/use-viewport-narrow.ts'

// FullBleedStage (MYT-89 audit v2 — the mobile full-bleed fix). The narrow-
// viewport FULL-SCREEN stage for content that should own the phone (the
// world-gen graph: a pannable surface is expected to take the entirety of the
// screen). Inside the app's framed chrome — a header bar above, a token-padded
// content box around — the stage, on a phone-class viewport (< 640px):
//
//   1. CANCELS the host frame's content inset with negative margins at the SAME
//      `--space-*` step (`inset` — the consumer states its frame's padding; the
//      app frame pads with step 6). The stage's box then spans the frame
//      edge-to-edge, and its TOP edge lands exactly at the header's bottom.
//   2. FILLS the viewport below that top edge: the top offset is MEASURED (the
//      header's height is content-derived, not a token) and the height set to
//      `max(calc(100dvh - top), innerHeight - top)` — `dvh` so mobile URL-bar
//      collapse tracks for free, FLOORED at the measured real viewport because
//      current Safari (26.x, and its responsive-design-mode device presets)
//      can resolve 100dvh SMALLER than the actual visible viewport (the
//      floating-footer bug, MYT-89 audit v3 item 6; Apple dev forums #803987).
//      Where dvh is honest the operands agree and the max() is a no-op; where
//      dvh under-reports, the measured floor holds the fold. A pinch-zoom
//      shrinks innerHeight below dvh — max() then rides dvh, so the layout
//      never chases the zoom. The measure re-runs on resize, on visualViewport
//      resize (the RDM/iOS viewport signal), and on document reflow (font
//      loads, header wraps). Nav + stage = exactly one viewport: no dead
//      paper, no page scroll.
//   3. Lays children out as a FLEX COLUMN so a full-height child (WorldGenGraph's
//      footer layout: flexing pane + status bar) can fill the space.
//
// On a WIDE viewport it renders a plain block — the wrapped content is laid out
// exactly as if the stage weren't there (the desktop zero-change guarantee).
// The flip is form-factor-driven (the DS's one narrow regime, `useViewportNarrow`)
// — never runtime state like the world-gen camera engaging.

/** Measure the stage's viewport-top offset into the floored fill height (see
 *  item 2 above). Rounded (sub-pixel tops would make the page scroll by a
 *  fraction); floored at 0 (a scrolled-past stage must not overgrow the
 *  viewport). */
function fillHeightFrom(el: HTMLElement | null): string {
  const top = Math.max(0, Math.round(el?.getBoundingClientRect().top ?? 0))
  const floor = Math.max(0, Math.round(window.innerHeight) - top)
  return `max(calc(100dvh - ${String(top)}px), ${String(floor)}px)`
}

export function FullBleedStage({
  inset,
  children,
  'data-testid': dataTestId,
}: FullBleedStageProps): React.JSX.Element {
  const narrow = useViewportNarrow()
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState<string | undefined>(undefined)

  // Measure-and-fill, narrow only. A LAYOUT effect: the height lands before
  // paint, so the stage never flashes content-height. Re-measured on window
  // resize and on body reflow (a ResizeObserver on `document.body` — the header
  // above can change height on font load or wrap, moving the stage's top edge).
  useLayoutEffect(() => {
    if (!narrow) {
      setHeight(undefined)
      return
    }
    const measure = (): void => {
      setHeight(fillHeightFrom(ref.current))
    }
    measure()
    window.addEventListener('resize', measure)
    // The visual-viewport resize signal: iOS URL-bar transitions and RDM preset
    // switches can move the floor without a window resize event.
    window.visualViewport?.addEventListener('resize', measure)
    const observer = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    observer?.observe(document.body)
    return () => {
      window.removeEventListener('resize', measure)
      window.visualViewport?.removeEventListener('resize', measure)
      observer?.disconnect()
    }
  }, [narrow])

  const testId = dataTestId !== undefined ? { 'data-testid': dataTestId } : {}
  if (!narrow) return <div {...testId}>{children}</div>
  return (
    <div
      ref={ref}
      {...testId}
      className={cn('flex min-w-0 flex-col', BLEED_CLASS[inset])}
      {...(height !== undefined ? { style: { height } } : {})}
    >
      {children}
    </div>
  )
}
