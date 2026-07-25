import { forwardRef, useCallback, useEffect, useId, useRef } from 'react'
import type { ComponentPropsWithoutRef, ForwardedRef, Ref } from 'react'
import { cn } from '../../lib/cn.ts'
import type { SeamlessInputProps } from '@mythrun/client-core/contract'

// SeamlessInput — the creation-flow's PROSE field (working name; see the contract
// for the rename note). A REAL native control that reads as "the question, then a
// calm sheet of paper to write on" — the one-question-at-a-time (Typeform-style)
// world-creation flow. `<input>` by default; `<textarea>` (auto-growing) when
// `multiline`.
//
// AFFORDANCE FIRST (MYT-100 create-flow polish). The earlier build stripped the
// field to a bare baseline rule in the low-emphasis `--border` token (1.5:1 —
// decorative grade): a transparent region with a hairline under it, sitting
// between the serif question above and the caption below. In real use it did not
// read as an input at all — no defined area, no obvious cursor, the hairline read
// as a text separator, not a field. The fix is the DS's own accepted input idiom
// (Input / TextArea): a quiet paper field the eye can't mistake for prose —
//
//  1. A defined field — `bg-surface` ground + a square (`rounded-none`, flat
//     1-bit) `border border-border-strong` (the 3:1 interactive-grade edge, NOT
//     the decorative `--border`) + comfortable padding. The box IS the "write
//     here" signal; a bare underline is not enough (users miss it, especially
//     amid similar-looking text). This matches TextArea exactly.
//  2. Display-size PROSE type — `font-body` (Source Serif 4, the brand's
//     narrative-serif face) at `text-2xl` (1.75rem / 28px), relaxed
//     `leading-[1.4]`. The serif body face is what still distinguishes this from
//     the mono `font-ui` DATA field (Input/TextArea): inputs are data; a world's
//     name / concept is prose. This is the ONE thing that stays "seamless".
//  3. Branded caret — `caret-accent-fg` (the foreground-accent ember caret) so
//     the cursor is legible + intentional against parchment in BOTH themes.
//     (Verified rendering ember, not a background-matching token; the earlier
//     "no cursor" was the missing field, not the caret color.)
//  4. The question IS the label — a prominent, programmatically-ASSOCIATED
//     `<label htmlFor>` rendered ABOVE the field (the persistent visible label,
//     WCAG 3.3.2). The field's accessible name is the question.
//  5. Focus (WCAG 2.4.13) — the shared DS focus ring: a 2px hard square
//     `outline-accent-fg` at a 2px offset (theme-aware; == `--focus-ring-color`).
//     Same indicator as every other control, so focus reads consistently.
//  6. Placeholder — a FAINT hint only (`placeholder:text-ink-tertiary`), never
//     the label.
//
// Neutral `onChange(value)` (§9 — pulls `e.target.value`, hands the consumer a
// plain string) exactly like Input. `...rest` is spread onto the field so the
// FLOW can drive `autoFocus` / `onKeyDown` (autofocusing each step is the
// consumer's concern — we just don't block it). The DOM passthrough lives only
// in the impl's local prop widening; the exported `SeamlessInputProps` contract
// stays DOM-free (R2 / api-purity).

// The full, STATIC token class string for the field. Authored as a single
// literal (Tailwind v4 scans source text — a template-built class would never be
// generated). Shared verbatim by the <input> and <textarea> arms so they read
// and focus identically; the multiline arm appends its auto-grow classes.
const FIELD_CLASS = cn(
  // Reading-scale serif (ux-run2 myth-x9ugl: 28px field text pushed the second
  // question + the CTA under the fold; 22px keeps the literary register AND the
  // 720px viewport budget — question 1 + question 2 + CTA all inside the fold).
  'block w-full font-body text-xl leading-[1.4] text-ink',
  // A defined paper field: surface ground + a square (flat 1-bit) interactive-
  // grade border + breathing padding — the unmistakable "write here" area. Mirrors
  // the DS Input/TextArea affordance so this reads as a real field, not prose.
  'rounded-none border border-border-strong bg-surface',
  'px-[var(--space-4)]',
  // Branded ember caret — the FOREGROUND accent (--accent-fg) so the cursor reads
  // against the paper ground in BOTH themes (the fill --accent is too dark in dark).
  'caret-accent-fg',
  // Faint placeholder hint (never the label).
  'placeholder:text-ink-tertiary',
  // Focus: ONE contiguous accent stroke (ux-run2 myth-1pzjw — the 2px-offset
  // ring over the field's own border read as a pressed-button/error DOUBLE
  // rule). The outline hugs the border (offset 0) and the border flips to the
  // same accent, so both read as a single distinctive sienna stroke; still the
  // 2px theme-aware accent indicator (WCAG 2.4.13).
  'focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent-fg focus-visible:border-accent-fg',
  // Disabled: muted ink + non-interactive cursor, ground/edge held (a11y-exempt).
  'disabled:cursor-not-allowed disabled:text-ink-tertiary disabled:bg-surface disabled:border-border-strong',
)

// The single-line (title) arm: a TRUE one-line field (~48px — compact vertical
// padding; ux-run2 myth-1pzjw: a ~70px tall single-line box implied a paragraph
// answer), whose overflow resolves to an ellipsis when unfocused instead of
// clipping mid-word flush against the border.
const SINGLE_LINE_CLASS = 'py-[var(--space-2)] text-ellipsis'

// Multiline auto-grow: `field-sizing-content` (Tailwind v4 / native) sizes the
// textarea to its content so long world-creation prose grows the field instead
// of scrolling — up to a cap of ~14 visible lines clamped at 55dvh (ux-run3
// myth-en2jj raised the old 8-line cap: the field grows generously with a long
// concept, to at most ~55% of the viewport), past which the field scrolls
// internally (`overflow-y-auto`). `resize-none` keeps the clean ghost surface
// (no resize handle). A prose-inviting FLOOR (`min-h` of ~4 lines + padding,
// tracked in `1lh`/token units so it follows the type scale) keeps an empty
// concept field from collapsing to a single-line box — the box should look like
// it wants a paragraph, not a search bar (ux-run1 0xao0 / screen 009).
//
// The OVERFLOW GUARD (ux-run3 myth-en2jj — the critic watched the field
// horizontally guillotine the player's own last line under the bottom rule):
//  1. bottom padding of one full line-height (`pb-[1lh]`), so at the browser's
//     caret-follow scroll the last line sits a full line above the edge;
//  2. an alpha-carrier mask (`black` paints nothing — a mask reads only alpha)
//     fading the bottom 1lh, so a mid-scroll line dissolves instead of being
//     sliced mid-glyph;
//  3. the border/ground/focus chrome moves to a SHELL wrapper — a mask clips
//     everything the element paints, border included, and the field's bottom
//     rule must hold. The shell shows the focus stroke via `:has()`.
const MULTILINE_CLASS = cn(
  'field-sizing-content resize-none overflow-y-auto pt-[var(--space-3)] pb-[1lh]',
  'min-h-[calc(4*1lh+var(--space-3)+1lh)] max-h-[min(calc(14*1lh+var(--space-3)+1lh),55dvh)]',
  'border-0 bg-transparent focus-visible:outline-none',
  '[mask-image:linear-gradient(to_bottom,black_calc(100%-1lh),transparent)]',
)
// The multiline shell: the same defined-paper chrome the flat field wears, with
// the one-contiguous-accent-stroke focus (ux-run2 myth-1pzjw) driven by the
// inner textarea's focus state.
const MULTILINE_SHELL_CLASS = cn(
  'rounded-none border border-border-strong bg-surface',
  'has-[textarea:focus-visible]:outline-2 has-[textarea:focus-visible]:outline-offset-0',
  'has-[textarea:focus-visible]:outline-accent-fg has-[textarea:focus-visible]:border-accent-fg',
)

// `field-sizing: content` is the CSS path (Chrome/Safari). Firefox doesn't support
// it yet, so without a fallback the textarea stays its default height and the
// `overflow-hidden` clips the text with no scrollbar. Feature-detect and, when
// absent, drive the height in JS instead.
const supportsFieldSizing = () =>
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

// Merge the forwarded ref with our internal one so the JS fallback can read the
// textarea node while the consumer keeps their own ref.
const setTextareaRefs =
  (internal: { current: HTMLTextAreaElement | null }, forwarded: ForwardedRef<HTMLTextAreaElement>) =>
  (node: HTMLTextAreaElement | null) => {
    internal.current = node
    if (typeof forwarded === 'function') forwarded(node)
    else if (forwarded) forwarded.current = node
  }

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
      focusOnMount = false,
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

    // Firefox fallback for the multiline auto-grow (no CSS field-sizing): the
    // classic resize — reset to `auto`, then set height to the full scrollHeight
    // so the field grows to fit the content. The CSS `max-h` cap clamps the
    // rendered height on both paths (the inline height may exceed it; CSS wins),
    // past which `overflow-y-auto` scrolls internally. Only runs for `multiline`
    // AND when field-sizing is unsupported, so Chrome/Safari pay nothing.
    const innerRef = useRef<HTMLTextAreaElement | null>(null)
    const resizeToContent = useCallback(() => {
      const el = innerRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = `${String(el.scrollHeight)}px`
    }, [])
    useEffect(() => {
      if (!multiline || supportsFieldSizing()) return
      const el = innerRef.current
      if (!el) return
      resizeToContent() // initial + on controlled-value change (value is a dep)
      el.addEventListener('input', resizeToContent)
      return () => {
        el.removeEventListener('input', resizeToContent)
      }
    }, [multiline, value, defaultValue, resizeToContent])

    // Shared native attributes — the controlled/uncontrolled value shape, the
    // a11y relationships, and the form wiring, identical across both arms. The
    // contract's platform-neutral focusOnMount maps to native autoFocus here
    // (a spread, not a literal JSX attribute — the jsx-a11y autofocus lint
    // keeps guarding accidental uses; this is the deliberate DS opt-in).
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
      ...(focusOnMount && { autoFocus: true }),
    }

    return (
      <div>
        <label htmlFor={fieldId} className={LABEL_CLASS}>
          {label}
        </label>
        {multiline ? (
          // The shell carries the border/ground/focus chrome the fade mask
          // would otherwise clip off the field (see MULTILINE_CLASS rationale).
          <div data-testid="seamless-fade-shell" className={MULTILINE_SHELL_CLASS}>
            <textarea
              ref={setTextareaRefs(innerRef, ref as ForwardedRef<HTMLTextAreaElement>)}
              {...shared}
              className={cn(FIELD_CLASS, MULTILINE_CLASS)}
              {...rest}
            />
          </div>
        ) : (
          <input
            ref={ref as Ref<HTMLInputElement>}
            type="text"
            {...shared}
            className={cn(FIELD_CLASS, SINGLE_LINE_CLASS)}
            {...rest}
          />
        )}
      </div>
    )
  },
)
