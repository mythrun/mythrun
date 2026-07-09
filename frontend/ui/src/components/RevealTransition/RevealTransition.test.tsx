import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import type { RevealMoment } from '@mythrun/client-core/contract'
import {
  RevealTransition,
  RevealPanes,
  RevealFade,
  REVEAL_HOLD_MS,
  REVEAL_GUST_MS,
  REVEAL_SETTLE_MS,
  REVEAL_RESOLVE_MS,
  REVEAL_REDUCED_FADE_MS,
} from './RevealTransition.tsx'

// RevealTransition — the gen→reveal reward moment (MYT-89 §3.8, Task D6).
// Four headline behaviors, each a brief-pinned requirement:
//   1. THE WALK: on `play`, the timeline runs hold → gust → settle → resolve →
//      done at the named timings and ENDS in the same state a never-played
//      mount renders (the 3-phase end-state assertion).
//   2. REDUCED MOTION: no walk — `done` (layout final, fog denominator already
//      drained) from the first frame, a one-shot ~300ms surface fade, and the
//      IDENTICAL end state.
//   3. PLAYS ONCE: the first `play` latches. `play` flipping false mid-walk
//      (the route's world_ready flip) never reverses it; flipping true again
//      after completion never replays. A mount that never sees `play` renders
//      the final state immediately (the late arriver).
//   4. SKIP: any pointer-down / key-down mid-moment lands in `done` with
//      `instant` set (consumers cut their transitions), onDone fires once, and
//      the abandoned timeline never fires afterwards.
// The timeline is driven by fake timers — no real-time sleeps anywhere.

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

/** Render the transition with a probe child that records every moment it saw. */
function renderMoment(props: { play: boolean; reducedMotion?: boolean; onDone?: () => void }) {
  const seen: RevealMoment[] = []
  const utils = render(
    <RevealTransition data-testid="moment" {...props}>
      {(moment) => {
        seen.push(moment)
        return <output data-testid="probe">{`${moment.phase}:${String(moment.instant)}`}</output>
      }}
    </RevealTransition>,
  )
  return { seen, ...utils }
}

const probe = (): string => screen.getByTestId('probe').textContent
const phaseAttr = (): string | null => screen.getByTestId('moment').getAttribute('data-reveal-phase')

const advance = (ms: number): void => {
  act(() => {
    vi.advanceTimersByTime(ms)
  })
}

describe('RevealTransition — the walk (play, motion)', () => {
  it('walks hold → gust → settle → resolve → done at the named timings and fires onDone once', () => {
    const onDone = vi.fn()
    renderMoment({ play: true, onDone })
    expect(probe()).toBe('hold:false')
    expect(phaseAttr()).toBe('hold')
    advance(REVEAL_HOLD_MS)
    expect(probe()).toBe('gust:false')
    advance(REVEAL_GUST_MS)
    expect(probe()).toBe('settle:false')
    advance(REVEAL_SETTLE_MS)
    expect(probe()).toBe('resolve:false')
    expect(onDone).not.toHaveBeenCalled()
    advance(REVEAL_RESOLVE_MS)
    expect(probe()).toBe('done:false')
    expect(phaseAttr()).toBe('done')
    expect(onDone).toHaveBeenCalledOnce()
    // Nothing left on the clock — the moment is over, no stray transitions.
    advance(60_000)
    expect(probe()).toBe('done:false')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('renders the final state immediately for a mount that never plays (the late arriver)', () => {
    const onDone = vi.fn()
    renderMoment({ play: false, onDone })
    expect(probe()).toBe('done:true')
    advance(60_000)
    expect(probe()).toBe('done:true')
    // The moment never played, so it never "ends" — no completion signal.
    expect(onDone).not.toHaveBeenCalled()
  })
})

describe('RevealTransition — reduced motion', () => {
  it('reaches the identical end state with no walk: done from the first frame, a one-shot fade', () => {
    const onDone = vi.fn()
    renderMoment({ play: true, reducedMotion: true, onDone })
    // Layout final immediately — never an intermediate phase.
    expect(phaseAttr()).toBe('done')
    // The surface fade: starts transparent, flips visible on the next tick.
    const wrapper = screen.getByTestId('moment')
    expect(wrapper.className).toContain('opacity-0')
    advance(0)
    expect(wrapper.className).toContain('opacity-100')
    expect(onDone).not.toHaveBeenCalled()
    advance(REVEAL_REDUCED_FADE_MS)
    expect(onDone).toHaveBeenCalledOnce()
    expect(probe()).toBe('done:false')
  })
})

describe('RevealTransition — plays exactly once', () => {
  it('holds the walk when play flips false mid-moment (the world_ready flip)', () => {
    const onDone = vi.fn()
    const { rerender } = render(
      <RevealTransition data-testid="moment" play onDone={onDone}>
        {(moment) => <output data-testid="probe">{`${moment.phase}:${String(moment.instant)}`}</output>}
      </RevealTransition>,
    )
    advance(REVEAL_HOLD_MS)
    expect(probe()).toBe('gust:false')
    rerender(
      <RevealTransition data-testid="moment" play={false} onDone={onDone}>
        {(moment) => <output data-testid="probe">{`${moment.phase}:${String(moment.instant)}`}</output>}
      </RevealTransition>,
    )
    // Neither reversed nor restarted — the walk continues from where it was.
    expect(probe()).toBe('gust:false')
    advance(REVEAL_GUST_MS + REVEAL_SETTLE_MS + REVEAL_RESOLVE_MS)
    expect(probe()).toBe('done:false')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('never replays: a fresh play=true after completion (a tail-stage flip) stays done', () => {
    const onDone = vi.fn()
    const { rerender } = render(
      <RevealTransition data-testid="moment" play onDone={onDone}>
        {(moment) => <output data-testid="probe">{moment.phase}</output>}
      </RevealTransition>,
    )
    advance(REVEAL_HOLD_MS + REVEAL_GUST_MS + REVEAL_SETTLE_MS + REVEAL_RESOLVE_MS)
    expect(probe()).toBe('done')
    rerender(
      <RevealTransition data-testid="moment" play={false} onDone={onDone}>
        {(moment) => <output data-testid="probe">{moment.phase}</output>}
      </RevealTransition>,
    )
    rerender(
      <RevealTransition data-testid="moment" play onDone={onDone}>
        {(moment) => <output data-testid="probe">{moment.phase}</output>}
      </RevealTransition>,
    )
    expect(probe()).toBe('done')
    advance(60_000)
    expect(probe()).toBe('done')
    expect(onDone).toHaveBeenCalledOnce()
  })
})

describe('RevealTransition — skip', () => {
  it('a mid-moment pointer-down lands in done+instant, onDone fires once, the timeline is dead', () => {
    const onDone = vi.fn()
    renderMoment({ play: true, onDone })
    advance(REVEAL_HOLD_MS)
    expect(probe()).toBe('gust:false')
    act(() => {
      fireEvent.pointerDown(document.body)
    })
    expect(probe()).toBe('done:true')
    expect(onDone).toHaveBeenCalledOnce()
    // The abandoned walk never fires: no phase regression, no double onDone.
    advance(60_000)
    expect(probe()).toBe('done:true')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('a mid-moment key-down skips the same way', () => {
    const onDone = vi.fn()
    renderMoment({ play: true, onDone })
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Enter' })
    })
    expect(probe()).toBe('done:true')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('fires the skip once when a pointer-down and key-down land in the same tick', () => {
    const onDone = vi.fn()
    renderMoment({ play: true, onDone })
    advance(REVEAL_HOLD_MS)
    expect(probe()).toBe('gust:false')
    // Both skip triggers in ONE synchronous tick — before React re-renders and
    // the effect tears the window listeners down. The settled state hasn't
    // committed yet, so the closure guard is what collapses them to a single
    // landing (raw dispatch, not two fireEvent calls, to keep it one tick).
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      document.body.dispatchEvent(new Event('keydown', { bubbles: true }))
    })
    expect(probe()).toBe('done:true')
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('does not swallow the skipping tap — what was under it still receives it', () => {
    const onDone = vi.fn()
    const onUnder = vi.fn()
    render(
      <RevealTransition data-testid="moment" play onDone={onDone}>
        {(m) => (
          <button type="button" data-testid="under" onPointerDown={onUnder}>
            {`${m.phase}:${String(m.instant)}`}
          </button>
        )}
      </RevealTransition>,
    )
    advance(REVEAL_HOLD_MS)
    expect(screen.getByTestId('under').textContent).toBe('gust:false')
    act(() => {
      fireEvent.pointerDown(screen.getByTestId('under'))
    })
    // The window-capture skip listens without preventDefault (§3.8: "the event
    // is never swallowed"), so the SAME tap both lands the skip AND reaches the
    // control it fell on.
    expect(screen.getByTestId('under').textContent).toBe('done:true')
    expect(onUnder).toHaveBeenCalledOnce()
    expect(onDone).toHaveBeenCalledOnce()
  })

  it('after the moment ends, interactions no longer touch it', () => {
    const onDone = vi.fn()
    renderMoment({ play: true, onDone })
    advance(REVEAL_HOLD_MS + REVEAL_GUST_MS + REVEAL_SETTLE_MS + REVEAL_RESOLVE_MS)
    expect(probe()).toBe('done:false')
    act(() => {
      fireEvent.pointerDown(document.body)
    })
    // A natural completion is not retroactively marked as a skip.
    expect(probe()).toBe('done:false')
    expect(onDone).toHaveBeenCalledOnce()
  })
})

// ── RevealPanes — the desktop layout arrival ─────────────────────────────────

const moment = (phase: RevealMoment['phase'], instant = false): RevealMoment => ({ phase, instant })

function renderPanes(m: RevealMoment) {
  return render(
    <RevealPanes
      data-testid="panes"
      moment={m}
      stage={<div data-testid="stage-content" />}
      panel={<div data-testid="panel-content" />}
    />,
  )
}

describe('RevealPanes', () => {
  const slideOf = (): HTMLElement | null | undefined =>
    screen.getByTestId('panel-content').parentElement
  const panelCellOf = (): HTMLElement | null | undefined => slideOf()?.parentElement

  it('gives the stage the full width before resolve: panel cell collapsed, slide off-right', () => {
    renderPanes(moment('gust'))
    const panes = screen.getByTestId('panes')
    expect(panes.style.columnGap).toBe('0px')
    expect(panelCellOf()?.style.flexGrow).toBe('0')
    // The panel is mounted throughout (it slides in; it does not pop into
    // existence), laid out at its FINAL width (no re-wrap), translated fully
    // past the clipping cell.
    expect(slideOf()?.style.transform).toBe('translateX(100%)')
    expect(slideOf()?.style.width).not.toBe('')
  })

  it('re-seats the cells and slides the panel in at resolve', () => {
    renderPanes(moment('resolve'))
    const panes = screen.getByTestId('panes')
    // The seat is a one-step flip (a width-eased canvas would blank the world);
    // the arrival MOTION is the panel's transform slide.
    expect(panes.style.columnGap).toBe('var(--space-4)')
    expect(panelCellOf()?.style.flexGrow).toBe('1')
    expect(slideOf()?.style.transform).toBe('translateX(0)')
    expect(slideOf()?.style.transition).toContain('transform')
  })

  it('lands on the true 50/50 at done: equal-grow min-width-0 cells, every moment style dropped', () => {
    renderPanes(moment('done'))
    const panes = screen.getByTestId('panes')
    expect(panes.style.columnGap).toBe('var(--space-4)')
    const stageCell = screen.getByTestId('stage-content').parentElement
    expect(stageCell?.className).toContain('min-w-0')
    expect(panelCellOf()?.className).toContain('min-w-0')
    expect(panelCellOf()?.style.flexGrow).toBe('1')
    // Natural responsive layout from here on — no fixed width, no transform.
    expect(slideOf()?.style.width).toBe('')
    expect(slideOf()?.style.transform).toBe('')
  })

  it('cuts the transition on an instant moment (skip / never-played)', () => {
    renderPanes(moment('resolve', true))
    expect(slideOf()?.style.transition).toBe('none')
  })

  it('owns the vertical space: a viewport-derived row height, full-height panel chain (audit v3)', () => {
    // The row (not the graph pane) carries the height, so BOTH halves get one
    // definite height: the graph fills it (fillHost) and the wiki caps to it
    // (max-h-full) and scrolls internally — page length never drives the row.
    renderPanes(moment('done'))
    const panes = screen.getByTestId('panes')
    expect(panes.className).toMatch(/h-\[clamp\(.*100dvh.*\)\]/)
    // The slide wrapper spans the cell's height in EVERY phase (the wiki's
    // max-h-full must bind mid-slide and at done alike).
    expect(slideOf()?.className).toContain('h-full')
  })
})

// ── RevealFade — phase-keyed chrome fades ────────────────────────────────────

describe('RevealFade', () => {
  it('is transparent before its phase and visible from it (space always reserved)', () => {
    const { rerender } = render(
      <RevealFade data-testid="fade" moment={moment('gust')} visibleFrom="settle">
        <h1>title</h1>
      </RevealFade>,
    )
    const fade = screen.getByTestId('fade')
    expect(fade.className).toContain('opacity-0')
    // The content is in the tree (and the a11y tree) the whole time.
    expect(screen.getByRole('heading', { name: 'title' })).toBeDefined()
    rerender(
      <RevealFade data-testid="fade" moment={moment('settle')} visibleFrom="settle">
        <h1>title</h1>
      </RevealFade>,
    )
    expect(fade.className).toContain('opacity-100')
    rerender(
      <RevealFade data-testid="fade" moment={moment('done')} visibleFrom="settle">
        <h1>title</h1>
      </RevealFade>,
    )
    expect(fade.className).toContain('opacity-100')
  })

  it('cuts the transition on an instant moment', () => {
    render(
      <RevealFade data-testid="fade" moment={moment('done', true)} visibleFrom="resolve">
        <p>prompt</p>
      </RevealFade>,
    )
    expect(screen.getByTestId('fade').style.transition).toBe('none')
  })
})
