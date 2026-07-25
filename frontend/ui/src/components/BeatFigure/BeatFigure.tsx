import { forwardRef, useCallback, useRef } from 'react'
import { cn } from '../../lib/cn.ts'
import { CELL_PX, ROWS, clamp01 } from './develop.ts'
import { useBeatCanvas, type BeatMode } from './use-beat-canvas.ts'

// BeatFigure — the loading-beat family's shared FULL-WIDTH quantized dither figure. A single
// decorative canvas (aria-hidden; the composing beat owns the a11y live region) that either
// FILLS as a quantized meter (`mode="fill"`, driven by a 0..1 `level`) or BREATHES as an
// indeterminate density field (`mode="breathe"`). All motion is cells-as-units: hard binary
// dither, position advancing in discrete quantized frames, texture alive only at the front
// band — see develop.ts (pure math) + use-beat-canvas.ts (the rAF/measure/paint controller).
//
// TONE. `token` (default) is the theme-flipping pair — `--ink` cells on a `--surface` ground
// with a crisp `border-ink` frame. This is the composing choice now that the figure is
// FULL-WIDTH: the small shipped 1-bit tiles could be a frozen-paper relic (a postage-stamp
// panel on the card), but a full-width frozen-paper band turns the empty track into a bright
// paper SLAB on the dark card — it fights badly and inverts the progress read (verified in
// Storybook, both themes). Tokened, the ink grows light-on-dark in dark and dark-on-light in
// light — correct in both. `paper` keeps the frozen relic (`--color-paper-*`, identical in both
// themes) for a small tile that wants it.
//
// The canvas is inert under jsdom (no 2D context), so the figure is a plain aria-hidden box in
// tests; `data-beat-mode` / `data-beat-level` expose the target for inspection without pixels.

/** Which token pair the figure paints with. `muted` keeps the theme-flipping
 *  ink cells but frames with the panel-weight `border-border` stroke — for a
 *  figure INSIDE a bordered card, where the ink frame would out-weigh its
 *  containing panel (ux-run2 myth-zyk6o). */
type BeatTone = 'paper' | 'token' | 'muted'

const TONE_CLASS: Record<BeatTone, string> = {
  paper: 'border-paper-900 bg-paper-50',
  token: 'border-ink bg-surface',
  muted: 'border-border bg-surface',
}

const TONE_INK_VAR: Record<BeatTone, string> = {
  paper: '--color-paper-900',
  token: '--ink',
  muted: '--ink',
}

export interface BeatFigureProps {
  /** `fill` = a quantized progress meter; `breathe` = an indeterminate density field. */
  mode: BeatMode
  /** Fill mode: 0..1 target progress (clamped). Ignored in breathe mode. */
  level?: number
  /** Honour reduced motion — a legible static frame, position lands instantly, no ticks. */
  reducedMotion: boolean
  /** Meter height in cells (defaults to the family's ROWS). */
  rows?: number
  /** Token pair (frozen paper relic vs theme-flipping ink). */
  tone?: BeatTone
  'data-testid'?: string
}

export const BeatFigure = forwardRef<HTMLDivElement, BeatFigureProps>(function BeatFigure(
  { mode, level = 0, reducedMotion, rows = ROWS, tone = 'token', 'data-testid': dataTestId },
  ref,
) {
  // The wrapper is BOTH the measured element (the controller reads its clientWidth) and the
  // forwarded ref target — a callback ref merges the two without a type assertion.
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const setWrap = useCallback(
    (node: HTMLDivElement | null): void => {
      wrapRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref !== null) ref.current = node
    },
    [ref],
  )
  const clampedLevel = clamp01(level)

  useBeatCanvas({ wrapRef, canvasRef, mode, level: clampedLevel, rows, reducedMotion, inkVar: TONE_INK_VAR[tone] })

  return (
    <div
      ref={setWrap}
      aria-hidden="true"
      data-beat-mode={mode}
      {...(mode === 'fill' ? { 'data-beat-level': clampedLevel } : {})}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
      className={cn('relative block w-full overflow-hidden border-[1.5px]', TONE_CLASS[tone])}
      style={{ height: `${String(rows * CELL_PX)}px` }}
    >
      {/* The controller owns the canvas width (crisp cols·CELL_PX) once measured; the height is
          reserved by the wrapper so there is no layout shift before the first paint. */}
      <canvas ref={canvasRef} className="block" style={{ height: `${String(rows * CELL_PX)}px` }} />
    </div>
  )
})
