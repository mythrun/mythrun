import { forwardRef, useId, Children, cloneElement, isValidElement } from 'react'
import type { ReactElement } from 'react'
import type { FormFieldProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Label } from '../Label/Label.tsx'

// FormField — the labelling / helper / error / required-state wrapper for a
// single form control. This is where the bare controls (which deliberately
// carry NO label) get an associated <Label>, optional helper + error text, and
// required/invalid state, all wired to the control for accessibility.
//
// a11y wiring (the headline deliverable):
//   • useId() seeds a stable id family → the control id (Label.htmlFor binds the
//     accessible NAME), a description id, and an error id.
//   • the single child control is cloned with the NEUTRAL, PORTABLE props the
//     control contracts expose — { id, describedBy, invalid, required } — never
//     raw DOM attrs. `describedBy` is the space-joined ids of whichever of the
//     description / error regions are present (web impls render it as
//     aria-describedby; native maps it later). FormField's wiring is
//     AUTHORITATIVE: the cloned props override anything the child set.
//   • the description renders muted (`--ink-secondary`, ui-caption); the error
//     renders in the danger token AND with role="alert" so it is BOTH
//     programmatically associated (via describedBy) AND announced.
//   • `invalid` defaults to `error != null` — supplying an error invalidates the
//     control without a second flag.
//
// `cloneElement` on the single child is React-core (portable). A non-single /
// non-element child fails LOUD via Children.only rather than silently rendering
// nothing.

/** The neutral a11y props FormField injects into its cloned child control. */
interface WiredControlProps {
  id: string
  describedBy?: string
  invalid: boolean
  required: boolean
}

export const FormField = forwardRef<HTMLDivElement, FormFieldProps>(function FormField(
  { label, description, error, required = false, requiredLabel, invalid, children },
  ref,
) {
  const baseId = useId()
  const controlId = `${baseId}-control`
  const descriptionId = `${baseId}-description`
  const errorId = `${baseId}-error`

  const hasDescription = description !== undefined
  const hasError = error !== undefined
  // error implies invalid (the default); an explicit `invalid` can force it.
  const isInvalid = invalid ?? hasError

  // The describedBy relationship is the space-joined ids of the regions that are
  // actually rendered — undefined when neither exists (so the control sets no
  // empty aria-describedby).
  const describedByIds = [hasDescription ? descriptionId : null, hasError ? errorId : null].filter(
    (id): id is string => id !== null,
  )
  const describedBy = describedByIds.length > 0 ? describedByIds.join(' ') : undefined

  // Exactly one valid element child — fail loud otherwise (the control to wire).
  // Children.only throws on a non-single child; isValidElement guards the
  // string/number/null cases with a clear, FormField-specific message.
  const only = Children.only(children)
  if (!isValidElement(only)) {
    throw new Error('FormField expects a single valid React element child (the control to label).')
  }
  const control = only as ReactElement<Partial<WiredControlProps>>

  const wiring: WiredControlProps = {
    id: controlId,
    invalid: isInvalid,
    required,
    ...(describedBy !== undefined ? { describedBy } : {}),
  }
  const wiredControl = cloneElement(control, wiring)

  return (
    <Stack ref={ref} gap={1}>
      <Label htmlFor={controlId} required={required} requiredLabel={requiredLabel}>
        {label}
      </Label>
      {wiredControl}
      {/* Helper / error regions are raw library-zone elements (not <Text>): they
          need an `id` (for the describedBy relationship), a status token color,
          and — for the error — `role="alert"`, none of which <Text>'s minimal
          DOM-free contract exposes. The `ui-caption` type role is shared via
          TYPE_ROLE_CLASS; the colors are tokens (--ink-secondary / --text-danger). */}
      {hasDescription && (
        <span id={descriptionId} className={cn(TYPE_ROLE_CLASS['ui-caption'], 'text-ink-secondary')}>
          {description}
        </span>
      )}
      {hasError && (
        <span
          id={errorId}
          role="alert"
          className={cn(TYPE_ROLE_CLASS['ui-caption'], 'text-text-danger')}
        >
          {error}
        </span>
      )}
    </Stack>
  )
})
