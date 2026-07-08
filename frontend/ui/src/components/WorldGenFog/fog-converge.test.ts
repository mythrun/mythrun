import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FogObstacle } from '@mythrun/client-core/worldgen'
import { createFogConvergence, type ConvergeRequest } from './fog-converge.ts'

// The reduced-motion background convergence (myth-9w7mw): after the instant seeded
// paint, the settle's remaining sub-steps run as CHUNKED macrotasks off the paint
// path — real physics, real low-pass — and the completion repaint shows the genuinely
// converged field. These tests drive the scheduler with fake timers and a recording
// stub sim: the chunk cadence, the exact step budget, the live-scale read, the
// supersede-on-new-settle semantics, and cancellation.

const STEP_MS = 1000 / 60

function ob(x: number): FogObstacle {
  return { x, y: 0, w: 10, h: 10, vx: 0, vy: 0 }
}

interface Recorded {
  obstacles: readonly FogObstacle[]
  scale: number
}

function harness(budget: number, chunkSteps: number): {
  steps: Recorded[]
  subSteps: () => number
  request: (over?: Partial<ConvergeRequest>) => { onDone: ReturnType<typeof vi.fn> }
  cancel: () => void
} {
  const steps: Recorded[] = []
  let subSteps = 0
  const worker = createFogConvergence({ stepMs: STEP_MS, budget, chunkSteps })
  const request = (over?: Partial<ConvergeRequest>): { onDone: ReturnType<typeof vi.fn> } => {
    const onDone = vi.fn()
    worker.request({
      sim: {
        step: (dtMs, obstacles, scale) => {
          expect(dtMs).toBe(STEP_MS)
          steps.push({ obstacles, scale })
        },
      },
      obstacles: [ob(1)],
      scale: () => 0.5,
      onSubStep: () => {
        subSteps += 1
      },
      onDone,
      ...over,
    })
    return { onDone }
  }
  return { steps, subSteps: () => subSteps, request, cancel: () => { worker.cancel() } }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('createFogConvergence — the chunked background settle', () => {
  it('runs the EXACT budget in chunks, then completes once (and stops)', () => {
    const h = harness(6, 2)
    const { onDone } = h.request()
    expect(h.steps).toHaveLength(0) // nothing synchronous — the paint path stays clear
    vi.advanceTimersByTime(0)
    expect(h.steps).toHaveLength(2) // one chunk per macrotask
    vi.runAllTimers()
    expect(h.steps).toHaveLength(6) // the budget, exactly — never more
    expect(h.subSteps()).toBe(6) // the sim-clock hook fires once per sub-step
    expect(onDone).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(50)
    expect(h.steps).toHaveLength(6) // completed — no stray ticks
  })

  it('runs a final short chunk when the budget is not a chunk multiple', () => {
    const h = harness(5, 2)
    h.request()
    vi.runAllTimers()
    expect(h.steps).toHaveLength(5)
  })

  it('reads the spawn scale LIVE at every sub-step (drain-correct mid-budget)', () => {
    const h = harness(4, 2)
    let scale = 1
    h.request({ scale: () => scale })
    vi.advanceTimersByTime(0)
    scale = 0.25 // an arrival landed mid-budget
    vi.runAllTimers()
    expect(h.steps.map((s) => s.scale)).toEqual([1, 1, 0.25, 0.25])
  })

  it('a new request SUPERSEDES a mid-flight one: fresh budget, new obstacles, old onDone never fires', () => {
    const h = harness(4, 2)
    const first = h.request()
    vi.advanceTimersByTime(0) // 2 of 4 run
    const second = h.request({ obstacles: [ob(2)] })
    vi.runAllTimers()
    // The successor gets its FULL budget (each settle matures 120 steps, like the
    // old synchronous settle did), against the successor's obstacles.
    expect(h.steps).toHaveLength(6)
    expect(h.steps.slice(2).every((s) => s.obstacles[0]?.x === 2)).toBe(true)
    expect(first.onDone).not.toHaveBeenCalled()
    expect(second.onDone).toHaveBeenCalledTimes(1)
  })

  it('re-arms after a completed budget (the next arrival settles again)', () => {
    const h = harness(2, 2)
    h.request()
    vi.runAllTimers()
    const again = h.request()
    vi.runAllTimers()
    expect(h.steps).toHaveLength(4)
    expect(again.onDone).toHaveBeenCalledTimes(1)
  })

  it('cancel() stops mid-flight: no further steps, no completion', () => {
    const h = harness(6, 2)
    const { onDone } = h.request()
    vi.advanceTimersByTime(0)
    h.cancel()
    vi.runAllTimers()
    expect(h.steps).toHaveLength(2)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('cancel() before any tick is a clean no-op stop', () => {
    const h = harness(4, 2)
    const { onDone } = h.request()
    h.cancel()
    vi.runAllTimers()
    expect(h.steps).toHaveLength(0)
    expect(onDone).not.toHaveBeenCalled()
  })

  it('cancel() with nothing in flight does not throw', () => {
    const h = harness(4, 2)
    expect(() => {
      h.cancel()
    }).not.toThrow()
  })
})
