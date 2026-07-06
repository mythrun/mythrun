import { afterEach, describe, expect, it } from 'vitest'
import { DPR_CAP, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '@mythrun/client-core/worldgen'
import { sizeCanvasForDpr } from '../canvas-util.ts'

// MYT-89 audit #2 (full-res render). The backing store was FIXED at VIRTUAL_WIDTH ×
// VIRTUAL_HEIGHT × DPR and CSS-stretched to the pane → an upscaled blur/zoom on a wide or
// retina pane. The fix sizes the backing store to the ELEMENT's real client pixels × DPR
// and scales the context by (cssW / VIRTUAL_WIDTH) × DPR, so draw code stays in the
// 900×470 VIRTUAL space but renders at full pane resolution. These tests pin exactly that:
// the backing store follows the element, NOT a fixed 900×470.

interface Transform {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** A fake canvas whose `getBoundingClientRect` reports `rect`, plus a context that records
 *  the `setTransform` it receives. `canvas.width/height` are real settable props so the
 *  test can read the backing-store size the function assigned. */
function fakeCanvas(rect: { width: number; height: number }): {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  transform: () => Transform | null
  backing: () => { width: number; height: number }
} {
  const store = { width: 0, height: 0 }
  let transform: Transform | null = null
  const canvas = {
    get width() {
      return store.width
    },
    set width(v: number) {
      store.width = v
    },
    get height() {
      return store.height
    },
    set height(v: number) {
      store.height = v
    },
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      right: rect.width,
      bottom: rect.height,
      width: rect.width,
      height: rect.height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }),
  } as unknown as HTMLCanvasElement
  const ctx = {
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      transform = { a, b, c, d, e, f }
    },
  } as unknown as CanvasRenderingContext2D
  return { canvas, ctx, transform: () => transform, backing: () => ({ ...store }) }
}

/** Set `window.devicePixelRatio` for one test (restored by afterEach). */
function setDpr(value: number): void {
  Object.defineProperty(window, 'devicePixelRatio', { value, configurable: true })
}

afterEach(() => {
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true })
})

describe('sizeCanvasForDpr — full-pane resolution (MYT-89 audit #2)', () => {
  it('sizes the backing store to the ELEMENT client dims × DPR (not a fixed 900×470)', () => {
    setDpr(2)
    const { canvas, ctx, backing } = fakeCanvas({ width: 1400, height: 731 })
    sizeCanvasForDpr(canvas, ctx)
    expect(backing()).toEqual({ width: Math.round(1400 * 2), height: Math.round(731 * 2) })
    // …and NOT the old fixed 900×470 × DPR backing store.
    expect(backing().width).not.toBe(Math.round(VIRTUAL_WIDTH * 2))
    expect(backing().height).not.toBe(Math.round(VIRTUAL_HEIGHT * 2))
  })

  it('scales the context by (cssW / VIRTUAL_WIDTH) × DPR so draw code stays in virtual units', () => {
    setDpr(2)
    const { canvas, ctx, transform } = fakeCanvas({ width: 1800, height: 940 })
    sizeCanvasForDpr(canvas, ctx)
    const expected = (1800 / VIRTUAL_WIDTH) * 2
    expect(transform()).toEqual({ a: expected, b: 0, c: 0, d: expected, e: 0, f: 0 })
  })

  it('returns the element CSS box (what the pointer mapping converts client px against)', () => {
    setDpr(2)
    const { canvas, ctx } = fakeCanvas({ width: 1200, height: 627 })
    expect(sizeCanvasForDpr(canvas, ctx)).toEqual({ cssW: 1200, cssH: 627 })
  })

  it('caps DPR at DPR_CAP regardless of a higher device pixel ratio', () => {
    setDpr(3)
    const { canvas, ctx, backing } = fakeCanvas({ width: 900, height: 470 })
    sizeCanvasForDpr(canvas, ctx)
    expect(backing().width).toBe(Math.round(900 * DPR_CAP))
  })

  it('falls back to DPR 1 when devicePixelRatio is 0/undefined', () => {
    setDpr(0)
    const { canvas, ctx, backing, transform } = fakeCanvas({ width: 900, height: 470 })
    sizeCanvasForDpr(canvas, ctx)
    expect(backing().width).toBe(900) // 900 × 1
    expect(transform()?.a).toBe(1) // (900/900) × 1
  })
})
