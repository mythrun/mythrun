import { Stack, Heading, Text, Button, GhostChoiceList } from '@mythrun/ui'
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
//
// GEOMETRY (ux-run2 myth-ma8yv, critique 024): a binary fork reads as two doors,
// not a stack of full-width bars — `columns={2}` seats the cards SIDE BY SIDE as
// two taller cards (restacking below `sm`), capped at the `wide` measure so they
// hold ~400-440px each; and the whole block is vertically weighted into the left
// column (minHeight="page" + 1:2 grow spacers) so the composition sits in the
// space beside the wiki rail instead of clinging to the top edge over a dead
// quadrant. Spacers collapse on short viewports.
//
// PLACE + HIERARCHY (ux-run2 myth-80an1 + myth-aynpf): a quiet Back over an
// altitude eyebrow ("Taking your seat") tells the player where they are and how
// to leave, and the page QUESTION carries the display scale — the one moment on
// the page that earns it (the sidebar's world title is reference, not a second
// front page). The eyebrow deliberately avoids a third "character" on one
// screen (ux-run3 myth-t6pxy — the prompt + freeform CTA already carry it).

export interface PathChooserProps {
  /** Chose the freeform ("describe them in your own words") path. */
  onChooseFreeform: () => void
  /** Chose the guided ("answer a few questions") path. */
  onChooseGuided: () => void
  /** Leave character creation for the campaign surface (the place the player
   *  came from) — the chooser's quiet way back (ux-run2 myth-80an1). */
  onBack: () => void
}

export function PathChooser({
  onChooseFreeform,
  onChooseGuided,
  onBack,
}: PathChooserProps): React.JSX.Element {
  const { t } = useTranslation()
  // Each door carries its cost-of-path meta line (ux-run3 myth-t6pxy) — the
  // real decision criterion between the two, seated at the card's foot.
  const choices: GhostChoiceItem[] = [
    {
      id: 'freeform',
      title: t('characterCreate.chooser.freeform.cta'),
      subtitle: t('characterCreate.chooser.freeform.body'),
      meta: t('characterCreate.chooser.freeform.cost'),
      onSelect: onChooseFreeform,
      testId: 'chooser-freeform',
    },
    {
      id: 'guided',
      title: t('characterCreate.chooser.guided.cta'),
      subtitle: t('characterCreate.chooser.guided.body'),
      meta: t('characterCreate.chooser.guided.cost'),
      onSelect: onChooseGuided,
      testId: 'chooser-guided',
    },
  ]
  return (
    <Stack minHeight="page" data-testid="chooser-seat">
      <Stack grow={1} />
      <Stack gap={5} maxWidth="wide">
        <Stack gap={2}>
          <Stack direction="row">
            <Button variant="ghost" size="sm" flush="start" data-testid="chooser-back" onPress={onBack}>
              {t('back')}
            </Button>
          </Stack>
          <Text role="ui-caption" as="p">
            {t('characterCreate.chooser.eyebrow')}
          </Text>
          <Heading level={1} role="display">
            {t('characterCreate.chooser.prompt')}
          </Heading>
        </Stack>
        <GhostChoiceList items={choices} columns={2} data-testid="chooser-choices" />
      </Stack>
      <Stack grow={2} />
    </Stack>
  )
}
