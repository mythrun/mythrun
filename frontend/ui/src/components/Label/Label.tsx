import { forwardRef } from 'react'
import type { LabelProps } from '@mythrun/client-core/contract'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// Form-control label — a REAL native <label htmlFor> (real label/control
// association + a11y), in the `ui-label` type role (mono, uppercase, tracked).
// Used by FormField, which owns the control id and passes it as `htmlFor`. The
// label text is the children (an i18n key the consumer resolves).
//
// required (§4 / a11y): the control's own `required` is what sets
// `aria-required` (FormField forwards it to the control). This marker is the
// MATCHING affordance on the label so the requirement reads visually too —
// without relying on color alone:
//   • a visible ember asterisk, `aria-hidden` (decorative — its meaning would be
//     opaque to AT spoken as "asterisk"),
//   • a VisuallyHidden required word (the resolved `requiredLabel` prop) so a
//     screen reader announces the requirement in words when reading the label.
// (MYT-100 lifted that SR word out of the component — the shell resolves i18n and
// passes it; the DS owns no copy.)
export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { htmlFor, required = false, requiredLabel, children, ...rest },
  ref,
) {
  return (
    <label ref={ref} htmlFor={htmlFor} className={TYPE_ROLE_CLASS['ui-label']} {...rest}>
      {children}
      {required && (
        <>
          {' '}
          <span aria-hidden="true" className="text-accent-fg">
            *
          </span>
          <VisuallyHidden>{requiredLabel}</VisuallyHidden>
        </>
      )}
    </label>
  )
})
