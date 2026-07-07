import { describe, expect, it, vi } from 'vitest'
import type { ForceSim } from '@mythrun/client-core/worldgen'
import type { GraphNode } from '@mythrun/client-core/contract'
import {
  createCameraController,
  FOLLOW_IDLE_MS,
  FOLLOW_TAU_MS,
  type CameraDeps,
} from '../camera-state.ts'
import type { Point } from '../canvas-draw.ts'

// The ONE camera over the world-gen virtual space (MYT-89 T1b — the pannable mobile
// viewport). These tests pin the controller's contract: engage-centres / disengage-
// resets, client-px pan mapping + world-edge clamping, the idempotent per-timestamp
// drift advance (the C5 one-camera guarantee across the two render loops), the
// manual-pan → idle-window → auto-follow-resume arc, the newest-arrival targeting,
// the reduced-motion snap, and the static-repaint subscription seam.

const WORLD = { width: 700, height: 1200 }
const VIEW = { width: 343, height: 600 }
const ENGAGED = { world: WORLD, view: VIEW, engaged: true }
const IDENTITY = { world: VIEW, view: VIEW, engaged: false }

const node = (synthKey: string, displayId = synthKey): GraphNode => ({
  synthKey,
  kind: 'npc',
  name: synthKey,
  displayId,
  state: 'live',
  lastEventIndex: 0,
})

/** A minimal sim stub: just the positions() the follow target resolves through. */
function stubSim(positions: Map<string, Point>): ForceSim {
  return { positions: () => positions } as unknown as ForceSim
}

/** Build deps around mutable refs (the hook's useLatest idiom) + a fake clock. */
function makeDeps(overrides?: Partial<CameraDeps>): CameraDeps & { clock: { t: number } } {
  const clock = { t: 0 }
  return {
    worldRef: { current: WORLD },
    viewRef: { current: VIEW },
    reducedRef: { current: false },
    nodesRef: { current: [] },
    simRef: { current: null },
    sizeRef: { current: { cssW: VIEW.width, cssH: VIEW.height } },
    now: () => clock.t,
    clock,
    ...overrides,
  }
}

describe('camera engage/disengage (syncBounds)', () => {
  it('centres the camera on the world at the moment of first engage', () => {
    const ctl = createCameraController(makeDeps())
    ctl.syncBounds(ENGAGED)
    expect(ctl.engaged()).toBe(true)
    expect(ctl.read()).toEqual({ x: (700 - 343) / 2, y: (1200 - 600) / 2 })
  })

  it('holds (clamped) the camera position across a grow while engaged — no recentre', () => {
    const ctl = createCameraController(makeDeps())
    ctl.syncBounds(ENGAGED)
    ctl.panBy(100, 100) // move off-centre
    const held = ctl.read()
    ctl.syncBounds({ world: { width: 800, height: 1400 }, view: VIEW, engaged: true })
    expect(ctl.read()).toEqual(held) // bounds only grew — the position holds exactly
  })

  it('resets to identity {0,0} on disengage', () => {
    const ctl = createCameraController(makeDeps())
    ctl.syncBounds(ENGAGED)
    ctl.syncBounds(IDENTITY)
    expect(ctl.engaged()).toBe(false)
    expect(ctl.read()).toEqual({ x: 0, y: 0 })
  })

  it('notifies static subscribers when the camera moves', () => {
    const ctl = createCameraController(makeDeps())
    const listener = vi.fn()
    ctl.source.subscribe(listener)
    ctl.syncBounds(ENGAGED) // the engage recentre is a camera move
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('manual pan (panBy)', () => {
  it('maps a client-px drag to view units, moving the world WITH the finger', () => {
    // The pane is 1:1 with the view here — dragging the finger right by 50 shows
    // world further LEFT: the camera x decreases by 50.
    const ctl = createCameraController(makeDeps())
    ctl.syncBounds(ENGAGED)
    const start = ctl.read()
    ctl.panBy(50, -20)
    expect(ctl.read()).toEqual({ x: start.x - 50, y: start.y + 20 })
  })

  it('scales the delta when the pane is CSS-upscaled from the view', () => {
    // A 686-CSS-px pane over the 343-wide view: 2 client px = 1 view px.
    const deps = makeDeps({ sizeRef: { current: { cssW: 686, cssH: 1200 } } })
    const ctl = createCameraController(deps)
    ctl.syncBounds(ENGAGED)
    const start = ctl.read()
    ctl.panBy(100, 0)
    expect(ctl.read().x).toBeCloseTo(start.x - 50, 10)
  })

  it('clamps at the world edges (the pan stops at the margin)', () => {
    const ctl = createCameraController(makeDeps())
    ctl.syncBounds(ENGAGED)
    ctl.panBy(100_000, 100_000) // fling far past the top-left corner
    expect(ctl.read()).toEqual({ x: 0, y: 0 })
    ctl.panBy(-100_000, -100_000) // …and past the bottom-right
    expect(ctl.read()).toEqual({ x: 700 - 343, y: 1200 - 600 })
  })

  it('is inert while disengaged (the world fits the pane)', () => {
    const ctl = createCameraController(makeDeps())
    ctl.syncBounds(IDENTITY)
    ctl.panBy(50, 50)
    expect(ctl.read()).toEqual({ x: 0, y: 0 })
  })

  it('notifies static subscribers per pan (the reduced-motion repaint seam)', () => {
    const ctl = createCameraController(makeDeps())
    ctl.syncBounds(ENGAGED)
    const listener = vi.fn()
    const unsubscribe = ctl.source.subscribe(listener)
    ctl.panBy(10, 0)
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
    ctl.panBy(10, 0)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('auto-follow drift (source.current)', () => {
  /** Deps with one node at the world centre-right and a live sim. */
  function followDeps(): ReturnType<typeof makeDeps> {
    const deps = makeDeps()
    deps.nodesRef.current = [node('n/new')]
    deps.simRef.current = stubSim(new Map([['n/new', { x: 100, y: 200 }]]))
    return deps
  }

  it('drifts toward the newest arrival by the eased step (a camera, not a snap)', () => {
    const ctl = createCameraController(followDeps())
    ctl.syncBounds(ENGAGED)
    ctl.trackArrivals([node('n/new')])
    const start = ctl.read()
    // Target: node at centred (100, 200) → world (450, 800) → camera (278.5, 500).
    ctl.source.current(0) // first frame stamps the clock (dt 0 — no move)
    expect(ctl.source.current(0)).toEqual(start) // idempotent per timestamp
    const after = ctl.source.current(FOLLOW_TAU_MS) // one τ later
    const frac = 1 - Math.exp(-1)
    expect(after.x).toBeCloseTo(start.x + (278.5 - start.x) * frac, 6)
    expect(after.y).toBeCloseTo(start.y + (500 - start.y) * frac, 6)
  })

  it('advances AT MOST ONCE per distinct timestamp — both layers read one camera (C5)', () => {
    const ctl = createCameraController(followDeps())
    ctl.syncBounds(ENGAGED)
    ctl.trackArrivals([node('n/new')])
    ctl.source.current(0)
    const graphRead = ctl.source.current(16.7) // the graph loop's frame
    const fogRead = ctl.source.current(16.7) // the fog loop, same rAF timestamp
    expect(fogRead).toEqual(graphRead)
  })

  it('defers to a manual pan and resumes after the idle window', () => {
    const deps = followDeps()
    const ctl = createCameraController(deps)
    ctl.syncBounds(ENGAGED)
    ctl.trackArrivals([node('n/new')])
    ctl.source.current(0)
    deps.clock.t = 1000
    ctl.panBy(10, 0) // the user's hand takes the camera at t=1000
    const held = ctl.read()
    // Inside the idle window: no drift.
    expect(ctl.source.current(1000 + FOLLOW_IDLE_MS - 500)).toEqual(held)
    // Past the window: the drift resumes.
    const resumed = ctl.source.current(1000 + FOLLOW_IDLE_MS + 500)
    expect(resumed).not.toEqual(held)
  })

  it('never drifts under reduced motion (no continuous animation)', () => {
    const deps = followDeps()
    deps.reducedRef.current = true
    const ctl = createCameraController(deps)
    ctl.syncBounds(ENGAGED)
    ctl.trackArrivals([node('n/new')])
    ctl.source.current(0)
    expect(ctl.source.current(10_000)).toEqual(ctl.read())
  })

  it('holds still with no follow target / no placed position', () => {
    const ctl = createCameraController(makeDeps()) // no nodes, no sim
    ctl.syncBounds(ENGAGED)
    const start = ctl.read()
    ctl.source.current(0)
    expect(ctl.source.current(5000)).toEqual(start)
  })
})

describe('arrival targeting + the reduced-motion snap', () => {
  it('targets the LAST genuinely-new node; re-syncs of survivors do not retarget', () => {
    const deps = makeDeps()
    deps.simRef.current = stubSim(
      new Map([
        ['a', { x: -300, y: -500 }],
        ['b', { x: 100, y: 200 }],
      ]),
    )
    deps.nodesRef.current = [node('a'), node('b')]
    const ctl = createCameraController(deps)
    ctl.syncBounds(ENGAGED)
    ctl.trackArrivals([node('a'), node('b')]) // b is the newest
    ctl.snapToTarget()
    // b at centred (100, 200) → world (450, 800) → camera (278.5, 500).
    expect(ctl.read()).toEqual({ x: 278.5, y: 500 })
    ctl.trackArrivals([node('a'), node('b')]) // nothing new — target stays b
    ctl.panBy(-1000, -1000) // move away…
    ctl.snapToTarget() // …and the snap still lands on b
    expect(ctl.read()).toEqual({ x: 278.5, y: 500 })
  })

  it('resolves the target across a finalize (synthKey stable, displayId swapped)', () => {
    const deps = makeDeps()
    const ctl = createCameraController(deps)
    ctl.syncBounds(ENGAGED)
    deps.nodesRef.current = [node('s/x')]
    ctl.trackArrivals(deps.nodesRef.current)
    // Finalize: the same synthKey now wears a UUID displayId; positions re-key.
    deps.nodesRef.current = [node('s/x', 'uuid-1')]
    deps.simRef.current = stubSim(new Map([['uuid-1', { x: 100, y: 200 }]]))
    ctl.snapToTarget()
    expect(ctl.read()).toEqual({ x: 278.5, y: 500 })
  })

  it('snapToTarget notifies (the static fog/graph repaint), and no-ops with no target', () => {
    const deps = makeDeps()
    deps.nodesRef.current = [node('n/new')]
    deps.simRef.current = stubSim(new Map([['n/new', { x: 100, y: 200 }]]))
    const ctl = createCameraController(deps)
    ctl.syncBounds(ENGAGED)
    const listener = vi.fn()
    ctl.source.subscribe(listener)
    ctl.snapToTarget() // no target yet — silent
    expect(listener).not.toHaveBeenCalled()
    ctl.trackArrivals(deps.nodesRef.current)
    ctl.snapToTarget()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
