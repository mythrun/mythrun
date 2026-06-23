import { forwardRef, useId } from 'react'
import type { ComponentPropsWithoutRef, Ref } from 'react'
import { cn } from '../../lib/cn.ts'
import type { SeamlessInputProps } from '@mythrun/client-core/contract'

// SeamlessInput — the borderless "ghost" creation-flow field (working name; see
// the contract for the rename note). A REAL native control with the box stripped
// so the screen reads as "the question, then just the answer + a blinking
// caret" — the calm, one-question-at-a-time (Typeform-style) world-creation
// flow. `<input>` by default; `<textarea>` (auto-growing) when `multiline`.
//
// The DESIGN LANGUAGE of a ghost input (built correctly, not improvised):
//
//  1. No box — `border-0 bg-transparent`: the field is just text + caret. (The
//     ONE border it keeps is the bottom baseline rule, see #5.)
//  2. Display-size PROSE type — `font-body` (Source Serif 4, the brand's
//     narrative-serif face) at `text-2xl` (1.75rem / 28px) with relaxed
//     `leading-[1.4]`. The serif body face is the "magical" register (vs the
//     mono `font-ui` data face the boxed Input uses — inputs are data; a
//     world's NAME is prose). Headline scale matches how conversational forms
//     render the answer.
//  3. Branded caret — `caret-accent` (the ember caret) so the cursor is legible
//     + intentional against parchment.
//  4. The question IS the label — a prominent, programmatically-ASSOCIATED
//     `<label htmlFor>` rendered ABOVE the field (the persistent visible label,
//     WCAG 3.3.2). The field's accessible name is the question.
//  5. A NON-BOX focus affordance (WCAG 2.4.13, CRITICAL) — a borderless field
//     with the outline removed would have NO focus indicator. So: a thin bottom
//     baseline rule in the low-emphasis `--border` token when unfocused, which
//     THICKENS to 2px and colors to `--accent` on `:focus-visible`. The default
//     box outline is removed (`focus-visible:outline-none`) BECAUSE the accent
//     baseline IS the indicator — the 1px-subtle → 2px-accent change clears the
//     ≥2px-area + ≥3:1-change-contrast bar. (The caret alone is NOT a WCAG focus
//     indicator, so it can't carry this.)
//  6. Placeholder — a FAINT hint only (`placeholder:text-ink-tertiary`), never
//     the label.
//
// Neutral `onChange(value)` (§9 — pulls `e.target.value`, hands the consumer a
// plain string) exactly like Input. `...rest` is spread onto the field so the
// FLOW can drive `autoFocus` / `onKeyDown` (autofocusing each step is the
// consumer's concern — we just don't block it). The DOM passthrough lives only
// in the impl's local prop widening; the exported `SeamlessInputProps` contract
// stays DOM-free (R2 / api-purity).

// The full, STATIC token class string for the ghost field. Authored as a single
// literal (Tailwind v4 scans source text — a template-built class would never be
// generated). Shared verbatim by the <input> and <textarea> arms so they read
// and focus identically; the multiline arm appends its auto-grow classes.
const FIELD_CLASS = cn(
  'block w-full font-body text-2xl leading-[1.4] text-ink',
  // No box: 0px corners (flat 1-bit), no border, transparent fill.
  'rounded-none border-0 bg-transparent',
  // Branded ember caret.
  'caret-accent',
  // Faint placeholder hint (never the label).
  'placeholder:text-ink-tertiary',
  // The NON-BOX focus affordance (WCAG 2.4.13): a thin low-emphasis baseline
  // rule that thickens + colors to accent on focus; the box outline is removed
  // because the baseline IS the indicator.
  'border-b border-border',
  'focus-visible:outline-none focus-visible:border-b-2 focus-visible:border-accent',
  // Disabled: muted ink + non-interactive cursor (a11y-exempt inactive control).
  'disabled:cursor-not-allowed disabled:text-ink-tertiary',
)

// Multiline auto-grow: `field-sizing-content` (Tailwind v4 / native) sizes the
// textarea to its content so long world-creation prose grows the field instead
// of scrolling; `resize-none overflow-hidden` keeps it a clean ghost surface
// (no resize handle, no inner scrollbar) since the height tracks the text.
const MULTILINE_CLASS = 'field-sizing-content resize-none overflow-hidden'

// The label sits ABOVE the field in the brand's serif `title` register so the
// question reads as the prominent prompt (not the mono ui-label chrome the boxed
// FormField uses — this is a conversational question, not a form-field caption).
const LABEL_CLASS = cn('block mb-[var(--space-3)] font-body text-lg font-semibold leading-[1.4] text-ink')

// The impl accepts the platform-neutral contract PLUS the native field's own DOM
// props (autoFocus, onKeyDown, ...) so the flow can drive them via `...rest`.
// `onChange` is omitted from the DOM extras — the contract's neutral
// `onChange(value)` wins (the impl maps it to the native event). This widening
// is LOCAL to the impl; the exported contract stays DOM-free (R2). Both native
// arms share the common DOM attrs (autoFocus / onKeyDown / etc.); element-only
// props (e.g. `rows`) aren't part of the ghost contract by design.
type NativeFieldExtras = Omit<
  ComponentPropsWithoutRef<'input'> & ComponentPropsWithoutRef<'textarea'>,
  keyof SeamlessInputProps | 'onChange' | 'children'
>

type SeamlessInputElement = HTMLInputElement | HTMLTextAreaElement

export const SeamlessInput = forwardRef<SeamlessInputElement, SeamlessInputProps & NativeFieldExtras>(
  function SeamlessInput(
    {
      label,
      value,
      defaultValue,
      onChange,
      placeholder,
      multiline = false,
      name,
      id,
      describedBy,
      disabled = false,
      required = false,
      ...rest
    },
    ref,
  ) {
    // Auto-generate a stable id to wire label↔field when the consumer omits one,
    // so the question always names the answer for AT with zero wiring.
    const generatedId = useId()
    const fieldId = id ?? generatedId

    // The neutral value callback: pull the string off whichever native event
    // (input or textarea) fires, never leak the DOM ChangeEvent to the consumer.
    const handleChange = onChange
      ? (e: { target: { value: string } }) => {
          onChange(e.target.value)
        }
      : undefined

    // Shared native attributes — the controlled/uncontrolled value shape, the
    // a11y relationships, and the form wiring, identical across both arms.
    const shared = {
      id: fieldId,
      value,
      defaultValue,
      onChange: handleChange,
      placeholder,
      name,
      'aria-describedby': describedBy,
      disabled,
      required,
    }

    return (
      <div>
        <label htmlFor={fieldId} className={LABEL_CLASS}>
          {label}
        </label>
        {multiline ? (
          <textarea
            ref={ref as Ref<HTMLTextAreaElement>}
            {...shared}
            className={cn(FIELD_CLASS, MULTILINE_CLASS)}
            {...rest}
          />
        ) : (
          <input
            ref={ref as Ref<HTMLInputElement>}
            type="text"
            {...shared}
            className={FIELD_CLASS}
            {...rest}
          />
        )}
      </div>
    )
  },
)
