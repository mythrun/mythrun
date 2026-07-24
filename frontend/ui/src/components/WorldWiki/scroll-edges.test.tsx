import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { useRef } from 'react'
import { computeScrollEdges, useScrollEdges } from './scroll-edges.ts'

// scroll-edges backs the wiki's overflow affordance (myth-lcvv2): it decides when a
// top / bottom fade should announce that a reading panel continues past its edge.

describe('computeScrollEdges', () => {
  it('shows a bottom edge (more below) but no top edge at the very top', () => {
    // A 400px panel over 900px of content, scrolled to the top.
    expect(computeScrollEdges(0, 400, 900)).toEqual({ top: false, bottom: true })
  })

  it('shows a top edge (more above) but no bottom edge at the very bottom', () => {
    // Scrolled all the way down: scrollTop 500 + clientHeight 400 === scrollHeight 900.
    expect(computeScrollEdges(500, 400, 900)).toEqual({ top: true, bottom: false })
  })

  it('shows both edges mid-scroll', () => {
    expect(computeScrollEdges(250, 400, 900)).toEqual({ top: true, bottom: true })
  })

  it('shows no edges when the content fits (nothing to announce)', () => {
    expect(computeScrollEdges(0, 400, 400)).toEqual({ top: false, bottom: false })
  })

  it('absorbs sub-pixel slack so a fully-scrolled panel reads as settled', () => {
    // 0.5px short of the exact bottom must NOT keep the bottom fade lit.
    expect(computeScrollEdges(499.5, 400, 900)).toEqual({ top: true, bottom: false })
    // 0.5px off the top must NOT keep the top fade lit.
    expect(computeScrollEdges(0.5, 400, 900)).toEqual({ top: false, bottom: true })
  })
})

// The hook is DOM-effectful; under jsdom scrollHeight/clientHeight are 0 (nothing
// overflows) and ResizeObserver is a shim, so it settles to no edges — the point of
// this render is to exercise the effect's setup/teardown without throwing.
function EdgeProbe(): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const { top, bottom } = useScrollEdges(scrollRef)
  return (
    <div ref={scrollRef} data-testid="scroller">
      <div>content</div>
      <span data-testid="edges">{`${String(top)}:${String(bottom)}`}</span>
    </div>
  )
}

describe('useScrollEdges', () => {
  it('mounts and tears down without throwing (no overflow under jsdom → no edges)', () => {
    const { getByTestId, unmount } = render(<EdgeProbe />)
    expect(getByTestId('edges').textContent).toBe('false:false')
    unmount()
  })
})
