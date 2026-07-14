import { useEffect, useId, useRef } from 'react'
import type { SessionInputProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TextArea } from '../TextArea/TextArea.tsx'
import { Button } from '../Button/Button.tsx'
import { VisuallyHidden } from '../VisuallyHidden/VisuallyHidden.tsx'

// SessionInput — the live-play composer (MYT-92). A controlled text field + a
// Send affordance + a prominent @DM summon. The component is a THIN shell: it
// exposes exactly two intents — `onSend` (the ordinary message) and `onSummonDm`
// (the explicit-text @dm path) — plus the neutral controlled value. The visible
// `@dm` token composition, the persist-as-`player_message`, and the
// broadcast-so-the-table-sees-the-summon all live at the route wire (Task 16);
// here we neither know nor touch the token. `disabled` gates BOTH intents while
// the session is ended / not-ready. Platform-neutral (§9): neutral callbacks,
// resolved [ph:] labels as props — no className/style, no DOM events leaked out.
//
// Register: the @DM summon is a REAL, bordered `secondary` affordance — prominent
// (easy to find, never buried in a menu) but register-QUIET (the brand's paper-y
// voice, not the ember-loud primary and not gamerspeak). Send is the primary
// (ember) action. The terse button copy is consumer-resolved, so the component
// itself hard-codes no strings.

export function SessionInput({
  value,
  onChange,
  onSend,
  onSummonDm,
  disabled,
  placeholder,
  summonLabel,
  sendLabel,
}: SessionInputProps) {
  const fieldId = useId()
  const fieldRef = useRef<HTMLTextAreaElement>(null)

  // Enter-to-send / Shift+Enter-newline. The keydown lives on the interactive
  // <textarea> itself (attached to the forwarded ref), NOT a wrapper element — a
  // key handler on a non-interactive container trips jsx-a11y, and the textarea
  // is the correct a11y target regardless. `isComposing` guards IME: an Enter
  // that COMMITS a composition must not send. A disabled textarea emits no
  // keydown, but we re-check `disabled` defensively so a stale event can't leak.
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (disabled) return
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        onSend()
      }
    }
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [disabled, onSend])

  return (
    <div className={cn('flex flex-col gap-[var(--space-2)]')}>
      {/* SR-only label: the field shows a faint placeholder, but a placeholder is
          not an accessible NAME (axe flags a name-less textarea). A
          visually-hidden <label htmlFor> gives the composer a real name without
          adding visible chrome. */}
      <VisuallyHidden>
        <label htmlFor={fieldId}>{placeholder}</label>
      </VisuallyHidden>
      <TextArea
        ref={fieldRef}
        id={fieldId}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        autoSize
        minRows={1}
        maxRows={6}
      />
      <div className={cn('flex items-center justify-between gap-[var(--space-2)]')}>
        <Button variant="secondary" onPress={onSummonDm} disabled={disabled}>
          {summonLabel}
        </Button>
        <Button variant="primary" onPress={onSend} disabled={disabled}>
          {sendLabel}
        </Button>
      </div>
    </div>
  )
}
