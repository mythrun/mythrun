import { useEffect, useState } from 'react'
import { Stack, Text } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router-dom'
import {
  getStartingSituations,
  submitCharacter,
  useApiContext,
  type ApiContext,
  type StartingSituationsResponse,
  type SubmitCharacterBody,
  type SubmitCharacterResponse,
} from '@mythrun/client-core'
import { createMachine, type CreateState, type CreateEvent } from '@mythrun/client-core/character'
import { PathChooser } from './character-new/path-chooser.tsx'
import { FreeformPath } from './character-new/freeform-path.tsx'

// The CHARACTER-CREATE screen (`/campaigns/:id/character/new`, MYT-90 D3) — the
// entry to character creation: the two-path CHOOSER + the FREEFORM path. The
// route owns the create-machine state (a small pure brain in @mythrun/client-core/
// character), the campaignId (route param), the api context, and the one-time
// starting-situations fetch (the chosen situation's `invitation` becomes the
// freeform grounding whisper). The path components are thin route-local
// compositions of DS primitives.
//
// The GUIDED branch and the PROCESSING beat are seams the later tasks fill:
//   • D4 (guided) swaps the guided placeholder for <GuidedBuilder> wired to the
//     client-core guided reducer + submitCharacter.
//   • D5 (loading beat) swaps the processing placeholder for <CharacterLoadingBeat>
//     driven by useCharacterCreationStream.
//   • D6 (reveal/confirm) owns the `reveal`/`staging` machine states — unreachable
//     here (nothing dispatches `ready`/`confirm` yet).

/** The situations source — defaults to the real endpoint; tests substitute it. */
type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>
/** The concept submit sink — defaults to the real endpoint; tests substitute it. */
type SubmitCharacterFn = (
  ctx: ApiContext,
  campaignId: string,
  body: SubmitCharacterBody,
) => Promise<SubmitCharacterResponse>

/** The chosen situation's `invitation`, or `undefined` when there is no usable
 *  pick yet (still loading, a failed fetch, no `chosenIndex`, or an index that
 *  matches no situation) — the grounding step then shows the generic fallback. */
function chosenInvitation(response: StartingSituationsResponse | null): string | undefined {
  if (response === null) return undefined
  if (response.chosenIndex === null) return undefined
  return response.situations[response.chosenIndex]?.invitation
}

/** Fetch the starting situations once and surface the chosen situation's
 *  invitation whisper. A failed/transient fetch stays `null` (the grounding step
 *  falls back to the generic whisper — never throws into the route); `active`
 *  drops a late resolve after unmount. */
function useChosenInvitation(
  campaignId: string,
  ctx: ApiContext,
  fetchSituations: FetchSituations,
): string | undefined {
  const [response, setResponse] = useState<StartingSituationsResponse | null>(null)
  useEffect(() => {
    let active = true
    void fetchSituations(ctx, campaignId)
      .then((r) => {
        if (active) setResponse(r)
      })
      .catch(() => {
        // Calm: the grounding step falls back to the generic whisper.
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, fetchSituations])
  return chosenInvitation(response)
}

export interface CharacterNewRouteProps {
  /** The situations source — defaults to the real endpoint; tests substitute it. */
  fetchSituations?: FetchSituations
  /** The concept submit sink — defaults to the real endpoint; tests substitute it. */
  submit?: SubmitCharacterFn
}

export function CharacterNewRoute({
  fetchSituations = getStartingSituations,
  submit = submitCharacter,
}: CharacterNewRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const [flow, setFlow] = useState<CreateState>(createMachine.initial)
  const dispatch = (event: CreateEvent): void => {
    setFlow((state) => createMachine.transition(state, event))
  }

  const invitation = useChosenInvitation(id, ctx, fetchSituations)
  const groundingWhisper = invitation ?? t('characterCreate.freeform.groundingWhisperFallback')

  const submitBoth = (conceptText: string, situationGroundingText: string): Promise<void> =>
    submit(ctx, id, { conceptText, situationGroundingText }).then(() => undefined)

  let screen: React.JSX.Element
  if (flow === 'chooser') {
    screen = (
      <PathChooser
        onChooseFreeform={() => {
          dispatch('chooseFreeform')
        }}
        onChooseGuided={() => {
          dispatch('chooseGuided')
        }}
      />
    )
  } else if (flow === 'guided') {
    // D4: guided branch — swap this placeholder for <GuidedBuilder> wired to the
    //     client-core guided reducer + submitCharacter. The chooser already routes
    //     here via createMachine.transition(_, 'chooseGuided').
    screen = (
      <Text role="ui-caption" as="p" data-testid="character-guided-todo">
        {t('characterCreate.guidedTodo')}
      </Text>
    )
  } else if (flow === 'processing') {
    // D5: loading beat — swap this placeholder for <CharacterLoadingBeat> driven by
    //     useCharacterCreationStream. The machine reaches here on a successful submit.
    screen = (
      <Text role="ui-caption" as="p" data-testid="character-processing">
        {t('characterCreate.processing')}
      </Text>
    )
  } else {
    // freeform (`reveal`/`staging` are D6 — unreachable until `ready`/`confirm` fire).
    screen = (
      <FreeformPath
        groundingWhisper={groundingWhisper}
        submit={submitBoth}
        onSubmitted={() => {
          dispatch('submit')
        }}
      />
    )
  }

  return (
    <Stack gap={5} data-testid="route-character-new">
      {screen}
    </Stack>
  )
}
