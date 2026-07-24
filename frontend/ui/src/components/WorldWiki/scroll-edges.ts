import { useLayoutEffect, useState } from 'react'
import type { RefObject } from 'react'

// scroll-edges (myth-lcvv2) — the "is there more to scroll?" signal behind the
// wiki's overflow affordance. The reveal wiki panel is a correctly-bounded
// fixed-height scroll region, but macOS overlay scrollbars hide at rest and the
// panel carried no fade, so a lore definition that ran past the fold read as a
// hard clip mid-sentence ("…the titan's petrified" and gone). This computes
// whether the region can still scroll UP / DOWN so a fade can announce it.

export interface ScrollEdges {
  /** Content is scrolled down from the top — a top fade should show. */
  top: boolean
  /** Content extends below the fold — a bottom fade should show ("there's more"). */
  bottom: boolean
}

/** Whether a scroll region can scroll up / down, from its raw metrics. Pure — a
 *  1px slack absorbs sub-pixel rounding so a fully-scrolled region reads as
 *  settled (no perpetual fade). */
export function computeScrollEdges(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
): ScrollEdges {
  const SLACK = 1
  return {
    top: scrollTop > SLACK,
    bottom: scrollTop + clientHeight < scrollHeight - SLACK,
  }
}

/** Track a scroll element's up/down overflow edges, live. Recomputes on scroll, on
 *  the region resizing (`ResizeObserver`), on a disclosure inside it opening/closing
 *  (`toggle`, captured — a glossary row expanding past the fold re-arms the bottom
 *  fade; the event doesn't bubble, so the listener sits in the CAPTURE phase), and
 *  once the web fonts settle (a late serif reflow changes the content height without
 *  resizing the box). A layout effect + the ResizeObserver's immediate first callback
 *  seat the edges before paint, so there's no first-frame flash of the wrong
 *  affordance. Inert under jsdom where ResizeObserver is a no-op shim — the initial
 *  compute still runs. */
export function useScrollEdges(scrollRef: RefObject<HTMLElement | null>): ScrollEdges {
  const [edges, setEdges] = useState<ScrollEdges>({ top: false, bottom: false })
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el === null) return undefined
    const recompute = (): void => {
      setEdges(computeScrollEdges(el.scrollTop, el.clientHeight, el.scrollHeight))
    }
    recompute()
    el.addEventListener('scroll', recompute, { passive: true })
    // A native <details> toggle does not bubble — catch it on the way DOWN (capture).
    el.addEventListener('toggle', recompute, { capture: true })
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(recompute)
    observer?.observe(el)
    let cancelled = false
    if ('fonts' in document) {
      void document.fonts.ready.then(() => {
        if (!cancelled) recompute()
      })
    }
    return () => {
      cancelled = true
      el.removeEventListener('scroll', recompute)
      el.removeEventListener('toggle', recompute, { capture: true })
      observer?.disconnect()
    }
  }, [scrollRef])
  return edges
}
