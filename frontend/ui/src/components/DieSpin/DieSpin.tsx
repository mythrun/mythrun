import { forwardRef, useEffect, useRef, useState } from 'react'
import type { DieSpinProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// DieSpin (MYT-93, spec §5) — the flat 2D OUTLINED d20 the RollCard spins. This
// component (and its story) is the CANONICAL reference for the die glyph: a NEW
// brand mark — no pixelarticons dice exists (searched 2026-07-14) and Miklos
// directed "a 2D outline in some 1-bit register, spun" — so authoring it here is
// sanctioned by spec §5, distinct from the general "no hand-authored glyph" rule.
//
// GLYPH — a FACETED d20 (myth-ydu35): the pointy-top hexagon silhouette with the
// icosahedron's full interior fan drawn — a central triangular face plus the
// twelve edges connecting it to every silhouette vertex (the classic
// front-face-with-a-number construction; run-2's facet-band hexagon read as "a
// hex nut, not a d20"). The central face is drawn slightly LARGER than the true
// projection so its interior stays a clean field: the result numeral stamps
// INSIDE the face (sized to fit it, nudged to its centroid), so no facet stroke
// crosses the digits at any value — and the geometry is unmistakably an
// icosahedron at rest AND at result. Open geometry (no knockout plate) is still
// deliberate: the die renders on BOTH the page --bg (standalone) and a card
// --surface (in RollCard), so a paper-fill plate would mismatch one ground.
// Miter joins + butt caps (SVG defaults) keep the sharp square/1-bit register;
// currentColor stroke, fill none.
//
// MOTION — a STEPPED rotation, NEVER a smooth CSS transition (the motion analog of
// the brand's stepped Bayer dither; deliberately overrides UX §13's "smooth"). Eight
// discrete 45° jumps carry the die through one full revolution back to upright, but
// the easing lives in TIME: the DWELL ramps (see DIE_SPIN_DWELLS) so the die
// decelerates into the landing. The final 45° lands upright with a single discrete
// RECOIL frame — one scale pop (DIE_IMPACT_SCALE), held DIE_IMPACT_MS — then it
// SNAPS to rest and holds still (the stillness sells the landing). One overshoot
// frame, never two. `onSpinComplete` fires exactly ONCE, at that final rest.
// `reducedMotion` → NO spin, `onSpinComplete` fires immediately (instant land).
// Motion is never the only signal: the landed `result` announces via a polite live
// region carrying `resultLabel`.
//
// The `result` numeral stamps in the die CENTRE in `--font-ui` (`font-ui`) once
// landed (result present AND not spinning); it is withheld mid-spin. The die SVG is
// aria-hidden decoration; the numeral does NOT rotate (a sibling of the spun svg),
// so it lands upright.

// The authored faceted d20 on the pixelarticons 24-grid (viewBox 0 0 24 24),
// stroked in currentColor (fill none): the pointy-top hexagon silhouette, the
// central triangular face (apex 12,4.2 · base y 17.3 — enlarged past the true
// projection so the numeral fits inside it), the three vertex spokes, and the
// nine remaining fan edges tying every silhouette corner to the face.
const D20_OUTLINE_PATH =
  'M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z ' + // silhouette
  'M12 4.2 L19.6 17.3 L4.4 17.3 Z ' + // central face
  'M12 2 L12 4.2 M3 17 L4.4 17.3 M21 17 L19.6 17.3 ' + // vertex spokes
  'M3 7 L12 4.2 M21 7 L12 4.2 ' + // upper facet edges
  'M3 7 L4.4 17.3 M21 7 L19.6 17.3 ' + // side facet edges
  'M12 22 L4.4 17.3 M12 22 L19.6 17.3' // lower facet edges

// myth-0qvay: per-die silhouettes in the SAME facet-band language as the d20 — a
// hard polygon SILHOUETTE plus end-facet hints kept to the poles (above ~y8 / below
// ~y16), so the OPEN equatorial band where the numeral stamps is never crossed. Each
// is unmistakable by its outline: triangle (d4), square (d6), vertical rhombus (d8),
// pentagonal kite (d10), pentagon (d12), facet hexagon (d20). The numeral always
// stamps at the fixed box centre (12,12), so every shape is centred there.
export const DIE_PATHS: Record<number, string> = {
  // Tetrahedron — an upward triangle with a small top face.
  4: 'M12 2.5 L21.5 20.5 L2.5 20.5 Z M9 7.6 L12 2.5 L15 7.6',
  // Cube — a clean square (a centred square reads as a d6).
  6: 'M4 4 H20 V20 H4 Z',
  // Octahedron — a vertical rhombus with pole gables top and bottom.
  8: 'M12 2 L21 12 L12 22 L3 12 Z M5 12 L12 6 L19 12 M5 12 L12 18 L19 12',
  // Pentagonal trapezohedron — the classic d10 kite, with a top pole spoke.
  10: 'M12 2 L20 9 L18 17 L12 22 L6 17 L4 9 Z M12 2 L12 6.6',
  // Dodecahedron — an upward pentagon with a shallow top facet.
  12: 'M12 2.5 L20.5 9 L17 19.5 L7 19.5 L3.5 9 Z M4 9 L12 6.4 L20 9',
  // Icosahedron — the canonical facet-band d20.
  20: D20_OUTLINE_PATH,
}

/** Resolve the outline path for a die size. Skill checks pin 20; NdM dice_rolls
 *  thread frame.sides. d100/percentile renders as a d10; any non-standard size
 *  falls back to the d20 so the glyph is never empty. */
export function pathForSides(sides: number): string {
  // d100/percentile borrows the d10 kite; any non-standard size falls back to d20.
  const key = sides === 100 ? 10 : sides
  return DIE_PATHS[key] ?? D20_OUTLINE_PATH
}

// STEPPED motion budget (eye-tuned 2026-07-21). Eight hard 45° jumps = one full
// revolution back to upright; the die never interpolates. Deceleration lives in the
// dwell, not the angle: DIE_SPIN_DWELLS are the hold times (ms) for the first seven
// steps (45°…315°) — they ramp ~50→220 so the die visibly slows as it settles. The
// eighth step lands upright (360°) fused with the recoil: a single scale pop held
// DIE_IMPACT_MS, then a hard snap to rest. Total ≈ 920ms (sum + impact) — under the
// ~1s beat that keeps play snappy. Exported so the timing tests stay self-describing.
export const DIE_SPIN_DWELLS = [50, 66, 86, 110, 142, 180, 216] as const
export const DIE_IMPACT_MS = 70
export const DIE_IMPACT_SCALE = 1.08
const STEP_DEG = 45

// The eight landing frames: seven decelerating spin steps (scale 1) then the recoil
// frame — the final 45° to upright (360°) carrying the scale pop. After the recoil's
// dwell the die snaps to REST (360°, scale 1) and `onSpinComplete` fires.
const SPIN_FRAMES: { angle: number; scale: number; dwell: number }[] = [
  ...DIE_SPIN_DWELLS.map((dwell, i) => ({ angle: (i + 1) * STEP_DEG, scale: 1, dwell })),
  { angle: DIE_SPIN_DWELLS.length * STEP_DEG + STEP_DEG, scale: DIE_IMPACT_SCALE, dwell: DIE_IMPACT_MS },
]
const REST_FRAME = { angle: SPIN_FRAMES.length * STEP_DEG, scale: 1 }

// A fixed square footprint (no circle — the square 1-bit register). The die fills
// it; the numeral centres over it.
const WRAP_CLASS = 'relative inline-flex h-16 w-16 items-center justify-center'
// The stamped result: mono `--font-ui`, centred over the die, inheriting the die's
// currentColor. myth-twraw: the roll is the one moment of chance in the loop, so
// the landed numeral carries REVEAL weight (font-bold) and sits a step LARGER than
// the equation line below — the number lands before the arithmetic explains it.
// The size class precedes `leading-none` (composed at the call site) because a
// font-size utility carries its own line-height — merged the other way round, the
// `leading-none` that keeps a two-digit numeral optically centred would be dropped.
const NUMERAL_BASE_CLASS = 'absolute inset-0 flex items-center justify-center font-ui font-bold'
// The d20 family stamps the numeral INSIDE the central face (myth-ydu35): one step
// below the open shapes so a two-digit value clears the face's slanted edges,
// nudged down to the face's centroid (the face sits below the box centre on the
// 24-grid). text-lg two-digit digits (~20px wide) still clear the ~40px face base.
const NUMERAL_D20_CLASS = 'text-lg translate-y-[4%]'
// The open-centre shapes (d4…d12) keep the larger stamp at the box centre.
const NUMERAL_OPEN_CLASS = 'text-xl'

export const DieSpin = forwardRef<HTMLDivElement, DieSpinProps>(function DieSpin(
  { spinning, result, reducedMotion, onSpinComplete, resultLabel, sides = 20 },
  ref,
) {
  const [frame, setFrame] = useState(REST_FRAME)
  // Hold the latest callback without restarting the stepped schedule when the
  // parent passes a fresh closure each render.
  const doneRef = useRef(onSpinComplete)
  doneRef.current = onSpinComplete

  useEffect(() => {
    if (!spinning) return
    if (reducedMotion) {
      doneRef.current() // no churn — land instantly
      return
    }
    const first = SPIN_FRAMES[0]
    if (first === undefined) return // SPIN_FRAMES is always non-empty; guard for the type checker.
    let timer = 0
    let i = 0
    setFrame({ angle: first.angle, scale: first.scale })
    const tick = (): void => {
      i += 1
      const next = SPIN_FRAMES[i]
      if (next !== undefined) {
        setFrame({ angle: next.angle, scale: next.scale })
        timer = window.setTimeout(tick, next.dwell)
      } else {
        // Recoil dwell elapsed → snap to final rest and fire completion exactly once.
        setFrame(REST_FRAME)
        doneRef.current()
      }
    }
    timer = window.setTimeout(tick, first.dwell)
    return () => {
      window.clearTimeout(timer)
    }
  }, [spinning, reducedMotion])

  const animating = spinning && !reducedMotion
  const transform = animating ? `rotate(${String(frame.angle)}deg) scale(${String(frame.scale)})` : 'rotate(0deg)'
  const showResult = result !== null && !spinning
  const announced = showResult ? (resultLabel ?? '') : ''

  return (
    <div ref={ref} data-testid="die-spin" data-spinning={spinning} className={WRAP_CLASS}>
      {/* The single AT source of truth: the die is decoration, so a polite live
          region carries the landed result (motion is never the only signal). */}
      <VisuallyHidden>
        <span role="status" aria-live="polite" data-testid="die-spin-live">
          {announced}
        </span>
      </VisuallyHidden>

      <svg
        data-testid="die-spin-glyph"
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        className="h-full w-full"
        style={{ transform }}
      >
        <path d={pathForSides(sides)} />
      </svg>

      {showResult && (
        <span
          data-testid="die-spin-result"
          className={cn(
            NUMERAL_BASE_CLASS,
            pathForSides(sides) === D20_OUTLINE_PATH ? NUMERAL_D20_CLASS : NUMERAL_OPEN_CLASS,
            'leading-none',
          )}
        >
          {result}
        </span>
      )}
    </div>
  )
})
