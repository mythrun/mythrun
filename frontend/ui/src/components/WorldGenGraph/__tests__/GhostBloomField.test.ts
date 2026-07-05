import { describe, it, expect, vi } from 'vitest'
import { GhostBloomField } from '../GhostBloomField.ts'

// GhostBloomField is a Canvas-2D rendering HELPER (not a React component): it
// fills the world-gen streaming graph's dead air with faint, transient 1-bit
// dither "blooms" clustered near the real graph. These unit tests pin the two
// load-bearing invariants — the FIFO memory bound and the age→removal lifecycle
// — plus the draw path and the reduced-motion escape hatch. `random` is injected
// so spawns are deterministic (UI jitter, not game dice — Math.random is fine at
// runtime, but a test needs a fixed sequence).

/** A minimal Canvas-2D stand-in: jsdom has no real 2D context, and render only
 *  touches these four members. `vi.fn()` spies let us count draw calls; the two
 *  settable props (`fillStyle`, `globalAlpha`) absorb the writes render makes. */
function makeCtx() {
  const fillRect = vi.fn()
  const save = vi.fn()
  const restore = vi.fn()
  const ctx = {
    fillStyle: '',
    globalAlpha: 1,
    fillRect,
    save,
    restore,
  } as unknown as CanvasRenderingContext2D
  return { ctx, fillRect, save, restore }
}

describe('GhostBloomField — FIFO memory bound', () => {
  it('never exceeds the cap under sustained spawning (evicts oldest)', () => {
    const cap = 40
    // random → 0 makes every fractional emission fire, so each spawn adds the
    // full per-frame budget — the most aggressive case for the bound.
    const field = new GhostBloomField({ cap, spawnRate: 200, random: () => 0 })
    for (let frame = 0; frame < 500; frame++) {
      field.spawn(1000, [{ x: 10, y: 10 }])
      // The invariant must hold after EVERY spawn, not just at the end.
      expect(field.count).toBeLessThanOrEqual(cap)
    }
    // And it actually fills to the cap (the eviction path is exercised).
    expect(field.count).toBe(cap)
  })

  it('holds the default cap under a realistic 10-minute drip without unbounded growth', () => {
    // ~60fps × 600s = 36k frames at the default rate. The set must stay bounded.
    const field = new GhostBloomField({ random: () => 0 })
    let t = 0
    for (let frame = 0; frame < 4000; frame++) {
      field.spawn(16, [{ x: 100, y: 100 }])
      t += 16
      field.update(t)
    }
    // Whatever the default cap is, the live set is bounded well under the
    // spawn total (4000 frames would be tens of thousands of blooms unbounded).
    expect(field.count).toBeLessThanOrEqual(500)
  })
})

describe('GhostBloomField — lifecycle (age → removal)', () => {
  it('removes a bloom once t advances past its lifetime', () => {
    const lifetime = 1000
    const field = new GhostBloomField({ lifetime, spawnRate: 10, random: () => 0 })
    field.spawn(1000, [{ x: 0, y: 0 }]) // stamped bornAt = 0 (initial clock)
    expect(field.count).toBeGreaterThan(0)

    field.update(500) // still within lifetime → survives
    expect(field.count).toBeGreaterThan(0)

    field.update(1500) // past lifetime → removed
    expect(field.count).toBe(0)
  })
})

describe('GhostBloomField — render', () => {
  it('wraps drawing in save/restore and issues dither fillRects for a fresh bloom', () => {
    const field = new GhostBloomField({
      spawnRate: 5,
      lifetime: 1000,
      cell: 4,
      radius: 4,
      random: () => 0,
    })
    field.spawn(1000, [{ x: 40, y: 40 }])
    field.update(0) // now = 0 → the bloom is fresh (full density)

    const { ctx, fillRect, save, restore } = makeCtx()
    field.render(ctx)

    expect(save).toHaveBeenCalled()
    expect(restore).toHaveBeenCalled()
    expect(fillRect).toHaveBeenCalled()
  })

  it('draws a near-dead bloom fainter (fewer cells) than a fresh one', () => {
    const field = new GhostBloomField({
      spawnRate: 5,
      lifetime: 1000,
      cell: 4,
      radius: 4,
      random: () => 0,
    })
    field.spawn(1000, [{ x: 40, y: 40 }])

    const fresh = makeCtx()
    field.update(0)
    field.render(fresh.ctx)
    const freshCells = fresh.fillRect.mock.calls.length

    const dying = makeCtx()
    field.update(990) // ~1% life remaining, still alive
    field.render(dying.ctx)
    const dyingCells = dying.fillRect.mock.calls.length

    expect(freshCells).toBeGreaterThan(0)
    expect(dyingCells).toBeLessThan(freshCells)
  })

  it('draws nothing once every bloom has aged out', () => {
    const field = new GhostBloomField({ lifetime: 1000, spawnRate: 5, random: () => 0 })
    field.spawn(1000, [{ x: 40, y: 40 }])
    field.update(2000) // all removed

    const { ctx, fillRect } = makeCtx()
    field.render(ctx)
    expect(fillRect).not.toHaveBeenCalled()
  })
})

describe('GhostBloomField — ambient drift with no named points', () => {
  it('still emits subtly when nearPoints is empty (no throw, bounded)', () => {
    const field = new GhostBloomField({ cap: 40, spawnRate: 200, random: () => 0 })
    field.spawn(1000, [])
    expect(field.count).toBeGreaterThan(0)
    expect(field.count).toBeLessThanOrEqual(40)
  })
})

describe('GhostBloomField — reduced motion', () => {
  it('makes spawn/update/render no-ops (count stays 0, no draw calls)', () => {
    const field = new GhostBloomField({ reducedMotion: true, spawnRate: 200, random: () => 0 })

    field.spawn(1000, [{ x: 0, y: 0 }])
    expect(field.count).toBe(0)

    field.update(5000)
    expect(field.count).toBe(0)

    const { ctx, fillRect, save } = makeCtx()
    field.render(ctx)
    expect(fillRect).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })
})

describe('GhostBloomField — spawn guards', () => {
  it('is a no-op for a non-positive dt', () => {
    const field = new GhostBloomField({ spawnRate: 200, random: () => 0 })
    field.spawn(0, [{ x: 0, y: 0 }])
    field.spawn(-16, [{ x: 0, y: 0 }])
    expect(field.count).toBe(0)
  })
})
