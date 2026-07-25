import { useEffect, useId, useRef, useState } from 'react'
import type { SessionInputProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
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
// resolved i18n labels as props — no className/style, no DOM events leaked out.
//
// Register: the composer FIELD wears the `prose` face (serif font-body + the branded
// ember caret, myth-xs9tc) — the one face a player's own writing wears, so the
// authorship moment shares the world's voice instead of reading as an unfinished form
// control (031 critic). The two actions are GROUPED at the right of one row (not pinned
// to opposite ends) so their relationship is legible, and the OOC-vs-in-world split is
// carried by the variant hierarchy: SEND is the ember `primary` — your character's
// in-world action — and "Ask the DM" is the bordered `secondary` beside it — the quiet
// out-of-character question to the DM (prominent, never buried, but register-quiet).
// The terse button copy is consumer-resolved, so the component hard-codes no strings.
//
// myth-dd63v — the composer honours a `busy` state distinct from `disabled`:
// while the DM is mid-turn (or a check awaits Roll/Continue) SENDING is not the
// expected next action, so both send intents are gated and a quiet `busyLabel`
// names why — but the FIELD stays typeable so drafting-ahead is preserved. This
// replaces the old behaviour where Send looked live during a stream and silently
// no-op'd (the run-1 "single most damaging" bug). `disabled` (terminal — session
// ended / not-ready) still hard-gates the field itself.

export function SessionInput({
  value,
  onChange,
  onSend,
  onSummonDm,
  disabled,
  busy = false,
  busyLabel,
  placeholder,
  summonHint,
  summonLabel,
  sendLabel,
  maxLength,
}: SessionInputProps) {
  const fieldId = useId()
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  // myth-cimi3 — the modality hint: while the @DM summon is hovered/focused, the
  // (empty-field) placeholder shifts to the out-of-character line, disclosing
  // that the SAME textbox is action via Send and question via the summon. State
  // lives on a wrapper span (hover + bubbled focus), so the Button component
  // itself stays untouched (the chrome lane owns it).
  const [hintingSummon, setHintingSummon] = useState(false)
  const shownPlaceholder = hintingSummon && summonHint !== undefined ? summonHint : placeholder
  // The native maxLength on the textarea hard-caps typing AND paste, so a message
  // longer than the server accepts can't be composed; overCap is the belt that
  // also blocks send for a programmatically-set over-cap value.
  const overCap = maxLength !== undefined && value.length > maxLength
  // Sending is blocked while terminal-disabled, over the cap, OR busy (DM writing
  // / check pending). The @DM summon shares the busy gate but not the cap (a bare
  // `@dm` summon is always short).
  const sendGated = disabled || overCap || busy
  const summonGated = disabled || busy
  // The caption only reads while genuinely busy (never on the terminal-disabled
  // end state, which has its own complete-notice) and only when a label is given.
  const showBusy = busy && !disabled && busyLabel !== undefined
  // myth-lkm09 — while SENDING is gated (busy or terminal), the composer's visual
  // state must agree with its functional state (the run-3 truth-of-state finding:
  // an emphasized live border + "What do you do next?" while gated reads as a lie):
  //   • the FIELD drops to the TextArea `subdued` mute while busy (still typeable —
  //     drafting-ahead stays honest; terminal `disabled` keeps its own treatment);
  //   • the VISIBLE placeholder goes blank (the quiet busy caption below carries
  //     the reason; the SR-only label keeps the field's accessible name);
  //   • SEND stands down from the solid primary to the quiet ghost — the accent
  //     fill stays the exclusive mark of a pressable Send, and the gate lifting
  //     snaps it back (the decisive flip).
  const gatedVisual = busy || disabled
  const visiblePlaceholder = gatedVisual ? undefined : shownPlaceholder

  // Enter-to-send / Shift+Enter-newline. The keydown lives on the interactive
  // <textarea> itself (attached to the forwarded ref), NOT a wrapper element — a
  // key handler on a non-interactive container trips jsx-a11y, and the textarea
  // is the correct a11y target regardless. `isComposing` guards IME: an Enter
  // that COMMITS a composition must not send. `busy` blocks the Enter path too, so
  // a keyboard send can't slip past the gated Send button while the DM writes.
  useEffect(() => {
    const el = fieldRef.current
    if (!el) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (sendGated) return
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        onSend()
      }
    }
    el.addEventListener('keydown', onKeyDown)
    return () => {
      el.removeEventListener('keydown', onKeyDown)
    }
  }, [sendGated, onSend])

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
        {...(visiblePlaceholder !== undefined ? { placeholder: visiblePlaceholder } : {})}
        disabled={disabled}
        subdued={busy && !disabled}
        // The player's own writing wears the serif prose face + ember caret
        // (myth-xs9tc). Reading-size, not display-size: size/autoSize/rows unchanged.
        face="prose"
        autoSize
        minRows={1}
        maxRows={6}
        {...(maxLength !== undefined ? { maxLength } : {})}
      />
      <div className={cn('flex items-center justify-between gap-[var(--space-2)]')}>
        {/* The busy caption sits at the left of the affordance row (a polite live
            region so the reason is announced, not swallowed) — the quiet
            between-turns register, matching the transcript's thinking line. Empty
            when idle; reserves no height. */}
        <p
          data-testid="session-input-busy"
          role="status"
          aria-live="polite"
          className={cn(TYPE_ROLE_CLASS.meta, 'min-w-0 truncate')}
        >
          {showBusy ? busyLabel : ''}
        </p>
        <div className={cn('flex flex-none items-center gap-[var(--space-2)]')}>
          {/* The hint wrapper: hover via mouse enter/leave, keyboard via the
              button's BUBBLED focus/blur (React's synthetic focus bubbles) —
              no props on Button beyond its contract. */}
          <span
            onMouseEnter={() => {
              setHintingSummon(true)
            }}
            onMouseLeave={() => {
              setHintingSummon(false)
            }}
            onFocus={() => {
              setHintingSummon(true)
            }}
            onBlur={() => {
              setHintingSummon(false)
            }}
          >
            <Button variant="secondary" onPress={onSummonDm} disabled={summonGated}>
              {summonLabel}
            </Button>
          </span>
          <Button variant={gatedVisual ? 'ghost' : 'primary'} onPress={onSend} disabled={sendGated}>
            {sendLabel}
          </Button>
        </div>
      </div>
    </div>
  )
}
