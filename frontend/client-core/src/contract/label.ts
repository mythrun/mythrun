import type { BaseProps } from './index.ts'

/**
 * Form-control label. The web impl renders a native `<label htmlFor>` in the
 * `ui-label` type role (mono, uppercase, tracked); the native impl renders a
 * platform label bound to the same control id behind this contract. Used
 * directly by {@link FormFieldProps}, which owns the control id and passes it as
 * `htmlFor`. Platform-neutral: no `className`/`style`/raw DOM events.
 *
 * `required` renders a visible required marker that ALSO carries meaning to
 * assistive tech (not color alone) — the control's own `required` is what sets
 * `aria-required`; this marker is the matching visual + SR-text affordance, and
 * its SR word arrives via the resolved `requiredLabel` (the DS owns no copy).
 *
 * `children` is the label text (an i18n key the consumer resolves).
 */
export interface LabelProps extends BaseProps {
  /**
   * The id of the control this labels. Renders as the native `htmlFor`
   * association on web; a platform label-for relationship on native.
   */
  htmlFor?: string
  /** Marks the labelled control required — renders a meaning-carrying marker. */
  required?: boolean
  /** The resolved screen-reader word for the required marker (e.g. "(required)")
   *  — the shell resolves i18n and passes it (MYT-100; the DS owns no copy).
   *  Rendered only when `required`. */
  requiredLabel: string
}
