import { describe, it, expect } from 'vitest'
import { DPR_CAP, MIN_EXPECTED_ENTITIES, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '@mythrun/client-core/worldgen'
import { fogBackingStore, fogSpawnScale } from './use-fog-canvas.ts'

// The fog layer's backing-store sizing (MYT-89 framerate fix). The fog is LOW-FREQUENCY
// dithered cloud quads — it never needs more device resolution than the reference
// prototype's own envelope (the virtual space at its DPR cap of 2). Rendering it at the
// full pane×dpr resolution (the graph-blur fix) made the per-frame painted area scale
// with the pane — pure fill-cost with no visible gain (the dither reads soft under CSS
// upscale by design; that IS how the eye-tuned reference rendered). These tests pin the
// cap: wide retina panes render the fog at exactly the canonical 2× virtual and CSS
// upscales that ONE layer; panes at or under the envelope are bit-identical to the
// former full-res sizing. The GRAPH canvas is untouched — full-res crisp lines + labels.
//
// Since the MYT-89 responsive fix the virtual space is PANE-ADAPTIVE (`virtualDims`),
// so the store takes the CURRENT virtual width: on a scale-1 pane (virtualW == cssW)
// the pane scale IS the dpr (≤ the cap) and the store equals the pane exactly.

describe('fogBackingStore — the fog render-resolution cap', () => {
  it('caps a wide retina pane at the canonical 2× virtual store (1800×940)', () => {
    // A ~1440-CSS-px retina pane rendering the REFERENCE-width virtual space: uncapped
    // this was 2880×1504 (the regression); capped it is exactly VIRTUAL × DPR_CAP.
    const store = fogBackingStore(1440, 752, 2, VIRTUAL_WIDTH)
    expect(store).toEqual({
      width: VIRTUAL_WIDTH * DPR_CAP,
      height: VIRTUAL_HEIGHT * DPR_CAP,
      scale: DPR_CAP,
    })
  })

  it('keeps the pane aspect when the cap engages on a non-exact aspect box', () => {
    // Rounding aside, width/height must stay in the pane's own proportion so the
    // ctx transform maps the virtual space onto the whole store.
    const store = fogBackingStore(1440, 750, 2, VIRTUAL_WIDTH)
    expect(store.width).toBe(1800)
    expect(store.height).toBe(Math.round(750 * 2 * (store.scale / ((1440 / VIRTUAL_WIDTH) * 2))))
  })

  it('is identical to the full-res sizing when the pane is at or under the envelope', () => {
    // An 852-CSS-px retina pane (a sub-reference story stage): pane scale ≈ 1.89 < 2 →
    // uncapped, bit-identical to the pre-fix cssW×dpr sizing.
    const store = fogBackingStore(852, 445, 2, VIRTUAL_WIDTH)
    expect(store).toEqual({ width: 852 * 2, height: 445 * 2, scale: (852 / VIRTUAL_WIDTH) * 2 })
  })

  it('leaves a wide non-retina pane uncapped (scale below the envelope)', () => {
    const store = fogBackingStore(1440, 752, 1, VIRTUAL_WIDTH)
    expect(store).toEqual({ width: 1440, height: 752, scale: 1440 / VIRTUAL_WIDTH })
  })

  it('sizes a pane-adaptive 1:1 (mobile) virtual space to the pane × DPR exactly', () => {
    // MYT-89 responsive: on a ~375px pane the virtual space IS the pane box, so the
    // pane scale is the dpr (2 ≤ the cap) — the store is the full pane at retina res.
    const store = fogBackingStore(343, 413, 2, 343)
    expect(store).toEqual({ width: 686, height: 826, scale: 2 })
  })
})

describe('fogSpawnScale — the entity-count → respawn-scale mapping (MYT-89 spawn-drain)', () => {
  it('is FULL spawn (1) before any entity arrives', () => {
    expect(fogSpawnScale(0, MIN_EXPECTED_ENTITIES)).toBe(1)
  })

  it('falls linearly with the arrived count (half the floor → half the spawn)', () => {
    expect(fogSpawnScale(MIN_EXPECTED_ENTITIES / 2, MIN_EXPECTED_ENTITIES)).toBeCloseTo(0.5)
  })

  it('hits ZERO exactly at the entity floor — nothing spawns in from here on', () => {
    expect(fogSpawnScale(MIN_EXPECTED_ENTITIES, MIN_EXPECTED_ENTITIES)).toBe(0)
  })

  it('clamps past the floor (real generations overshoot the conservative minimum)', () => {
    expect(fogSpawnScale(MIN_EXPECTED_ENTITIES + 14, MIN_EXPECTED_ENTITIES)).toBe(0)
  })

  it('holds FULL spawn with no denominator (standalone fog — total 0 disables the drain)', () => {
    expect(fogSpawnScale(5, 0)).toBe(1)
  })
})
