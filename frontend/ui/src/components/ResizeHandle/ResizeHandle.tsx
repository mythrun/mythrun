import { useCallback, useRef } from 'react'
import { cn } from '../../lib/cn.ts'

// ResizeHandle (MYT-100) — a draggable vertical divider for horizontally resizing
// a docked panel (the wiki sidebar). The WAI-ARIA window-splitter pattern:
// role="separator", aria-orientation vertical, focusable, with aria-valuenow/min/
// max so assistive tech reads (and the arrow keys nudge) the width; pointer drag
// resizes live. CONTROLLED — `value` is the resized panel's current width in px,
// `onChange` reports the new CLAMPED width as a plain number (never a DOM event,
// §9). Square / paper register: a thin hairline rule inside a comfortable grab
// area, thickening + accenting on hover/focus so the grabbable edge is legible —
// no grip dots (state as line-weight, not decoration).

export interface ResizeHandleProps {
  /** The resized panel's current width (px). */
  value: number
  /** Clamp floor / ceiling (px). */
  min: number
  max: number
  /** Reports the new clamped width (px) on drag / keyboard nudge. */
  onChange: (width: number) => void
  /** Which edge of the resized panel the handle sits on. A 'leading' handle — the
   *  LEFT edge of a right-docked panel — widens the panel as it's dragged left;
   *  'trailing' widens as it's dragged right. Default 'leading'. */
  edge?: 'leading' | 'trailing'
  /** Keyboard nudge step (px). Default 24. */
  step?: number
  /** Accessible name (the DS owns no copy). */
  label: string
}

const HANDLE_CLASS = cn(
  'group relative flex w-[var(--space-3)] shrink-0 touch-none select-none items-stretch justify-center',
  'cursor-col-resize rounded-none',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)

// The visible rule: a 1px hairline centred in the grab area that thickens +
// accents on hover/focus — the grabbable edge, legible without grip dots.
const RULE_CLASS = cn(
  'w-px bg-border-strong transition-[width,background-color]',
  'group-hover:w-[2px] group-hover:bg-accent-fg',
  'group-focus-visible:w-[2px] group-focus-visible:bg-accent-fg',
)

/** Guarded pointer capture — jsdom (tests) doesn't implement it, so a missing/
 *  throwing method is swallowed; the drag still works via the move handler. */
function capture(el: Element, pointerId: number, on: boolean): void {
  try {
    if (on) el.setPointerCapture(pointerId)
    else el.releasePointerCapture(pointerId)
  } catch {
    // No pointer capture in this environment — non-fatal.
  }
}

export function ResizeHandle({ value, min, max, onChange, edge = 'leading', step = 24, label }: ResizeHandleProps): React.JSX.Element {
  const drag = useRef<{ startX: number; startValue: number } | null>(null)
  // A leading handle widens as the pointer moves LEFT (negative Δx), so invert.
  const dir = edge === 'leading' ? -1 : 1
  const clamp = useCallback((w: number) => Math.min(max, Math.max(min, w)), [min, max])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault()
    capture(e.currentTarget, e.pointerId, true)
    drag.current = { startX: e.clientX, startValue: value }
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d === null) return
    onChange(clamp(d.startValue + (e.clientX - d.startX) * dir))
  }
  const endDrag = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (drag.current === null) return
    capture(e.currentTarget, e.pointerId, false)
    drag.current = null
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    // ArrowLeft moves the divider left, ArrowRight moves it right — width follows
    // the handle's edge (a leading handle widens leftward).
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      onChange(clamp(value + -step * dir))
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      onChange(clamp(value + step * dir))
    } else if (e.key === 'Home') {
      e.preventDefault()
      onChange(min)
    } else if (e.key === 'End') {
      e.preventDefault()
      onChange(max)
    }
  }

  return (
    // A fragment brackets the WAI-ARIA window-splitter suppression: jsx-a11y treats
    // role="separator" as non-interactive, but a focusable, keyboard-operable
    // separator with aria-orientation + aria-value* IS the sanctioned resize-divider
    // pattern (ARIA Authoring Practices "Window Splitter"). axe agrees (see the test).
    <>
      {/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- WAI-ARIA window-splitter: an interactive, focusable role="separator" resize divider */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={min}
        aria-valuemax={max}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onKeyDown={onKeyDown}
        className={HANDLE_CLASS}
      >
        <span aria-hidden="true" className={RULE_CLASS} />
      </div>
      {/* eslint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
    </>
  )
}
