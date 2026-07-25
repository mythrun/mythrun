import { forwardRef, useId } from 'react'
import type { FreeformPromptProps } from '@mythrun/client-core/contract'
import { cn } from '../../lib/cn.ts'
import { TYPE_ROLE_CLASS } from '../../lib/typography.ts'
import { Stack } from '../Stack/Stack.tsx'
import { Text } from '../Text/Text.tsx'
import { TextArea } from '../TextArea/TextArea.tsx'
import { Button } from '../Button/Button.tsx'

// FreeformPrompt (MYT-90) — the "tell us who you are" fork of character creation:
// a single calm composition (NOT a busy form) where the player describes their
// character in their own words. Pure/presentational — renders from props and
// fires the neutral onChange(value)/onSubmit callbacks; no flow/network/state
// (that lives in the client-core view-model).
//
// The prompt IS the field's <label> (the contract calls it "the seamless field's
// label"), so the question is the textarea's accessible NAME — the SeamlessInput
// idiom (the question labels the answer). It is styled as a large serif heading
// (font-body, one step above the seamless per-step question) so it READS as the
// hero prompt while staying a real, programmatically-associated label. The
// whisper sits beneath it as the DS `subtitle` register (italic, muted serif) AND
// is wired as the field's aria-describedby, so assistive tech reads the guidance
// when the field takes focus.
//
// Register (flat 1-bit / paper / SQUARE): the composed DS primitives (TextArea,
// Button) are already 0px-radius, token-styled, theme-aware. Layout is measure-
// agnostic — a plain Stack column with generous vertical rhythm; the consuming
// screen owns the reading measure (the stories supply a max-width), so it reads
// the same at a desktop column and at 375px.
//
// The submit CTA's label arrives resolved via `submitLabel` — the shell owns i18n
// and passes it in (MYT-100 grew the contract the label prop, exactly as anticipated
// when it was interim brand chrome).

// The optional step signpost (MYT-102): a quiet mono eyebrow above the prompt —
// the "1 of 2" that tells the player another question follows so they don't
// front-load their whole answer. Muted machine register — tertiary ink, never
// ember: it orients, it does not call attention.
const STEP_INDICATOR_CLASS = 'font-ui text-xs font-medium uppercase tracking-wide text-ink-tertiary'
// The prompt: a large serif heading that is ALSO the field's <label>. `text-ink`
// (the darkest ink) + block so it stacks above the field. Capped at a reading
// measure — running text in the main column never exceeds ~70ch (ux-run2
// myth-4gnrp; the answer field below may run wider). 1.5rem — a clear notch of
// size over the recap card's 1rem context title, so the actual question
// outranks its context (ux-run3 myth-7ceqw d).
const PROMPT_CLASS = 'block max-w-[70ch] font-body text-[1.5rem] font-semibold leading-[1.3] text-ink'
// The whisper, per register. `hint` (default): the DS `subtitle` role — italic,
// muted serif form guidance. `dm`: the AI's bespoke, personalized prompt promoted
// to full body reading size in roman with a thin left rule — the DM's voice, not
// chrome (ux-run2 myth-4gnrp: the generated prose is the moment the product
// proves it was listening; it must out-weigh the generic headline, not footnote
// it). Both are capped at the ~70ch reading measure.
const WHISPER_CLASS: Record<'hint' | 'dm', string> = {
  // Composed from the `subtitle` role token rather than restating it (myth-ds9hh):
  // the italic narrative sub-line has ONE definition, and a change to it reaches
  // here instead of leaving a look-alike behind.
  hint: cn(TYPE_ROLE_CLASS.subtitle, 'max-w-[70ch]'),
  dm: 'max-w-[70ch] border-l-2 border-border-strong pl-[var(--space-3)] font-body text-base font-normal leading-[1.6] text-ink',
}
// The quiet Back — the flow's one Back position, bottom-left in the action row
// (ux-run2 myth-80an1): an underlined mono link, matching the builder's nav.
const BACK_CLASS = cn(
  'inline-flex items-center gap-[var(--space-1)] rounded-none bg-transparent cursor-pointer',
  'font-ui text-xs tracking-wide text-ink-tertiary underline underline-offset-2',
  'hover:text-ink transition-colors duration-[var(--duration-fast)]',
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg',
)
// The commit disclosure (ux-run3 myth-g3mt6) rides the DS `meta` role — the
// SAME token the world-creation triggers' disclosure wears, so one pattern
// reads identically at every generation trigger in the funnel. It is seated IN
// the action row rather than under it (ux-run3 myth-21lpi) because the
// grounding step has no vertical band to spare above the 720px fold; on a
// wrapped narrow row it settles above the control, still adjacent.

export const FreeformPrompt = forwardRef<HTMLDivElement, FreeformPromptProps>(function FreeformPrompt(
  {
    stepIndicator,
    prompt,
    whisper,
    whisperVoice = 'hint',
    value,
    onChange,
    onSubmit,
    submitLabel,
    submitDisabled = false,
    submitHint,
    focusOnMount = false,
    onBack,
    backLabel,
    compact = false,
    placeholder,
    aside,
  },
  ref,
) {
  // Stable ids wire the question ↔ field (accessible name) and the whisper ↔
  // field (accessible description) with zero consumer wiring.
  const fieldId = useId()
  const whisperId = useId()
  return (
    <Stack ref={ref} data-testid="freeform-prompt" gap={5}>
      {/* Prompt + whisper cluster — tight rhythm so the whisper reads as the
          prompt's sub-line, not a separate block. The optional step signpost
          rides the same cluster, sitting as the prompt's quiet eyebrow. */}
      <Stack gap={2}>
        {stepIndicator !== undefined && (
          <p data-testid="freeform-step-indicator" className={STEP_INDICATOR_CLASS}>
            {stepIndicator}
          </p>
        )}
        <label htmlFor={fieldId} className={PROMPT_CLASS}>
          {prompt}
        </label>
        <p id={whisperId} data-voice={whisperVoice} className={WHISPER_CLASS[whisperVoice]}>
          {whisper}
        </p>
      </Stack>
      {/* One textarea: auto-grows as the answer does, then caps and scrolls. The
          floor matches the ask — a roomy essay floor for the concept prompts, a
          ~3-line detail floor when `compact` (an oversized empty field raises the
          stakes the copy tries to lower — ux-run2 myth-z45sb). It wears the
          `prose` face — the serif user-authored-prose voice + ember caret —
          so the character-describe field reads the same as the world-concept
          field, not the mono DATA face that read as a code stub (ux-run1
          myth-xs9tc). */}
      <TextArea
        id={fieldId}
        value={value}
        onChange={onChange}
        describedBy={whisperId}
        face="prose"
        size="lg"
        autoSize
        minRows={compact ? 3 : 6}
        maxRows={16}
        // The freeform overflow guard + the ~70ch writing measure (ux-run3
        // myth-en2jj / myth-7ceqw): the field keeps the column's width, the
        // text wraps at a reading measure, and the last line is never sliced
        // under the bottom rule.
        scrollFade
        measure="writing"
        focusOnMount={focusOnMount}
        // Only forward placeholder when supplied — `exactOptionalPropertyTypes`
        // forbids handing an explicit `undefined` to an optional `string` prop.
        {...(placeholder !== undefined && { placeholder })}
      />
      {/* The optional quiet aside (myth-gdycq): a secondary ask that belongs to
          this step, seated between the answer and the act. Inside the
          composition — never under the commit control, where an optional
          question reads as an afterthought nobody sees. */}
      {aside !== undefined && <div data-testid="freeform-prompt-aside">{aside}</div>}
      {/* The action row: the optional quiet Back holds the bottom-left (one Back,
          one position — ux-run2 myth-80an1); the commit control — a primary
          Button (real <button>: native click + keyboard) — right-aligned so the
          CTA reads as the end of the composition. Auto width holds at 375px
          (Button caps at max-w-full — no overflow). */}
      <Stack direction="row" justify={onBack !== undefined ? 'between' : 'end'} align="center" wrap gap={4}>
        {onBack !== undefined && (
          <button type="button" onClick={onBack} data-testid="freeform-prompt-back" className={BACK_CLASS}>
            <span aria-hidden="true">‹</span>
            {backLabel}
          </button>
        )}
        {/* The commit cluster: the disclosure at a generation trigger (ux-run3
            myth-g3mt6) reads immediately before the control it discloses, and
            the control itself is honestly gated (ux-run3 myth-7ceqw b) — while
            the required field is empty it stands down (the DS Button's muted
            geometry); the accent fill is the reward for having written. */}
        <Stack direction="row" justify="end" align="center" wrap gap={3}>
          {submitHint !== undefined && (
            <Text role="meta" as="p" data-testid="freeform-submit-hint">
              {submitHint}
            </Text>
          )}
          <Button variant="primary" size="lg" disabled={submitDisabled} onPress={onSubmit}>
            {submitLabel}
          </Button>
        </Stack>
      </Stack>
    </Stack>
  )
})
