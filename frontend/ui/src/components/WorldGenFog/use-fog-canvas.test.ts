import { describe, it, expect } from 'vitest'
import { DPR_CAP, VIRTUAL_HEIGHT, VIRTUAL_WIDTH } from '@mythrun/client-core/worldgen'
import { fogBackingStore } from './use-fog-canvas.ts'

// The fog layer's backing-store sizing (MYT-89 framerate fix). The fog is LOW-FREQUENCY
// dithered cloud quads — it never needs more device resolution than the reference
// prototype's own envelope (the 900×470 virtual space at its DPR cap of 2, i.e. 1800×940).
// Rendering it at the full pane×dpr resolution (the graph-blur fix) made the per-frame
// painted area scale with the pane — pure fill-cost with no visible gain (the dither reads
// soft under CSS upscale by design; that IS how the eye-tuned reference rendered). These
// tests pin the cap: wide retina panes render the fog at exactly the canonical 2× virtual
// and CSS upscales that ONE layer; panes at or under the envelope are bit-identical to the
// former full-res sizing. The GRAPH canvas is untouched — full-res crisp lines + labels.

describe('fogBackingStore — the fog render-resolution cap', () => {
  it('caps a wide retina pane at the canonical 2× virtual store (1800×940)', () => {
    // A ~1440-CSS-px retina pane (the production world-gen pane): uncapped this was
    // 2880×1504 (the regression); capped it is exactly VIRTUAL × DPR_CAP.
    const store = fogBackingStore(1440, 752, 2)
    expect(store).toEqual({
      width: VIRTUAL_WIDTH * DPR_CAP,
      height: VIRTUAL_HEIGHT * DPR_CAP,
      scale: DPR_CAP,
    })
  })

  it('keeps the pane aspect when the cap engages on a non-exact aspect box', () => {
    // Rounding aside, width/height must stay in the pane's own proportion so the
    // ctx transform maps the 900×470 virtual space onto the whole store.
    const store = fogBackingStore(1440, 750, 2)
    expect(store.width).toBe(1800)
    expect(store.height).toBe(Math.round(750 * 2 * (store.scale / ((1440 / VIRTUAL_WIDTH) * 2))))
  })

  it('is identical to the full-res sizing when the pane is at or under the envelope', () => {
    // An 852-CSS-px retina pane (the 900px-max story stage): pane scale ≈ 1.89 < 2 →
    // uncapped, bit-identical to the pre-fix cssW×dpr sizing.
    const store = fogBackingStore(852, 445, 2)
    expect(store).toEqual({ width: 852 * 2, height: 445 * 2, scale: (852 / VIRTUAL_WIDTH) * 2 })
  })

  it('leaves a wide non-retina pane uncapped (scale below the envelope)', () => {
    const store = fogBackingStore(1440, 752, 1)
    expect(store).toEqual({ width: 1440, height: 752, scale: 1440 / VIRTUAL_WIDTH })
  })
})
