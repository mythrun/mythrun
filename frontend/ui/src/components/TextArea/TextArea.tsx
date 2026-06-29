import { forwardRef, useCallback, useEffect, useRef } from 'react'
import type { ForwardedRef } from 'react'
import { cva } from 'class-variance-authority'
import type { TextAreaProps, InputSize } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'

// Multi-line text input — a REAL native <textarea> (real form control + a11y).
// The multi-line sibling of Input: same neutral `onChange(value)` (§9), same
// flat 1-bit register (0px corners, `--border-strong`, `bg-surface`/`text-ink`,
// `font-ui` mono), same theme-aware focus ring, same invalid/disabled/read-only
// behaviour. See Input.tsx for the per-state rationale.
//
// Geometry differs: height comes from native `rows` (auto-height), not a fixed
// `--control-*` height. The `--control-*` token sets a per-control MIN height so
// even a 1-row textarea clears the touch floor; vertical padding gives the text
// breathing room, and only vertical resize is allowed (`resize-vertical`).
// Font steps 12/14/16 (text-xs/sm/base) so sm reads clearly smaller than md
// (matches Input — without the down-step they share the 14px face).
const SIZE_CLASS: Record<InputSize, string> = {
  sm: 'min-h-[var(--control-sm)] px-[var(--space-2)] py-[var(--space-2)] text-xs',
  md: 'min-h-[var(--control-md)] px-[var(--space-3)] py-[var(--space-2)] text-sm',
  lg: 'min-h-[var(--control-lg)] px-[var(--space-4)] py-[var(--space-3)] text-base',
}

// Per-size VERTICAL-padding token (one side). The auto-grow height bound adds
// `2 * <token>` to the line box so the cap lands at exactly `maxRows` of text
// plus its own top+bottom padding (box-sizing is border-box — Tailwind default).
const SIZE_PAD_Y_VAR: Record<InputSize, string> = {
  sm: 'var(--space-2)',
  md: 'var(--space-2)',
  lg: 'var(--space-3)',
}

const textArea = cva(
  cn(
    'block w-full font-ui bg-surface text-ink',
    'rounded-none border border-border-strong',
    'placeholder:text-ink-tertiary',
    'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
    'disabled:cursor-not-allowed disabled:bg-surface disabled:text-ink-tertiary disabled:border-border-strong',
    'read-only:cursor-default',
  ),
  {
    variants: {
      size: SIZE_CLASS,
      // Invalid: a 2px danger border (heavier than the 1px normal `--border-strong`
      // edge) + a danger focus ring, NO background wash. The danger red was
      // re-saturated so the border alone reads as error — the tinted fill is gone.
      // Box-sizing is border-box so the 2px border grows inward (no layout shift).
      // `aria-invalid` is set in the impl.
      invalid: {
        true: 'border-2 border-border-danger focus-visible:outline-border-danger',
        false: '',
      },
      // Auto-grow (the chat-composer pattern): the modern CSS `field-sizing:
      // content` sizes the box to its text; we disable manual resize and let the
      // box scroll once it hits the inline `maxHeight` cap. The default (non-
      // autoSize) path keeps the fixed `rows` height with only vertical resize.
      autoSize: {
        true: 'field-sizing-content resize-none overflow-y-auto',
        false: 'resize-vertical',
      },
    },
    defaultVariants: { size: 'md', invalid: false, autoSize: false },
  },
)

// One line-height (`1lh`) per row tracks the per-size font automatically (the
// font-size class sets the line box), so the bound stays correct across sm/md/lg
// without hardcoding pixel line-heights. We add `2 * <pad-y token>` for the
// control's own top+bottom padding (border-box).
const rowBound = (rows: number, padYVar: string) => `calc(${String(rows)} * 1lh + 2 * ${padYVar})`

// True when the browser supports CSS `field-sizing: content`. SSR/jsdom have no
// `CSS` global → false (so those environments wire the JS fallback, never crash).
const supportsFieldSizing = () =>
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function' && CSS.supports('field-sizing', 'content')

// Merge the forwarded ref with our internal ref (React 19 still uses the
// callback/object ref shapes here). Lets the consumer keep their ref while the
// Firefox fallback drives height off our own handle.
const setRefs =
  (internal: { current: HTMLTextAreaElement | null }, forwarded: ForwardedRef<HTMLTextAreaElement>) =>
  (node: HTMLTextAreaElement | null) => {
    internal.current = node
    if (typeof forwarded === 'function') forwarded(node)
    else if (forwarded) forwarded.current = node
  }

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  {
    value,
    defaultValue,
    onChange,
    placeholder,
    name,
    id,
    describedBy,
    size = 'md',
    rows,
    autoSize = false,
    minRows = 1,
    maxRows = 8,
    invalid = false,
    disabled = false,
    readOnly = false,
    required = false,
    ...rest
  },
  ref,
) {
  const innerRef = useRef<HTMLTextAreaElement | null>(null)

  // Firefox fallback (no `field-sizing` yet): the classic auto-grow — reset to
  // `auto`, then set height to `min(scrollHeight, maxHeightPx)` so it grows with
  // content and scrolls at the cap. Only wired when autoSize is on AND
  // field-sizing is unsupported, so Chrome/Safari pay nothing.
  const resizeToContent = useCallback(() => {
    const el = innerRef.current
    if (!el) return
    el.style.height = 'auto'
    // The cap is the computed `maxHeight` style (one line-height per row + pad);
    // we read it back off the element rather than recompute pixels in JS, so the
    // JS path and the CSS bound stay in lockstep. When the env can't resolve it to
    // px (jsdom: no layout), the cap is +Infinity → height is the raw scrollHeight.
    const capPx = readMaxHeightPx(el)
    el.style.height = `${String(Math.min(el.scrollHeight, capPx))}px`
  }, [])

  useEffect(() => {
    if (!autoSize || supportsFieldSizing()) return
    const el = innerRef.current
    if (!el) return
    resizeToContent()
    el.addEventListener('input', resizeToContent)
    return () => {
      el.removeEventListener('input', resizeToContent)
    }
  }, [autoSize, resizeToContent])

  const padYVar = SIZE_PAD_Y_VAR[size]
  const boundStyle = autoSize
    ? { minHeight: rowBound(minRows, padYVar), maxHeight: rowBound(maxRows, padYVar) }
    : undefined

  return (
    <textarea
      ref={setRefs(innerRef, ref)}
      value={value}
      defaultValue={defaultValue}
      onChange={
        onChange
          ? (e) => {
              onChange(e.target.value)
            }
          : undefined
      }
      placeholder={placeholder}
      name={name}
      id={id}
      aria-describedby={describedBy}
      // field-sizing ignores `rows`; in autoSize mode minRows/maxRows drive the
      // bound, so we omit the attribute entirely rather than send a dead value.
      rows={autoSize ? undefined : rows}
      disabled={disabled}
      readOnly={readOnly}
      required={required}
      aria-invalid={invalid || undefined}
      className={cn(textArea({ size, invalid, autoSize }))}
      style={boundStyle}
      {...rest}
    />
  )
})

// The element's computed `max-height` in pixels, or +Infinity when it can't be
// resolved (jsdom has no layout engine, so `getComputedStyle().maxHeight` is the
// raw `calc(...)` string, not a px value). Used only by the Firefox fallback to
// clamp scrollHeight.
function readMaxHeightPx(el: HTMLTextAreaElement): number {
  const raw =
    typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
      ? window.getComputedStyle(el).maxHeight
      : ''
  const px = Number.parseFloat(raw)
  return raw.endsWith('px') && Number.isFinite(px) ? px : Number.POSITIVE_INFINITY
}
