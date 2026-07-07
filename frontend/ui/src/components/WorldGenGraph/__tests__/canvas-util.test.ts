import { afterEach, describe, expect, it, vi } from 'vitest'
import { DPR_CAP, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '@mythrun/client-core/worldgen'
import { cardKeepOut, resolveEdgeInk, sizeCanvasForDpr } from '../canvas-util.ts'

/** The reference virtual dims — what `virtualDims` yields for a reference-aspect pane
 *  (the virtual space is PANE-ADAPTIVE now; `sizeCanvasForDpr` takes the current dims). */
const REF_DIMS = { width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT }

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
    sizeCanvasForDpr(canvas, ctx, REF_DIMS)
    expect(backing()).toEqual({ width: Math.round(1400 * 2), height: Math.round(731 * 2) })
    // …and NOT the old fixed 900×470 × DPR backing store.
    expect(backing().width).not.toBe(Math.round(VIRTUAL_WIDTH * 2))
    expect(backing().height).not.toBe(Math.round(VIRTUAL_HEIGHT * 2))
  })

  it('scales the context by (cssW / VIRTUAL_WIDTH) × DPR so draw code stays in virtual units', () => {
    setDpr(2)
    const { canvas, ctx, transform } = fakeCanvas({ width: 1800, height: 940 })
    sizeCanvasForDpr(canvas, ctx, REF_DIMS)
    const expected = (1800 / VIRTUAL_WIDTH) * 2
    expect(transform()).toEqual({ a: expected, b: 0, c: 0, d: expected, e: 0, f: 0 })
  })

  it('returns the element CSS box (what the pointer mapping converts client px against)', () => {
    setDpr(2)
    const { canvas, ctx } = fakeCanvas({ width: 1200, height: 627 })
    expect(sizeCanvasForDpr(canvas, ctx, REF_DIMS)).toEqual({ cssW: 1200, cssH: 627 })
  })

  it('caps DPR at DPR_CAP regardless of a higher device pixel ratio', () => {
    setDpr(3)
    const { canvas, ctx, backing } = fakeCanvas({ width: 900, height: 470 })
    sizeCanvasForDpr(canvas, ctx, REF_DIMS)
    expect(backing().width).toBe(Math.round(900 * DPR_CAP))
  })

  it('falls back to DPR 1 when devicePixelRatio is 0/undefined', () => {
    setDpr(0)
    const { canvas, ctx, backing, transform } = fakeCanvas({ width: 900, height: 470 })
    sizeCanvasForDpr(canvas, ctx, REF_DIMS)
    expect(backing().width).toBe(900) // 900 × 1
    expect(transform()?.a).toBe(1) // (900/900) × 1
  })

  it('scales 1:1 (× DPR) for a pane-adaptive MOBILE virtual space (MYT-89 responsive)', () => {
    // A ~375px phone pane whose virtual space IS the pane box (`virtualDims` 1:1): the
    // context scale is exactly the DPR — one virtual px == one CSS px, so the DS label
    // font renders at its true size (the legibility fix).
    setDpr(2)
    const { canvas, ctx, backing, transform } = fakeCanvas({ width: 343, height: 413 })
    sizeCanvasForDpr(canvas, ctx, { width: 343, height: 413 })
    expect(backing()).toEqual({ width: 686, height: 826 })
    expect(transform()?.a).toBe(2) // (343/343) × 2
  })
})

// ── resolveEdgeInk — the LIGHTER edge stroke (MYT-89 density redesign) ──────────────────
// The connection strings stroke in the `--ink-tertiary` DS step (the muted text tier) so
// a label always reads over a crossing line; when the token is unresolved (a bare Canvas)
// it falls back through `resolveInk` (`--ink`, then the element's own color). jsdom
// doesn't resolve custom properties, so the computed style is stubbed per branch.

describe('resolveEdgeInk — the lighter DS ink step for edges', () => {
  const canvas = (): HTMLCanvasElement => document.createElement('canvas')

  const styleWith = (vars: Record<string, string>, color: string): CSSStyleDeclaration =>
    ({
      getPropertyValue: (name: string) => vars[name] ?? '',
      color,
    }) as unknown as CSSStyleDeclaration

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // Stub values are opaque strings, not colour literals (R3 keeps raw colours out of
  // source; the resolver just passes whatever the token computes to through).
  it('resolves the --ink-tertiary token (trimmed) when present', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(
      styleWith({ '--ink-tertiary': ' tertiary-token ', '--ink': 'ink-token' }, 'element-color'),
    )
    expect(resolveEdgeInk(canvas())).toBe('tertiary-token')
  })

  it('falls back to the full ink (--ink) when the tertiary token is unresolved', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(
      styleWith({ '--ink': 'ink-token' }, 'element-color'),
    )
    expect(resolveEdgeInk(canvas())).toBe('ink-token')
  })

  it('falls back to the element color when NO token resolves (bare Canvas / jsdom)', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue(styleWith({}, 'element-color'))
    expect(resolveEdgeInk(canvas())).toBe('element-color')
  })
})

// ── cardKeepOut — the status-card overlay's sim keep-out (density redesign) ─────────────
// The card floats over the pane (on a phone ~70% of the width); its DOM box maps into a
// CENTRED-virtual rect the sim shoves node boxes out of, so no entity name spends the
// generation occluded under the card. Thin dead gutters against the pane's top/left edge
// are swallowed (the shove-out must never fight the containment clamp over a strip no
// glyph can occupy).

describe('cardKeepOut — DOM box → centred-virtual keep-out', () => {
  // A 686-CSS-px pane over a 343-wide virtual space → scale 0.5 (CSS→virtual).
  const canvasRect = { left: 100, top: 50, width: 686, height: 826 }
  const virtual = { width: 343, height: 413 }

  it('maps the card box through the pane→virtual scale and recentres (+pad)', () => {
    // Card well inside the pane (no gutter snap): 300..500 × 400..600 CSS.
    const rect = cardKeepOut(canvasRect, { left: 300, top: 400, right: 500, bottom: 600 }, virtual)
    // left: (300-100)*0.5 - 171.5 - 10 = -81.5; top: (400-50)*0.5 - 206.5 - 10 = -41.5
    expect(rect.left).toBeCloseTo(-81.5, 6)
    expect(rect.top).toBeCloseTo(-41.5, 6)
    expect(rect.right).toBeCloseTo((500 - 100) * 0.5 - 171.5 + 10, 6)
    expect(rect.bottom).toBeCloseTo((600 - 50) * 0.5 - 206.5 + 10, 6)
  })

  it('swallows the thin top-left gutter into the rect (the corner trap)', () => {
    // The production card: pinned ~24 CSS px (12 virtual) from the pane's top-left —
    // far less than a glyph box needs, so the rect snaps to the pane edge.
    const rect = cardKeepOut(canvasRect, { left: 124, top: 74, right: 500, bottom: 200 }, virtual)
    expect(rect.left).toBe(-virtual.width / 2)
    expect(rect.top).toBe(-virtual.height / 2)
  })
})
