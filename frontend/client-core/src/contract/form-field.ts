import type { ReactNode } from 'react'
import type { BaseProps } from './index.ts'

/**
 * Field wrapper — the labelling / helper / error / required-state contract for a
 * single form control. The single biggest a11y surface a control set is missing
 * on its own: the bare controls (Input / Select / Checkbox / …) deliberately
 * carry no label, and FormField is where labelling, description, error
 * announcement, and required/invalid state are wired together and bound to the
 * control accessibly.
 *
 * The web impl generates a stable id (React `useId`), renders a {@link LabelProps}
 * Label (`htmlFor` = the control id, `required`), clones its single `children`
 * control wired with `{ id, describedBy, invalid, required }`, and renders the
 * description (muted) + error (danger, announced via `role="alert"`) regions
 * whose ids flow back into the control's `describedBy`. Platform-neutral: the
 * contract carries i18n KEYS, not text, and no `className`/`style`/DOM events.
 *
 * `invalid` defaults to `error != null` — supplying an `error` marks the field
 * invalid (and the control `aria-invalid`) without a second flag.
 */
export interface FormFieldProps extends BaseProps {
  /** Label text — an i18n key the consumer resolves. */
  label: string
  /** Optional helper / description text — an i18n key. Shown muted below the control. */
  description?: string
  /** Optional error text — an i18n key. Shown in the danger token + announced (role=alert). */
  error?: string
  /** Marks the field required — flows to the Label marker AND the control's `required`. */
  required?: boolean
  /** The resolved screen-reader word for the required marker (e.g. "(required)"),
   *  forwarded to the Label — the shell resolves i18n and passes it (MYT-100; the
   *  DS owns no copy). Rendered only when `required`. */
  requiredLabel: string
  /** Invalid state. Defaults to `error != null`; supply to force-invalidate without an error string. */
  invalid?: boolean
  /** The single control element (Input / Select / Checkbox / …) this field wraps and wires. */
  children: ReactNode
}
