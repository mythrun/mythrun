import { Stack, Heading, Text, Button } from '@mythrun/ui'

// Inline presentational states (member hold / failure / play entry). All copy is
// resolved to `[ph:]` i18n strings by the parent so the t() keys stay static.

const HOLD_TESTID = 'character-hold'
const FAILURE_TESTID = 'character-failure'
const FAILURE_RETRY_TESTID = 'character-failure-retry'
const PLAY_TESTID = 'character-play'
const PLAY_ENTER_TESTID = 'character-play-enter'

/** The member "setting up the table" hold — situation/level are the owner's to set. */
export function HoldView({ title, body }: { title: string; body: string }): React.JSX.Element {
  return (
    <Stack gap={2} data-testid={HOLD_TESTID}>
      <Heading level={1} role="title">
        {title}
      </Heading>
      <Text role="ui-caption" as="p">
        {body}
      </Text>
    </Stack>
  )
}

/** The character-context failure — a calm, retryable resume (NOT the world-gen
 *  terminal). Used for both a `failed` concept (retry = reset → create) and a
 *  `failed` campaign / terminal integration failure (retry = re-attempt fan-in). */
export function FailureView({
  title,
  body,
  retryLabel,
  onRetry,
}: {
  title: string
  body: string
  retryLabel: string
  onRetry: () => void
}): React.JSX.Element {
  return (
    <Stack gap={3} data-testid={FAILURE_TESTID}>
      <Heading level={1} role="title">
        {title}
      </Heading>
      <Text as="p">{body}</Text>
      <Stack direction="row">
        <Button onPress={onRetry} data-testid={FAILURE_RETRY_TESTID}>
          {retryLabel}
        </Button>
      </Stack>
    </Stack>
  )
}

/** The play entry — an integrated/active campaign leads into the game. */
export function PlayEntry({
  title,
  body,
  enterLabel,
  onEnter,
}: {
  title: string
  body: string
  enterLabel: string
  onEnter: () => void
}): React.JSX.Element {
  return (
    <Stack gap={3} data-testid={PLAY_TESTID}>
      <Heading level={1} role="title">
        {title}
      </Heading>
      <Text as="p">{body}</Text>
      <Stack direction="row">
        <Button onPress={onEnter} data-testid={PLAY_ENTER_TESTID}>
          {enterLabel}
        </Button>
      </Stack>
    </Stack>
  )
}
