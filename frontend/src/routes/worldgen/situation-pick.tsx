import { useEffect, useState } from 'react'
import { Stack, Heading, Text, GhostHookList } from '@mythrun/ui'
import type { GhostHookItem } from '@mythrun/ui'
import {
  getStartingSituations,
  chooseStartingSituation,
  isHttpError,
  useApiContext,
  type ApiContext,
  type StartingSituationsResponse,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

// The STARTING-SITUATION PICK (MYT-89 Phase D, D4) — the last step before the
// owner's campaign page, where D3's reveal Continue (→ `/campaigns/:id/situation`)
// lands. After exploring the world, the owner picks one of three opening HOOKS
// (title + locationName + prose, all DATA from the API); the choice seeds where
// play begins. A quiet screen: an eyebrow + a prompt over the three hooks as
// borderless GhostHookList items (flat 1-bit paper register — square, rule-split,
// no cards/radios). Selecting → POST the index → the campaign page (`/campaigns/:id`,
// D5's landing). A 409 `situation_locked` (the pick is already locked in) is
// idempotent-success — proceed to the campaign page anyway. Load/empty/error are
// calm placeholders. All UI composes @mythrun/ui.

/** The situations source — defaults to the real endpoint; tests substitute it. */
type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>
/** The pick sink — defaults to the real endpoint; tests substitute it. */
type ChooseSituation = (ctx: ApiContext, campaignId: string, index: number) => Promise<unknown>

/** The three lifecycle states of the hook fetch. `ready` carries the situations
 *  (possibly empty — the defensive empty branch); `error` a calm failed fetch. */
type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly response: StartingSituationsResponse }
  | { readonly status: 'error' }

/** Fetch the three opening hooks once. A failed/transient fetch settles to a calm
 *  error state (never throws into the route); `active` drops a late resolve after
 *  unmount. */
function useSituations(
  campaignId: string,
  ctx: ApiContext,
  fetchSituations: FetchSituations,
): LoadState {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  useEffect(() => {
    let active = true
    setState({ status: 'loading' })
    void fetchSituations(ctx, campaignId)
      .then((response) => {
        if (active) setState({ status: 'ready', response })
      })
      .catch(() => {
        if (active) setState({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, fetchSituations])
  return state
}

interface SituationBodyProps {
  load: LoadState
  submitFailed: boolean
  onSelect: (index: number) => void
}

/** The body: a calm `[ph: …]` line while loading / on error / when empty, else the
 *  three hooks as GhostHookList items (title + place + prose). A failed pick shows
 *  the same calm retryable note beneath the list (which stays, so re-picking works). */
function SituationBody({ load, submitFailed, onSelect }: SituationBodyProps): React.JSX.Element {
  const { t } = useTranslation()
  if (load.status === 'loading') {
    return (
      <Text role="ui-caption" as="p">
        {t('startingSituation.loading')}
      </Text>
    )
  }
  if (load.status === 'error') {
    return (
      <Text role="ui-caption" as="p">
        {t('startingSituation.error')}
      </Text>
    )
  }
  if (load.response.situations.length === 0) {
    return (
      <Text role="ui-caption" as="p">
        {t('startingSituation.empty')}
      </Text>
    )
  }
  const items: GhostHookItem[] = load.response.situations.map((s) => ({
    id: String(s.index),
    title: s.title,
    place: s.locationName,
    prose: s.prose,
    onSelect: () => {
      onSelect(s.index)
    },
  }))
  return (
    <Stack gap={3}>
      <GhostHookList items={items} data-testid="situation-hooks" />
      {submitFailed && (
        <Text role="ui-caption" as="p">
          {t('startingSituation.error')}
        </Text>
      )}
    </Stack>
  )
}

export interface SituationPickRouteProps {
  /** The situations source — defaults to the real endpoint; tests substitute it. */
  fetchSituations?: FetchSituations
  /** The pick sink — defaults to the real endpoint; tests substitute it. */
  chooseSituation?: ChooseSituation
}

export function SituationPickRoute({
  fetchSituations = getStartingSituations,
  chooseSituation = chooseStartingSituation,
}: SituationPickRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const load = useSituations(id, ctx, fetchSituations)
  const [submitFailed, setSubmitFailed] = useState(false)

  const handleSelect = (index: number): void => {
    setSubmitFailed(false)
    void chooseSituation(ctx, id, index)
      .then(() => void navigate(`/campaigns/${id}`))
      .catch((err: unknown) => {
        // A locked pick is done — proceed to the campaign page idempotently. Any
        // OTHER failure surfaces a calm retryable note; the list stays for a retry.
        if (isHttpError(err) && err.status === 409 && err.code === 'situation_locked') {
          void navigate(`/campaigns/${id}`)
          return
        }
        setSubmitFailed(true)
      })
  }

  return (
    <Stack gap={4} data-testid="situation-pick">
      <Stack gap={1}>
        <Text role="ui-caption" as="p">
          {t('startingSituation.eyebrow')}
        </Text>
        <Heading level={1} role="title">
          {t('startingSituation.prompt')}
        </Heading>
      </Stack>
      <SituationBody load={load} submitFailed={submitFailed} onSelect={handleSelect} />
    </Stack>
  )
}
