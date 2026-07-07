import { describe, expect, it, vi } from 'vitest'
import { VIRTUAL_HEIGHT, VIRTUAL_WIDTH, type ForceSim } from '@mythrun/client-core/worldgen'
import { attachPointerHandlers, attachTapHandlers, type PointerDeps } from '../pointer-handlers.ts'
import type { Point } from '../canvas-draw.ts'

// MYT-89 audit #5 (drag live during generation). The pointer effect used to gate BOTH
// drag and select on `interactive` (false during generation) — so the graph was un-
// draggable while streaming. The fix attaches the handlers whenever motion + a fine
// pointer are present, and gates ONLY the tap-to-select `onSelect` call on `interactive`.
// These tests drive `attachPointerHandlers` directly: jsdom can't run the pointer-capture
// effect (no real fine-pointer / pointer-capture), so we capture the handlers off a stub
// canvas and invoke them. A drag PINS (pushes the fog) in both phases; a click SELECTS
// only in the reveal.

type Handler = (event: PointerEvent) => void

/** A stub canvas that captures the four pointer handlers instead of touching the DOM (and
 *  reports a 900×470 CSS box so a client point maps 1:1 into the centred virtual space),
 *  plus a `fire(type, event)` that dispatches to the captured handler (throwing if absent —
 *  so a missing attach is a hard failure, not a silent no-op). */
function stubCanvas(): {
  canvas: HTMLCanvasElement
  handlers: Record<string, Handler>
  fire: (type: string, event: PointerEvent) => void
} {
  const handlers: Record<string, Handler> = {}
  const fire = (type: string, event: PointerEvent): void => {
    const handler = handlers[type]
    if (handler === undefined) throw new Error(`no handler attached for ${type}`)
    handler(event)
  }
  const canvas = {
    addEventListener: (type: string, handler: Handler) => {
      handlers[type] = handler
    },
    removeEventListener: () => undefined,
    setPointerCapture: () => undefined,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: VIRTUAL_WIDTH,
      bottom: VIRTUAL_HEIGHT,
      width: VIRTUAL_WIDTH,
      height: VIRTUAL_HEIGHT,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLCanvasElement
  return { canvas, handlers, fire }
}

/** A minimal ForceSim stub: a fixed position map + spies for `pin`/`unpin`. */
function stubSim(positions: Map<string, Point>): {
  sim: ForceSim
  pin: ReturnType<typeof vi.fn>
  unpin: ReturnType<typeof vi.fn>
} {
  const pin = vi.fn()
  const unpin = vi.fn()
  const sim = { positions: () => positions, pin, unpin } as unknown as ForceSim
  return { sim, pin, unpin }
}

/** A pointer event carrying only the fields the handlers read. */
function ptr(clientX: number, clientY: number): PointerEvent {
  return { clientX, clientY, pointerId: 1 } as unknown as PointerEvent
}

/** Build the PointerDeps for the given sim / onSelect / interactive flag. The world +
 *  view dims match the CSS box (the pane-adaptive space at a reference-sized pane, the
 *  camera disengaged at identity), so the client→virtual mapping stays 1:1 for these
 *  tests. `setFocus` / `panBy` / `deferFollow` are spies — the density redesign's
 *  name-reveal seam + the T1b camera seam. `engaged` flips the camera on (the world
 *  larger than the pane — drags pan). */
function deps(
  sim: ForceSim,
  onSelect: (id: string) => void,
  interactive: boolean,
  setFocus: (id: string | null) => void = vi.fn(),
  options?: { engaged?: boolean; panBy?: (dx: number, dy: number) => void; deferFollow?: () => void },
): PointerDeps {
  return {
    getSim: () => sim,
    sizeRef: { current: { cssW: VIRTUAL_WIDTH, cssH: VIRTUAL_HEIGHT } },
    virtualRef: { current: { width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT } },
    viewRef: { current: { width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT } },
    readCamera: () => ({ x: 0, y: 0 }),
    isEngaged: () => options?.engaged ?? false,
    panBy: options?.panBy ?? vi.fn(),
    deferFollow: options?.deferFollow ?? vi.fn(),
    hoverRef: { current: null },
    dragRef: { current: null },
    onSelectRef: { current: onSelect },
    interactiveRef: { current: interactive },
    setFocus,
  }
}

// A single node at the centred origin — a client point at the pane centre (450, 235) maps
// to local (0, 0), landing on it within the hit radius.
const NODE_POSITIONS = new Map<string, Point>([['n1', { x: 0, y: 0 }]])
const CENTRE = { x: VIRTUAL_WIDTH / 2, y: VIRTUAL_HEIGHT / 2 } // (450, 235)

describe('attachPointerHandlers — drag lives during generation (MYT-89 audit #5)', () => {
  it('attaches all four pointer handlers', () => {
    const { canvas, handlers } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    attachPointerHandlers(canvas, deps(sim, vi.fn(), false))
    expect(Object.keys(handlers).sort()).toEqual(['pointerdown', 'pointerleave', 'pointermove', 'pointerup'])
  })

  it('a DRAG pins the node (pushes the fog) even when NOT interactive (generation)', () => {
    const { canvas, fire } = stubCanvas()
    const { sim, pin, unpin } = stubSim(NODE_POSITIONS)
    const onSelect = vi.fn()
    attachPointerHandlers(canvas, deps(sim, onSelect, false))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y)) // grab n1
    fire('pointermove', ptr(CENTRE.x + 15, CENTRE.y)) // move past the 4px drag threshold
    fire('pointerup', ptr(CENTRE.x + 15, CENTRE.y))

    expect(pin).toHaveBeenCalledWith('n1', 15, 0) // dragged to local (15, 0)
    expect(onSelect).not.toHaveBeenCalled() // a drag never selects
    expect(unpin).not.toHaveBeenCalled() // …and a moved drag doesn't release
  })

  it('a CLICK does NOT select during generation (!interactive) — only releases any pin', () => {
    const { canvas, fire } = stubCanvas()
    const { sim, pin, unpin } = stubSim(NODE_POSITIONS)
    const onSelect = vi.fn()
    attachPointerHandlers(canvas, deps(sim, onSelect, false))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x, CENTRE.y)) // no move → a click

    expect(pin).not.toHaveBeenCalled()
    expect(unpin).toHaveBeenCalledWith('n1') // a tap always releases a prior pin
    expect(onSelect).not.toHaveBeenCalled() // …but selection is reveal-only
  })

  it('a CLICK selects in the reveal (interactive) — the gated path fires onSelect', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const onSelect = vi.fn()
    attachPointerHandlers(canvas, deps(sim, onSelect, true))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x, CENTRE.y))

    expect(onSelect).toHaveBeenCalledExactlyOnceWith('n1')
  })

  it('a DRAG pins in the reveal too (interactive) — drag is never the select path', () => {
    const { canvas, fire } = stubCanvas()
    const { sim, pin } = stubSim(NODE_POSITIONS)
    const onSelect = vi.fn()
    attachPointerHandlers(canvas, deps(sim, onSelect, true))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointermove', ptr(CENTRE.x + 20, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x + 20, CENTRE.y))

    expect(pin).toHaveBeenCalledWith('n1', 20, 0)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('a CLICK focuses the node (name reveal) — in both phases; empty press clears', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const setFocus = vi.fn()
    attachPointerHandlers(canvas, deps(sim, vi.fn(), false, setFocus))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x, CENTRE.y)) // a click → focus n1
    expect(setFocus).toHaveBeenCalledExactlyOnceWith('n1')

    fire('pointerdown', ptr(CENTRE.x + 300, CENTRE.y)) // far from any node → clears
    expect(setFocus).toHaveBeenLastCalledWith(null)
  })

  it('a DRAG never focuses (the name reveal is a deliberate tap, not a fling)', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const setFocus = vi.fn()
    attachPointerHandlers(canvas, deps(sim, vi.fn(), false, setFocus))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointermove', ptr(CENTRE.x + 20, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x + 20, CENTRE.y))
    expect(setFocus).not.toHaveBeenCalled()
  })

  it('camera ENGAGED: a drag from EMPTY fog pans the camera (node drag keeps priority)', () => {
    const { canvas, fire } = stubCanvas()
    const { sim, pin } = stubSim(NODE_POSITIONS)
    const panBy = vi.fn()
    attachPointerHandlers(canvas, deps(sim, vi.fn(), false, vi.fn(), { engaged: true, panBy }))

    fire('pointerdown', ptr(CENTRE.x + 300, CENTRE.y)) // empty fog — arms the camera drag
    fire('pointermove', ptr(CENTRE.x + 320, CENTRE.y + 10))
    expect(panBy).toHaveBeenCalledExactlyOnceWith(20, 10)
    expect(pin).not.toHaveBeenCalled()
    fire('pointerup', ptr(CENTRE.x + 320, CENTRE.y + 10))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y)) // a glyph hit — the NODE drag wins
    fire('pointermove', ptr(CENTRE.x + 15, CENTRE.y))
    expect(pin).toHaveBeenCalledWith('n1', 15, 0)
    expect(panBy).toHaveBeenCalledTimes(1) // no further pans
  })

  it('camera DISENGAGED: an empty-fog drag pans nothing (desktop unchanged)', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const panBy = vi.fn()
    attachPointerHandlers(canvas, deps(sim, vi.fn(), false, vi.fn(), { engaged: false, panBy }))

    fire('pointerdown', ptr(CENTRE.x + 300, CENTRE.y))
    fire('pointermove', ptr(CENTRE.x + 340, CENTRE.y))
    expect(panBy).not.toHaveBeenCalled()
  })

  it('a NODE drag defers the auto-follow (the hand owns the view — T1b)', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const deferFollow = vi.fn()
    attachPointerHandlers(canvas, deps(sim, vi.fn(), false, vi.fn(), { engaged: true, deferFollow }))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointermove', ptr(CENTRE.x + 15, CENTRE.y))
    expect(deferFollow).toHaveBeenCalled()
  })
})

// ── The TAP+PAN surface (density redesign mobile + the T1b camera) ─────────────────────
// Touch used to be gated off entirely (canvas drag fights page scroll). Camera
// DISENGAGED (the world fits the pane) the shipped tap-only behaviour holds:
// pointerdown/up with a movement-slop gate, NO capture, NO preventDefault, panning
// inert — a scroll gesture travels past the slop (or fires pointercancel) and is
// ignored, so the page scrolls as if the canvas weren't there, while a genuine TAP
// focuses the glyph. Camera ENGAGED (T1b — the world larger than the pane; the hook
// also sets `touch-action: none`): the canvas owns touch — a one-finger drag PANS the
// camera, and a press within the slop stays a tap.

describe('attachTapHandlers — coarse-pointer tap + camera pan', () => {
  it('attaches down/move/up/cancel (the move handler is inert while disengaged)', () => {
    const { canvas, handlers } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    attachTapHandlers(canvas, deps(sim, vi.fn(), false))
    expect(Object.keys(handlers).sort()).toEqual(['pointercancel', 'pointerdown', 'pointermove', 'pointerup'])
  })

  it('camera DISENGAGED: movement past the slop never pans (the page owns the scroll)', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const panBy = vi.fn()
    attachTapHandlers(canvas, deps(sim, vi.fn(), false, vi.fn(), { engaged: false, panBy }))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointermove', ptr(CENTRE.x + 40, CENTRE.y))
    fire('pointermove', ptr(CENTRE.x + 80, CENTRE.y))
    expect(panBy).not.toHaveBeenCalled()
  })

  it('camera ENGAGED: a drag past the slop PANS by incremental deltas, rebased at the slop edge', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const panBy = vi.fn()
    const setFocus = vi.fn()
    attachTapHandlers(canvas, deps(sim, vi.fn(), false, setFocus, { engaged: true, panBy }))

    fire('pointerdown', ptr(100, 100))
    fire('pointermove', ptr(103, 100)) // inside the slop — not yet a pan
    expect(panBy).not.toHaveBeenCalled()
    fire('pointermove', ptr(120, 100)) // past the slop — the pan ARMS here (no jump)
    expect(panBy).not.toHaveBeenCalled()
    fire('pointermove', ptr(135, 110)) // …and pans by the delta since the arm point
    expect(panBy).toHaveBeenCalledExactlyOnceWith(15, 10)
    fire('pointerup', ptr(135, 110)) // a pan never taps
    expect(setFocus).not.toHaveBeenCalled()
  })

  it('camera ENGAGED: a press within the slop is still a TAP (focus + reveal select)', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const onSelect = vi.fn()
    const setFocus = vi.fn()
    attachTapHandlers(canvas, deps(sim, onSelect, true, setFocus, { engaged: true }))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointermove', ptr(CENTRE.x + 3, CENTRE.y)) // sub-slop jitter
    fire('pointerup', ptr(CENTRE.x + 3, CENTRE.y))
    expect(setFocus).toHaveBeenCalledExactlyOnceWith('n1')
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('n1')
  })

  it('a TAP on a glyph focuses it; a tap on empty fog clears the focus', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const setFocus = vi.fn()
    attachTapHandlers(canvas, deps(sim, vi.fn(), false, setFocus))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x, CENTRE.y))
    expect(setFocus).toHaveBeenCalledExactlyOnceWith('n1')

    fire('pointerdown', ptr(CENTRE.x + 300, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x + 300, CENTRE.y))
    expect(setFocus).toHaveBeenLastCalledWith(null)
  })

  it('a SCROLL (movement past the slop) is ignored — never a focus', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const setFocus = vi.fn()
    attachTapHandlers(canvas, deps(sim, vi.fn(), false, setFocus))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x, CENTRE.y + 40)) // the finger travelled — a scroll
    expect(setFocus).not.toHaveBeenCalled()
  })

  it('pointercancel (the browser took the gesture) voids the press', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const setFocus = vi.fn()
    attachTapHandlers(canvas, deps(sim, vi.fn(), false, setFocus))

    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointercancel', ptr(CENTRE.x, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x, CENTRE.y))
    expect(setFocus).not.toHaveBeenCalled()
  })

  it('a tap selects in the reveal (interactive) but never during generation', () => {
    const { canvas, fire } = stubCanvas()
    const { sim } = stubSim(NODE_POSITIONS)
    const onSelect = vi.fn()
    attachTapHandlers(canvas, deps(sim, onSelect, true))
    fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    fire('pointerup', ptr(CENTRE.x, CENTRE.y))
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('n1')

    const gen = stubCanvas()
    const genSelect = vi.fn()
    attachTapHandlers(gen.canvas, deps(sim, genSelect, false))
    gen.fire('pointerdown', ptr(CENTRE.x, CENTRE.y))
    gen.fire('pointerup', ptr(CENTRE.x, CENTRE.y))
    expect(genSelect).not.toHaveBeenCalled()
  })
})
