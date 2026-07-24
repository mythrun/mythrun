import { Stack, Heading, GhostChoiceList } from '@mythrun/ui'
import type { GhostChoiceItem } from '@mythrun/client-core/contract'
import { useTranslation } from 'react-i18next'

// The PATH CHOOSER (MYT-90, D3) — the first character-create beat: "how do you
// want to make your character?" over two option cards. FREEFORM ("tell us who
// you are") and GUIDED ("build your character"). It composes the DS's carded
// `GhostChoiceList` (ux-run1 myth-occld) so the two paths read as one carded-
// option pattern shared with the campaign-create fork: each option is a whole
// selectable card (title = the choice, subtitle = its one-line description, a
// docked "enter" arrow), the ENTIRE card is the click target, and the serif copy
// matches the reading register (the earlier mono card body read as a dev stub).
// Each card keeps its `chooser-*` testId so the route can address one path.

export interface PathChooserProps {
  /** Chose the freeform ("describe them in your own words") path. */
  onChooseFreeform: () => void
  /** Chose the guided ("answer a few questions") path. */
  onChooseGuided: () => void
}

export function PathChooser({ onChooseFreeform, onChooseGuided }: PathChooserProps): React.JSX.Element {
  const { t } = useTranslation()
  const choices: GhostChoiceItem[] = [
    {
      id: 'freeform',
      title: t('characterCreate.chooser.freeform.cta'),
      subtitle: t('characterCreate.chooser.freeform.body'),
      onSelect: onChooseFreeform,
      testId: 'chooser-freeform',
    },
    {
      id: 'guided',
      title: t('characterCreate.chooser.guided.cta'),
      subtitle: t('characterCreate.chooser.guided.body'),
      onSelect: onChooseGuided,
      testId: 'chooser-guided',
    },
  ]
  return (
    <Stack gap={5}>
      <Heading level={1} role="title">
        {t('characterCreate.chooser.prompt')}
      </Heading>
      <GhostChoiceList items={choices} data-testid="chooser-choices" />
    </Stack>
  )
}
