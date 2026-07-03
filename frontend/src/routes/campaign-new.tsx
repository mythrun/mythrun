import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Stack, Button, Icon } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { clearGuidedDraft } from '@mythrun/client-core'
import { ForkScreen } from './campaign-new/fork.tsx'
import { FreeformScreen } from './campaign-new/freeform.tsx'
import { GuidedScreen } from './campaign-new/guided.tsx'
import { PreviewScreen, type PreviewPayload } from './campaign-new/preview.tsx'
import { RejectionScreen, type RejectionState } from './campaign-new/rejection.tsx'

// The campaign-create flow (`/campaigns/new`, spec §1) — a thin screen state
// machine. The player walks a linear path of SCREENS; the controller holds a
// per-screen back-history (a stack) so a `← back` affordance pops one step at a
// time. The FORK is the flow's root (spec §2, `ForkScreen`); `freeform` (B3),
// `guided` (B4), `preview` + `rejection` (B5) are real screens firing neutral
// intents. The controller owns the carried payloads (the synthesized preview,
// the rejection reason, the freeform seed) and maps each screen's intents to a
// `screen`/route. Composes @mythrun/ui only (R5 — no ad-hoc UI).

// The screens the flow can be on. `fork` is always the history root.
type Screen = 'fork' | 'freeform' | 'guided' | 'preview' | 'rejection'

export function CampaignNewRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The back-history stack: the last entry is the current screen; `fork` is the
  // permanent root (never popped), so `back` is shown iff the stack has depth.
  const [history, setHistory] = useState<Screen[]>(['fork'])
  const current = history[history.length - 1] ?? 'fork'
  // The carried payloads. `previewPayload` is the guided synthesis result the
  // preview screen renders + commits; `rejection` is the reason the rejection
  // screen shows; `freeformPrefill` seeds the freeform field (default blank; the
  // rejection screen's "edit as freeform" drops the judged concept in here).
  const [previewPayload, setPreviewPayload] = useState<PreviewPayload | null>(null)
  const [rejection, setRejection] = useState<RejectionState | null>(null)
  const [freeformPrefill, setFreeformPrefill] = useState('')

  const go = (next: Screen): void => {
    setHistory((h) => [...h, next])
  }
  const back = (): void => {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h))
  }
  // A fresh (blank) entry to freeform — clears any stale "edit as freeform" seed.
  const goFreeformBlank = (): void => {
    setFreeformPrefill('')
    go('freeform')
  }
  // The generating route (Phase C makes it phase-aware). A real navigate — the
  // screen fires a neutral intent; the controller owns the route.
  const toCampaign = (campaignId: string): void => {
    void navigate(`/campaigns/${campaignId}`)
  }
  // A committed GUIDED campaign is the ONLY moment the guided draft is cleared
  // (spec §11): the picks survive synthesize → preview → rework → a 410-restart so
  // those paths re-prefill; only an actual campaign create drops the draft. The
  // freeform path never wrote a draft, so it needs no clear.
  const onGuidedCommitted = (campaignId: string): void => {
    clearGuidedDraft()
    toCampaign(campaignId)
  }

  return (
    <Stack gap={5} data-testid="route-campaign-new">
      {current !== 'fork' ? (
        <Stack align="start">
          <Button
            variant="ghost"
            size="sm"
            icon={<Icon name="arrow-left" decorative />}
            onPress={back}
            data-testid="campaign-new-back"
          >
            {t('back')}
          </Button>
        </Stack>
      ) : null}
      {current === 'fork' ? (
        <ForkScreen onFreeform={goFreeformBlank} onGuided={() => { go('guided') }} />
      ) : current === 'freeform' ? (
        <FreeformScreen
          initialConcept={freeformPrefill}
          onCommitted={toCampaign}
          onGuided={() => { go('guided') }}
        />
      ) : current === 'guided' ? (
        <GuidedScreen
          onSynthesized={(payload) => {
            setPreviewPayload(payload)
            go('preview')
          }}
          onRejected={(r) => {
            setRejection(r)
            go('rejection')
          }}
          onFreeform={goFreeformBlank}
        />
      ) : current === 'preview' && previewPayload ? (
        <PreviewScreen
          payload={previewPayload}
          onCommitted={onGuidedCommitted}
          onStartOver={() => { go('guided') }}
          onPreviewExpired={() => { go('guided') }}
          onRejected={(r) => {
            setRejection(r)
            go('rejection')
          }}
        />
      ) : current === 'rejection' && rejection ? (
        <RejectionScreen
          rejection={rejection}
          onEditAsFreeform={(concept) => {
            setFreeformPrefill(concept)
            go('freeform')
          }}
          onStartOver={() => { go('guided') }}
        />
      ) : null}
    </Stack>
  )
}
