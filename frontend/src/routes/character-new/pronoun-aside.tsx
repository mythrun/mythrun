import { FormField, Select, Stack } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { PRONOUN_CHOICES, type PronounChoice } from '@mythrun/client-core/character'

// myth-gdycq — the optional pronoun ask, shared verbatim by BOTH creation paths:
// the freeform concept step and the guided builder's NOTES step. One composition
// (the DS `FormField` + `Select`, the labelled-control pattern), one copy, so the
// two paths cannot drift into asking the same question two different ways.
//
// It rides each screen's `FreeformPrompt aside` slot, which seats it between the
// answer field and the action row — present, quiet, and impossible to miss on the
// way to the button, without competing with the step's real question.
//
// WHY A CHOICE AND NOT A SENTENCE: the answer is pinned deterministically on the
// server (run 3 wrote "he/his" for a character whose description never said), and
// a pin only works against tokens the server defines. The DEFAULT is "let the
// description decide" — a real answer, not an empty state: it sends nothing, and
// the chargen prompt then reads the description and falls back to they/them
// rather than guessing.

/** The i18n key per choice. A literal map (not a computed key) so the typed-key
 *  augmentation checks every one of them at compile time. */
const LABEL_KEY = {
  unset: 'characterCreate.pronouns.unset',
  she_her: 'characterCreate.pronouns.sheHer',
  he_him: 'characterCreate.pronouns.heHim',
  they_them: 'characterCreate.pronouns.theyThem',
  name_only: 'characterCreate.pronouns.nameOnly',
} as const satisfies Record<PronounChoice, string>

export interface PronounAsideProps {
  /** The current choice (controlled). */
  value: PronounChoice
  /** Neutral change callback — the screen persists it and folds it into submit. */
  onChange: (choice: PronounChoice) => void
}

export function PronounAside({ value, onChange }: PronounAsideProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack data-testid="pronoun-aside">
      <FormField label={t('characterCreate.pronouns.label')} requiredLabel={t('form.required')}>
        <Select
          size="sm"
          value={value}
          onChange={(next) => {
            // The Select's values ARE the choice union (rendered from it), so
            // the cast restates what the options already guarantee.
            onChange(next as PronounChoice)
          }}
          options={PRONOUN_CHOICES.map((choice) => ({
            value: choice,
            label: t(LABEL_KEY[choice]),
          }))}
        />
      </FormField>
    </Stack>
  )
}
