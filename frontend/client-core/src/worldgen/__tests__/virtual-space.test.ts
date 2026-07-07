import { describe, expect, it } from 'vitest'
import { VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '../fog-params.ts'
import { MAX_VIRTUAL_HEIGHT, virtualDims } from '../virtual-space.ts'

// The RESPONSIVE virtual space (MYT-89 responsive fix). The fog + graph render in one
// shared virtual coordinate space that used to be FIXED at the reference's 900×470 —
// CSS-scaled to an aspect-locked pane, which shrank labels to ~5px at a 375px pane
// (illegible) and letterboxed every non-90/47 pane. `virtualDims` makes the virtual
// space ADAPT to the pane instead:
//   - panes NARROWER than the reference render 1:1 (one virtual px == one CSS px), so
//     the design-system label font lands at its real size — legible at 375px;
//   - panes WIDER than the reference keep the reference WIDTH and CSS-upscale (the
//     eye-approved desktop zoom, exactly the shipped look at those widths);
//   - the HEIGHT always follows the pane's own aspect (uniform scale on both axes),
//     so the graph FILLS the pane at any aspect — no letterbox, no dead strip.
// The safety height bound caps the virtual AREA (the fog sim area-scales its particle
// count) for a degenerate super-tall consumer pane.

describe('virtualDims — the pane-adaptive shared virtual space', () => {
  it('renders 1:1 for a pane narrower than the reference (mobile legibility)', () => {
    // A ~375px phone pane: virtual == CSS px, so a 14px DS label draws at 14px.
    expect(virtualDims(343, 413)).toEqual({ width: 343, height: 413 })
  })

  it('renders 1:1 at exactly the reference-size pane', () => {
    expect(virtualDims(VIRTUAL_WIDTH, VIRTUAL_HEIGHT)).toEqual({
      width: VIRTUAL_WIDTH,
      height: VIRTUAL_HEIGHT,
    })
  })

  it('caps the virtual WIDTH at the reference width on wider panes (desktop zoom)', () => {
    // An 1800×590 desktop pane: scale 2 → 900 wide, height follows the pane aspect.
    expect(virtualDims(1800, 590)).toEqual({ width: VIRTUAL_WIDTH, height: 295 })
  })

  it('follows the pane aspect exactly (uniform scale, both axes)', () => {
    const dims = virtualDims(1350, 900)
    expect(dims.width).toBe(VIRTUAL_WIDTH)
    expect(dims.height / dims.width).toBeCloseTo(900 / 1350, 10)
  })

  it('bounds a degenerate super-tall pane at MAX_VIRTUAL_HEIGHT (area safety)', () => {
    // 400×3000: the height bound (not the width) sets the scale (3000/1200 = 2.5).
    expect(virtualDims(400, 3000)).toEqual({ width: 160, height: MAX_VIRTUAL_HEIGHT })
  })

  it('takes the LARGER of the two caps when both engage', () => {
    // 2700×1500: width cap alone → scale 3; height cap alone → scale 1.25. Scale 3 wins.
    expect(virtualDims(2700, 1500)).toEqual({ width: VIRTUAL_WIDTH, height: 500 })
  })

  it('falls back to the reference dims for an unmeasured (jsdom / zero-rect) pane', () => {
    expect(virtualDims(0, 0)).toEqual({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
    expect(virtualDims(1, 413)).toEqual({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
    expect(virtualDims(343, 1)).toEqual({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
  })
})
