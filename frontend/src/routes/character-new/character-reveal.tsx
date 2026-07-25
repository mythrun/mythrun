import { useEffect, useState } from 'react'
import { Stack, Text, Button, CharacterSheetReveal } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import {
  getCharacter as getCharacterApi,
  confirmCharacter as confirmCharacterApi,
  resetCharacterConcept as resetCharacterConceptApi,
  useApiContext,
  type ApiContext,
  type CharacterFull,
} from '@mythrun/client-core'
import { toRevealViewModel } from './sheet-adapter.ts'

// The CHARACTER-REVEAL SURFACE (MYT-90 D6) — the "Meet your character" screen the D8
// routing table mounts once the viewer's own character concept is `completed` &
// unconfirmed. It is a thin, self-contained composition: it FETCHES the finished
// character (the raw snake_case `getCharacter` read), ADAPTS it into the reveal's
// `{ curated, full }` view-model (the deterministic `sheet-adapter` — SRD maps + B4's
// sheetViewModel, never a prose parse), and renders the DS <CharacterSheetReveal>.
//
// It owns exactly three behaviours:
//   • "This is me" → confirmCharacter → onConfirmed (D8 re-routes the player to the
//     party/staging beat).
//   • "Start over" → resetCharacterConcept → onReset (D8 re-routes back to create).
//   • "See full sheet" → a LOCAL `expanded` toggle — a pure client reveal of data
//     already in props, NO network (the DS component is controlled).
//
// A failed confirm/reset keeps the reveal up under a calm, retryable note (the
// action is re-tryable); a failed initial fetch shows a calm error with a retry.

/** The finished-character read — defaults to the real endpoint; tests + stories substitute. */
type GetCharacter = (ctx: ApiContext, campaignId: string, charId: string) => Promise<CharacterFull>
/** The self-scoped confirm/reset mutations — defaults are the real endpoints. */
type CampaignMutation = (ctx: ApiContext, campaignId: string) => Promise<void>

export interface CharacterRevealSurfaceProps {
  /** The campaign whose character this reveals. */
  campaignId: string
  /** The persisted PC id to fetch + reveal. */
  charId: string
  /** Called after a successful confirm — D8 re-routes to the party/staging beat. */
  onConfirmed: () => void
  /** Called after a successful reset — D8 re-routes back to character creation. */
  onReset: () => void
  /** Injected endpoint seams (default to the real endpoints); tests + stories substitute. */
  getCharacter?: GetCharacter
  confirmCharacter?: CampaignMutation
  resetCharacterConcept?: CampaignMutation
}

/** The fetch lifecycle: loading → ready (with the adapted view-model) | error. */
type LoadState =
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; view: ReturnType<typeof toRevealViewModel> }

/** The reveal's resolved chrome labels (shell-owned i18n). */
function revealLabels(t: TFunction): React.ComponentProps<typeof CharacterSheetReveal>['labels'] {
  return {
    confirm: t('characterCreate.reveal.confirm'),
    seeFull: t('characterCreate.reveal.seeFull'),
    hideFull: t('characterCreate.reveal.hideFull'),
    startOver: t('characterCreate.reveal.startOver'),
    startOverPrompt: t('characterCreate.reveal.startOverPrompt'),
    startOverConfirm: t('characterCreate.reveal.startOverConfirm'),
    startOverKeep: t('characterCreate.reveal.startOverKeep'),
    panelFeatures: t('characterCreate.reveal.panel.features'),
    panelEquipment: t('characterCreate.reveal.panel.equipment'),
    panelSpells: t('characterCreate.reveal.panel.spells'),
  }
}

/** The calm loading line while the character read is in flight. */
function RevealLoading({ t }: { t: TFunction }): React.JSX.Element {
  return (
    <Stack gap={4} data-testid="character-reveal-loading">
      <Text role="ui-caption" as="p">
        {t('characterCreate.reveal.loading')}
      </Text>
    </Stack>
  )
}

/** The calm retryable error screen for a failed initial fetch. */
function RevealError({ t, onRetry }: { t: TFunction; onRetry: () => void }): React.JSX.Element {
  return (
    <Stack gap={3} data-testid="character-reveal-error">
      <Text role="ui-caption" as="p">
        {t('characterCreate.reveal.loadError')}
      </Text>
      <Button variant="secondary" onPress={onRetry}>
        {t('characterCreate.reveal.retry')}
      </Button>
    </Stack>
  )
}

export function CharacterRevealSurface({
  campaignId,
  charId,
  onConfirmed,
  onReset,
  getCharacter = getCharacterApi,
  confirmCharacter = confirmCharacterApi,
  resetCharacterConcept = resetCharacterConceptApi,
}: CharacterRevealSurfaceProps): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  const [expanded, setExpanded] = useState(false)
  // The two-step start-over confirm (ux-run2 myth-fca4y): the DS reveal is fully
  // controlled, so this surface owns the armed/dismissed state; the destructive
  // reset fires only from the confirm verb.
  const [startOverConfirming, setStartOverConfirming] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  // A retry nudge — bumping it re-runs the fetch effect.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    setLoad({ status: 'loading' })
    void getCharacter(ctx, campaignId, charId)
      .then((raw) => {
        if (!active) return
        setLoad({ status: 'ready', view: toRevealViewModel(raw) })
      })
      .catch(() => {
        if (active) setLoad({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [ctx, campaignId, charId, getCharacter, reloadKey])

  if (load.status === 'loading') {
    return <RevealLoading t={t} />
  }
  if (load.status === 'error') {
    return (
      <RevealError
        t={t}
        onRetry={() => {
          setReloadKey((k) => k + 1)
        }}
      />
    )
  }

  const handleConfirm = (): void => {
    setActionFailed(false)
    void confirmCharacter(ctx, campaignId)
      .then(() => {
        onConfirmed()
      })
      .catch(() => {
        setActionFailed(true)
      })
  }

  const handleStartOver = (): void => {
    setActionFailed(false)
    void resetCharacterConcept(ctx, campaignId)
      .then(() => {
        onReset()
      })
      .catch(() => {
        setActionFailed(true)
      })
  }

  return (
    <Stack gap={4} data-testid="character-reveal">
      <CharacterSheetReveal
        curated={load.view.curated}
        full={load.view.full}
        expanded={expanded}
        onToggleExpand={() => {
          setExpanded((v) => !v)
        }}
        onConfirm={handleConfirm}
        startOverConfirming={startOverConfirming}
        onRequestStartOver={() => {
          setStartOverConfirming(true)
        }}
        onCancelStartOver={() => {
          setStartOverConfirming(false)
        }}
        onStartOver={handleStartOver}
        labels={revealLabels(t)}
      />
      {actionFailed && (
        <Text role="ui-caption" as="p" data-testid="character-reveal-action-error">
          {t('characterCreate.reveal.actionError')}
        </Text>
      )}
    </Stack>
  )
}
