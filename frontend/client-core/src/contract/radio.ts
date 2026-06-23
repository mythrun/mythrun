import type { BaseProps } from './index.ts'

/**
 * A single radio option within a {@link RadioGroupProps}. The web impl wraps the
 * Radix `RadioGroup.Item`; it MUST be rendered inside a `RadioGroup` (which owns
 * the value, name, and keyboard roving-tabindex). Platform-neutral: no
 * `className`/`style`/raw DOM events; selection state is owned by the group.
 */
export interface RadioProps extends BaseProps {
  /** This option's value — reported by the group's `onChange` when selected. */
  value: string
  /** Optional inline label (an i18n key). Full labelling is FormField's job. */
  label?: string
  /** Disable just this option (the group can also disable all options). */
  disabled?: boolean
  /** Element id — lets a consumer-supplied `<label htmlFor>` bind to this option. */
  id?: string
}

/**
 * Radio group — a single-select set of mutually exclusive {@link RadioProps}
 * options. The web impl wraps the unstyled Radix `RadioGroup` primitive (arrow-
 * key roving selection, ARIA `radiogroup`/`radio`, hidden form input), styled
 * with our tokens; the native impl swaps `rn-primitives` behind the same
 * contract. Platform-neutral: `onChange` is the neutral value callback (§9 —
 * receives the selected string, never a DOM event), and the surface carries no
 * `className`/`style`/raw DOM events.
 *
 * Controlled when `value` is supplied; uncontrolled with `defaultValue`
 * otherwise (the standard controlled/uncontrolled shape, §9). `children` are the
 * `Radio` items.
 */
export interface RadioGroupProps extends BaseProps {
  /** Controlled selected value. When supplied the group is controlled. */
  value?: string
  /** Uncontrolled initial value. Ignored when `value` is supplied. */
  defaultValue?: string
  /** Neutral value callback — receives the selected string, not a DOM event (§9). */
  onChange?: (value: string) => void
  /** Form field name shared by every option (submitted with the form). */
  name?: string
  /** Disable the whole group. Individual options may also be disabled. */
  disabled?: boolean
  /**
   * Invalid state: sets `aria-invalid` on the group + the 2px danger border on
   * each item (mirrors Checkbox — the danger edge wins over a selected item's
   * accent border). The error is conveyed to AT (aria-invalid) AND visually, not
   * by color alone. {@link FormFieldProps} drives this from its error state.
   */
  invalid?: boolean
  /** Element id for the group container (the radiogroup landmark). */
  id?: string
  /**
   * Ids of the elements that DESCRIBE this group (helper / error text). A
   * portable a11y RELATIONSHIP (web → `aria-describedby` on the radiogroup, native →
   * `accessibilityDescribedBy` later), not a raw DOM attribute. {@link FormFieldProps}
   * sets this to its helper/error region ids; space-join multiple ids.
   */
  describedBy?: string
}
