import { forwardRef } from 'react'
import type { Breakpoint, ShowProps } from '@mythrun/client-core/contract'

// Show — the responsive show/hide primitive. A breakpoint SWITCH between two
// visually distinct layouts (the hub's desktop card grid vs its mobile index
// list): it renders its children and toggles visibility at the breakpoint, so a
// pair of sibling Shows (`above` ⊕ `below` the same step) shows exactly one. The
// hidden branch is `display:none` — out of layout AND the a11y tree, so the
// off-screen layout's headings/links never leak to assistive tech.
//
// Full static class strings per breakpoint (NOT a `${bp}:block` template):
// Tailwind v4 scans SOURCE TEXT for class names, so an interpolated variant would
// never be generated. Each literal here is complete so the scanner emits it.

/** `above` = hidden below the step, shown at/above it. */
const ABOVE_CLASS: Record<Breakpoint, string> = {
  sm: 'hidden sm:block',
  md: 'hidden md:block',
  lg: 'hidden lg:block',
  xl: 'hidden xl:block',
  '2xl': 'hidden 2xl:block',
}

/** `below` = shown below the step, hidden at/above it. */
const BELOW_CLASS: Record<Breakpoint, string> = {
  sm: 'block sm:hidden',
  md: 'block md:hidden',
  lg: 'block lg:hidden',
  xl: 'block xl:hidden',
  '2xl': 'block 2xl:hidden',
}

/** Resolve the visibility class from the XOR props. `above !== undefined`
 *  discriminates the union, so the `below` branch sees a defined breakpoint. */
function visibilityClass(props: ShowProps): string {
  return props.above !== undefined ? ABOVE_CLASS[props.above] : BELOW_CLASS[props.below]
}

export const Show = forwardRef<HTMLDivElement, ShowProps>(function Show(props, ref) {
  const { children, 'data-testid': dataTestId } = props
  return (
    <div
      ref={ref}
      className={visibilityClass(props)}
      {...(dataTestId !== undefined ? { 'data-testid': dataTestId } : {})}
    >
      {children}
    </div>
  )
})
