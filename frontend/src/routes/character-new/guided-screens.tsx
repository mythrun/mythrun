import { GuidedRail, FreeformPrompt, SituationRecap, Text } from '@mythrun/ui'
import type { TFunction } from 'i18next'
import type { RailStep } from '@mythrun/client-core/contract'
import type { SituationRecapData } from './freeform-path.tsx'

// The guided path's builder-less screens (MYT-90 / MYT-102), split out of
// guided-path.tsx so the driver stays a readable controller: the optional NOTES
// coda and the post-complete GROUNDING screen. Both keep the journey's progress
// rail + step counter above a FreeformPrompt, with the flow's one Back position
// riding the prompt's action row (ux-run2 myth-80an1).

/** The calm inline notice on the grounding step: a too-short nudge, a
 *  failed-submit retry, or none. */
export type Notice = 'tooShort' | 'error' | null

/** The optional free-text NOTES coda — a FreeformPrompt, not an option grid; the
 *  rail persists above it (Notes `now`) so the journey stays signposted. The
 *  compact field + example placeholder show the shape of a good answer, and the
 *  button is state-aware — Skip while empty (an empty answer IS the sanctioned
 *  skip), Continue once it has text (ux-run2 myth-z45sb). */
export function NotesScreen({
  rail,
  counter,
  value,
  onChange,
  onSubmit,
  onBack,
  t,
}: {
  rail: RailStep[]
  counter: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
  t: TFunction
}): React.JSX.Element {
  return (
    <>
      <GuidedRail rail={rail} counter={counter} />
      <FreeformPrompt
        // Typing is the step's next action (ux-run3 myth-en2jj). The submit
        // control stays ENABLED while empty — an empty answer IS the sanctioned
        // Skip (the label says so), never a gated dead end.
        focusOnMount
        prompt={t('characterCreate.guided.notes.prompt')}
        whisper={t('characterCreate.guided.notes.whisper')}
        placeholder={t('characterCreate.guided.notes.placeholder')}
        compact
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        submitLabel={
          value.trim() === ''
            ? t('characterCreate.guided.notes.skip')
            : t('characterCreate.freeform.continue')
        }
        onBack={onBack}
        backLabel={t('characterCreate.guided.back')}
      />
    </>
  )
}

/** The post-complete GROUNDING screen — the second required field, collected
 *  exactly as the freeform path does, with the journey rail (every pick done,
 *  the Arrival rung `now`) and the opening-scene recap kept in view above the
 *  prompt (MYT-102). The situation's bespoke invitation renders in the DM voice
 *  register — full body roman with a quiet left rule — because the personalized
 *  prose is the point of the screen, not a form hint (ux-run2 myth-4gnrp). */
export function GroundingScreen({
  rail,
  counter,
  situation,
  groundingWhisper,
  value,
  onChange,
  onSubmit,
  onBack,
  notice,
  t,
}: {
  rail: RailStep[]
  counter: string
  situation?: SituationRecapData
  groundingWhisper: string
  value: string
  onChange: (value: string) => void
  onSubmit: () => void
  onBack: () => void
  notice: Notice
  t: TFunction
}): React.JSX.Element {
  return (
    <>
      <GuidedRail rail={rail} counter={counter} />
      {situation !== undefined && (
        <SituationRecap
          eyebrow={t('characterCreate.recap.eyebrow')}
          title={situation.title}
          locationName={situation.locationName}
          prose={situation.prose}
        />
      )}
      <FreeformPrompt
        // Typing is the step's next action (ux-run3 myth-en2jj); Continue is
        // honestly gated while empty (myth-7ceqw b) and — as the character-
        // generation trigger — carries the commit disclosure (myth-g3mt6).
        focusOnMount
        prompt={t('characterCreate.freeform.groundingPrompt')}
        whisper={groundingWhisper}
        whisperVoice="dm"
        // The detail floor, not the essay floor (ux-run3 myth-21lpi): this step
        // stacks a rail, a recap card and a long DM invitation above its field,
        // and the essay floor pushed the field bottom and the Continue past a
        // 1280x720 frame. The answer here is a sentence or two either way.
        compact
        value={value}
        onChange={onChange}
        onSubmit={onSubmit}
        submitLabel={t('characterCreate.freeform.continue')}
        submitDisabled={value.trim() === ''}
        submitHint={t('characterCreate.freeform.cost')}
        onBack={onBack}
        backLabel={t('characterCreate.guided.back')}
      />
      {notice !== null ? (
        <Text role="ui-caption" as="p" data-testid="guided-notice">
          {notice === 'tooShort'
            ? t('characterCreate.freeform.tooShort')
            : t('characterCreate.freeform.error')}
        </Text>
      ) : null}
    </>
  )
}
