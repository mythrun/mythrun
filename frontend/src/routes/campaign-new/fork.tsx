import { Stack, Heading, Text, GhostChoiceList } from '@mythrun/ui'
import type { GhostChoiceItem } from '@mythrun/client-core/contract'
import { useTranslation } from 'react-i18next'

// The campaign-create FORK (spec §2) — the flow's first moment. A quiet eyebrow,
// the serif question-that-frames-the-choice, an italic lede, then the two paths as
// a carded `GhostChoiceList`: "Start from an idea" (→ the freeform screen) and
// "Build from what you love" (→ the guided screen). Pure presentation — it fires
// two neutral intents and knows nothing of the state machine; the controller maps
// each to a `screen`. Composes @mythrun/ui only (no ad-hoc UI); every string is an
// i18n key (R5).
//
// GEOMETRY (ux-run2 myth-ma8yv, critique 002): a full-page moment with exactly
// one job must not huddle in the upper half above ~300px of dead paper — the
// block seats optically above center (grow-weighted 2:5 spacers, the dead
// space framing the choice instead of trailing it). The spacers collapse on
// short viewports where the content already fills the region. Width stays the
// funnel column's (`maxWidth="form"` on the campaign-new spine). The floor is
// `pageBelowBar`, not `page` (ux-run3 myth-4jbmr): this screen renders under
// the spine's Back bar, and the plain page floor overflowed the region by that
// row — seating the block ~24px below optical center. Arithmetic at 1280x720:
// region 584px, floor 520px, block 324px → 196px of slack. 1:2 spacers put the
// midpoint dead on geometric center; 2:5 lifts it the last ~11px above, the
// "just above" the eye wants, and the column still ends inside the region.
export interface ForkScreenProps {
  /** Chose "Start from an idea" → the controller advances to `freeform`. */
  onFreeform: () => void
  /** Chose "Build from what you love" → the controller advances to `guided`. */
  onGuided: () => void
}

export function ForkScreen({ onFreeform, onGuided }: ForkScreenProps): React.JSX.Element {
  const { t } = useTranslation()
  const choices: GhostChoiceItem[] = [
    {
      id: 'freeform',
      title: t('campaignNew.fork.idea.title'),
      subtitle: t('campaignNew.fork.idea.subtitle'),
      onSelect: onFreeform,
    },
    {
      id: 'guided',
      title: t('campaignNew.fork.love.title'),
      subtitle: t('campaignNew.fork.love.subtitle'),
      onSelect: onGuided,
    },
  ]
  return (
    <Stack minHeight="pageBelowBar" data-testid="screen-fork">
      <Stack grow={2} />
      <Stack gap={6}>
        <Stack gap={2}>
          <Text role="ui-label" data-testid="fork-eyebrow">
            {t('campaignNew.fork.eyebrow')}
          </Text>
          {/* The page's ONE question earns the headline step (ux-run2
              myth-aynpf: a 3px gap between the question and its answer cards
              is no hierarchy at all); card titles stay at 18px below it. */}
          <Heading level={1} role="headline" data-testid="fork-question">
            {t('campaignNew.fork.question')}
          </Heading>
          <Text role="subtitle" as="p" data-testid="fork-lede">
            {t('campaignNew.fork.lede')}
          </Text>
        </Stack>
        <GhostChoiceList items={choices} data-testid="fork-choices" />
      </Stack>
      <Stack grow={5} />
    </Stack>
  )
}
