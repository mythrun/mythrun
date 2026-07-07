import { describe, expect, it } from 'vitest'
import { VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '../fog-params.ts'
import {
  cameraCentredOn,
  cameraWorldDims,
  centreCamera,
  clampCamera,
  followCameraStep,
  MAX_VIRTUAL_HEIGHT,
  SEAT_HEADROOM,
  virtualDims,
} from '../virtual-space.ts'

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

// ── Density-aware growth (MYT-89 density redesign) ─────────────────────────────────────
// A real generation lands ~46 entities — more than the fixed 900-wide reference space can
// seat with labels. `growth` widens the reference width with the node count, so a WIDE
// pane's CSS upscale relaxes toward 1:1 (more virtual area for the same pane; the world
// visibly grows as it fills). The scale never drops below 1 — the label legibility floor.

describe('virtualDims — density-aware growth', () => {
  const GROWTH = { startCount: 16, perNode: 40 }

  it('is EXACTLY the shipped zoom at or below the start count (eye-approved low density)', () => {
    const base = virtualDims(1800, 590)
    expect(virtualDims(1800, 590, { nodeCount: 16, ...GROWTH })).toEqual(base)
    expect(virtualDims(1800, 590, { nodeCount: 3, ...GROWTH })).toEqual(base)
  })

  it('grows the virtual space past the start count (the upscale relaxes)', () => {
    // 10 nodes past the start → reference width 900 + 400 = 1300; pane 1800 wide →
    // scale 1800/1300 ≈ 1.385 (was 2). More virtual area for the same pane.
    const dims = virtualDims(1800, 590, { nodeCount: 26, ...GROWTH })
    expect(dims.width).toBeCloseTo(1300, 6)
    expect(dims.height).toBeCloseTo(590 * (1300 / 1800), 6)
  })

  it('caps the growth at 1:1 (virtual px never render smaller than CSS px)', () => {
    // Grown reference width (2100) exceeds the pane (1800) → scale clamps to 1.
    const dims = virtualDims(1800, 590, { nodeCount: 46, ...GROWTH })
    expect(dims).toEqual({ width: 1800, height: 590 })
  })

  it('leaves sub-reference (phone) panes untouched — they are already 1:1', () => {
    expect(virtualDims(343, 413, { nodeCount: 46, ...GROWTH })).toEqual({ width: 343, height: 413 })
  })

  it('still honours the degenerate-height area bound while grown', () => {
    const dims = virtualDims(400, 3000, { nodeCount: 46, ...GROWTH })
    expect(dims).toEqual({ width: 160, height: MAX_VIRTUAL_HEIGHT })
  })
})

// ── The pannable camera world (MYT-89 T1b — the mobile redesign) ───────────────────────
// The REJECTED mobile design shrank the world to the glass (a 343×600 1:1 space seats ~6
// labels of a 46-entity world). The camera design STOPS shrinking instead: when the
// pane's 1:1 virtual space can't SEAT every entity's label under the desktop budget
// rules (`viewArea < nodeCount × areaPerLabel`), the WORLD grows past the pane —
// uniformly, aspect-preserving, to `nodeCount × areaPerLabel × SEAT_HEADROOM` — and the
// pane becomes a pannable CAMERA over it. Where the pane seats everything (desktop), the
// world stays exactly the pane-adaptive dims and the camera is locked at identity: zero
// behavior change.

describe('cameraWorldDims — the seat-driven pannable world', () => {
  const GROWTH = { nodeCount: 46, startCount: 16, perNode: 40 }
  const SEAT = { nodeCount: 46, areaPerLabel: 15_000 }

  it('is IDENTITY (world === view, disengaged) where the pane seats every label', () => {
    // A 1440×736 desktop pane: 1_059_840 px² ≥ 46 × 15_000 — the budget seats all 46.
    const cam = cameraWorldDims(1440, 736, GROWTH, SEAT)
    expect(cam.engaged).toBe(false)
    expect(cam.world).toEqual(cam.view)
    expect(cam.view).toEqual(virtualDims(1440, 736, GROWTH))
  })

  it('is IDENTITY with no seat input (every pre-camera caller)', () => {
    const cam = cameraWorldDims(343, 600, GROWTH)
    expect(cam.engaged).toBe(false)
    expect(cam.world).toEqual(virtualDims(343, 600, GROWTH))
  })

  it('ENGAGES on a phone pane that cannot seat the density — the world stops shrinking', () => {
    // 343×600 = 205_800 px² < 690_000 needed: the world grows to seat the budget.
    const cam = cameraWorldDims(343, 600, GROWTH, SEAT)
    expect(cam.engaged).toBe(true)
    expect(cam.view).toEqual({ width: 343, height: 600 }) // the pane stays the window
    // The grown world's area is the seated budget area (bare need × headroom)…
    expect(cam.world.width * cam.world.height).toBeCloseTo(46 * 15_000 * SEAT_HEADROOM, 3)
    // …at the REFERENCE aspect (the shape the force cloud actually fills — a wide
    // map the portrait phone pans across, not an aspect-matched portrait strip).
    expect(cam.world.width / cam.world.height).toBeCloseTo(VIRTUAL_WIDTH / VIRTUAL_HEIGHT, 10)
  })

  it('the grown world seats EVERY label under the desktop budget rules', () => {
    const cam = cameraWorldDims(343, 600, GROWTH, SEAT)
    // budget = floor(worldArea / areaPerLabel) ≥ nodeCount — all 46 wear names.
    expect(Math.floor((cam.world.width * cam.world.height) / SEAT.areaPerLabel)).toBeGreaterThanOrEqual(46)
  })

  it('yields the SAME world for the same density on every phone (the world is the world)', () => {
    const portrait = cameraWorldDims(343, 600, GROWTH, SEAT)
    const landscape = cameraWorldDims(600, 343, GROWTH, SEAT)
    expect(landscape.world).toEqual(portrait.world)
  })

  it('COVERS the view on both axes (world under every pane pixel), keeping the aspect', () => {
    // A low density whose reference-shaped seat world (≈736×384) is SHORTER than the
    // pane: the world scales up until the view is covered.
    const cam = cameraWorldDims(343, 600, { ...GROWTH, nodeCount: 14 }, { nodeCount: 14, areaPerLabel: 15_000 })
    expect(cam.engaged).toBe(true)
    expect(cam.world.height).toBeCloseTo(600, 6) // cover binds on the short axis
    expect(cam.world.width).toBeGreaterThanOrEqual(343)
    expect(cam.world.width / cam.world.height).toBeCloseTo(VIRTUAL_WIDTH / VIRTUAL_HEIGHT, 10)
  })

  it('stays identity just BELOW the seat threshold (no spurious desktop engage)', () => {
    // 700×990 = 693_000 ≥ 690_000 — seats everything, camera stays off.
    const cam = cameraWorldDims(700, 990, GROWTH, SEAT)
    expect(cam.engaged).toBe(false)
    expect(cam.world).toEqual(cam.view)
  })

  it('does not engage at low density even on a phone (the world still fits the glass)', () => {
    // 13 nodes need 195_000 px² ≤ the 343×600 pane's 205_800 — identity.
    const cam = cameraWorldDims(343, 600, { ...GROWTH, nodeCount: 13 }, { nodeCount: 13, areaPerLabel: 15_000 })
    expect(cam.engaged).toBe(false)
  })

  it('falls back to the reference dims, DISENGAGED, for an unmeasured (jsdom) pane', () => {
    const cam = cameraWorldDims(0, 0, GROWTH, SEAT)
    expect(cam.engaged).toBe(false)
    expect(cam.world).toEqual({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
    expect(cam.view).toEqual({ width: VIRTUAL_WIDTH, height: VIRTUAL_HEIGHT })
  })
})

describe('clampCamera / centreCamera / cameraCentredOn — pan bounds', () => {
  const WORLD = { width: 700, height: 1200 }
  const VIEW = { width: 343, height: 600 }

  it('clamps the camera into [0, world − view] on both axes', () => {
    expect(clampCamera({ x: -50, y: -10 }, WORLD, VIEW)).toEqual({ x: 0, y: 0 })
    expect(clampCamera({ x: 9999, y: 9999 }, WORLD, VIEW)).toEqual({ x: 357, y: 600 })
    expect(clampCamera({ x: 100, y: 200 }, WORLD, VIEW)).toEqual({ x: 100, y: 200 })
  })

  it('clamps to zero when the world fits the view (identity camera)', () => {
    expect(clampCamera({ x: 40, y: 40 }, VIEW, VIEW)).toEqual({ x: 0, y: 0 })
    expect(clampCamera({ x: 40, y: 40 }, { width: 200, height: 300 }, VIEW)).toEqual({ x: 0, y: 0 })
  })

  it('centreCamera puts the view at the middle of the world (the initial camera)', () => {
    expect(centreCamera(WORLD, VIEW)).toEqual({ x: 178.5, y: 300 })
    expect(centreCamera(VIEW, VIEW)).toEqual({ x: 0, y: 0 })
  })

  it('cameraCentredOn centres a world point, clamped at the edges', () => {
    // A point mid-world: the camera puts it at the view centre.
    expect(cameraCentredOn({ x: 350, y: 600 }, WORLD, VIEW)).toEqual({ x: 178.5, y: 300 })
    // A corner point: the camera clamps to the world edge instead of over-panning.
    expect(cameraCentredOn({ x: 0, y: 0 }, WORLD, VIEW)).toEqual({ x: 0, y: 0 })
    expect(cameraCentredOn({ x: 700, y: 1200 }, WORLD, VIEW)).toEqual({ x: 357, y: 600 })
  })
})

describe('followCameraStep — the eased auto-follow drift', () => {
  const CAM = { x: 0, y: 0 }
  const TARGET = { x: 100, y: 200 }

  it('moves toward the target by the exponential-approach fraction', () => {
    // dt == tau → 1 − e⁻¹ ≈ 63.2% of the remaining distance.
    const next = followCameraStep(CAM, TARGET, 1000, 1000)
    expect(next.x).toBeCloseTo(100 * (1 - Math.exp(-1)), 10)
    expect(next.y).toBeCloseTo(200 * (1 - Math.exp(-1)), 10)
  })

  it('is framerate-independent (two half-steps land where one full step does)', () => {
    const oneStep = followCameraStep(CAM, TARGET, 1000, 1000)
    const twoSteps = followCameraStep(followCameraStep(CAM, TARGET, 500, 1000), TARGET, 500, 1000)
    expect(twoSteps.x).toBeCloseTo(oneStep.x, 10)
    expect(twoSteps.y).toBeCloseTo(oneStep.y, 10)
  })

  it('holds still at dt 0 and never overshoots at huge dt', () => {
    expect(followCameraStep(CAM, TARGET, 0, 1000)).toEqual(CAM)
    const far = followCameraStep(CAM, TARGET, 1_000_000, 1000)
    expect(far.x).toBeCloseTo(TARGET.x, 6)
    expect(far.y).toBeCloseTo(TARGET.y, 6)
  })
})
