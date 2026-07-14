import { forwardRef, useEffect, useRef, useState } from 'react'
import type { DieSpinProps } from '@mythrun/client-core/contract'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// DieSpin (MYT-93, spec §5) — the flat 2D OUTLINED d20 the RollCard spins. This
// component (and its story) is the CANONICAL reference for the die glyph: a NEW
// brand mark — no pixelarticons dice exists (searched 2026-07-14) and Miklos
// directed "a 2D outline in some 1-bit register, spun" — so authoring it here is
// sanctioned by spec §5, distinct from the general "no hand-authored glyph" rule.
//
// MOTION — a STEPPED rotation: 8 discrete 45° steps ≈ one ~1s revolution, driven by
// a setInterval step counter, NEVER a smooth CSS transform transition (the motion
// analog of the brand's stepped Bayer dither; deliberately overrides UX §13's
// "smooth" per the brand-overrides-UX rule). On the last step it calls
// `onSpinComplete`. `reducedMotion` → NO spin, `onSpinComplete` fires immediately
// (instant land). Motion is never the only signal: the landed `result` announces
// via a polite live region carrying `resultLabel`.
//
// The `result` numeral stamps in the die CENTRE in `--font-ui` (`font-ui`) once
// landed (result present AND not spinning); it is withheld mid-spin. The die SVG is
// aria-hidden decoration; the numeral does NOT rotate (a sibling of the spun svg),
// so it lands upright.
//
// The step budget + the die geometry are STORY-TUNED constants (Spec Ambiguity #5,
// deferred visual review): structurally correct now (stepped, 8/rev, ~1s,
// reduced-motion instant, --font-ui numeral), eye-tuned at the end-polish pass.

// 8 steps × 125ms ≈ one ~1s revolution. Pixel-honest — each step is a discrete 45°
// jump, not a smooth interpolation.
const STEPS_PER_REV = 8
const STEP_MS = 125
const SPIN_STEPS = STEPS_PER_REV // one full revolution

// The authored d20 outline on the pixelarticons 24-grid (viewBox 0 0 24 24),
// stroked in currentColor (fill none): a pointy-top hexagon silhouette + the top
// facet triangle + three spokes down to the lower vertices — the recognisable
// icosahedron read, left open at the centre so the stamped numeral stays legible.
const D20_OUTLINE_PATH =
  'M12 2 L21 7 L21 17 L12 22 L3 17 L3 7 Z M12 6 L18 16 L6 16 Z M12 2 L12 6 M6 16 L3 17 M18 16 L21 17 M12 16 L12 22'

// A fixed square footprint (no circle — the square 1-bit register). The die fills
// it; the numeral centres over it.
const WRAP_CLASS = 'relative inline-flex h-16 w-16 items-center justify-center'
// The stamped result: mono `--font-ui`, centred over the die, inheriting the die's
// currentColor. `leading-none` keeps a two-digit numeral optically centred.
const NUMERAL_CLASS =
  'absolute inset-0 flex items-center justify-center font-ui text-lg font-semibold leading-none'

export const DieSpin = forwardRef<HTMLDivElement, DieSpinProps>(function DieSpin(
  { spinning, result, reducedMotion, onSpinComplete, resultLabel },
  ref,
) {
  const [step, setStep] = useState(0)
  // Hold the latest callback without restarting the stepped interval when the
  // parent passes a fresh closure each render.
  const doneRef = useRef(onSpinComplete)
  doneRef.current = onSpinComplete

  useEffect(() => {
    if (!spinning) return
    if (reducedMotion) {
      doneRef.current() // no churn — land instantly
      return
    }
    let n = 0
    setStep(0)
    const id = window.setInterval(() => {
      n += 1
      setStep(n % STEPS_PER_REV)
      if (n >= SPIN_STEPS) {
        window.clearInterval(id)
        doneRef.current()
      }
    }, STEP_MS)
    return () => {
      window.clearInterval(id)
    }
  }, [spinning, reducedMotion])

  const angle = spinning && !reducedMotion ? (step * 360) / STEPS_PER_REV : 0
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
        style={{ transform: `rotate(${String(angle)}deg)` }}
      >
        <path d={D20_OUTLINE_PATH} />
      </svg>

      {showResult && (
        <span data-testid="die-spin-result" className={NUMERAL_CLASS}>
          {result}
        </span>
      )}
    </div>
  )
})
