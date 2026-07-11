import { Stack, Grid, Heading, Text, Card, CardBody, Button } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'

// The PATH CHOOSER (MYT-90, D3) — the first character-create beat: "how do you
// want to make your character?" over two option cards. FREEFORM ("tell us who
// you are") and GUIDED ("build your character"). A small in-route composition of
// DS primitives (not a new DS component): each option is a Card whose CardBody
// carries a one-line description over a primary Button that commits the choice.
// The Button (a real <button>) is the hit target — no whole-card click (the DS
// has no bare card-as-link variant), so each option keeps a distinct accessible
// name from its CTA copy. Flat 1-bit paper register; the responsive Grid stacks
// the two cards into one column at ~375px and sits them side-by-side when wide.

export interface PathChooserProps {
  /** Chose the freeform ("describe them in your own words") path. */
  onChooseFreeform: () => void
  /** Chose the guided ("answer a few questions") path. */
  onChooseGuided: () => void
}

export function PathChooser({ onChooseFreeform, onChooseGuided }: PathChooserProps): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={5}>
      <Heading level={1} role="title">
        {t('characterCreate.chooser.prompt')}
      </Heading>
      <Grid columns="auto-fit" minColumnPx={260} gap={4}>
        <Card data-testid="chooser-freeform">
          <CardBody>
            <Stack gap={3} align="start">
              <Text role="ui-caption" as="p">
                {t('characterCreate.chooser.freeform.body')}
              </Text>
              <Button variant="primary" onPress={onChooseFreeform}>
                {t('characterCreate.chooser.freeform.cta')}
              </Button>
            </Stack>
          </CardBody>
        </Card>
        <Card data-testid="chooser-guided">
          <CardBody>
            <Stack gap={3} align="start">
              <Text role="ui-caption" as="p">
                {t('characterCreate.chooser.guided.body')}
              </Text>
              <Button variant="primary" onPress={onChooseGuided}>
                {t('characterCreate.chooser.guided.cta')}
              </Button>
            </Stack>
          </CardBody>
        </Card>
      </Grid>
    </Stack>
  )
}
