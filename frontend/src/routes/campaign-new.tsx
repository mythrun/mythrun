import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Stack, Button, Icon } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { clearGuidedDraft, type SynthesisStream } from '@mythrun/client-core'
import { ForkScreen } from './campaign-new/fork.tsx'
import { FreeformScreen } from './campaign-new/freeform.tsx'
import { GuidedScreen } from './campaign-new/guided.tsx'
import { SynthesizingScreen } from './campaign-new/synthesizing.tsx'
import { PreviewScreen, type PreviewPayload } from './campaign-new/preview.tsx'
import { RejectionScreen, type RejectionState } from './campaign-new/rejection.tsx'

// The campaign-create flow (`/campaigns/new`, spec §1) — a thin screen state
// machine. The player walks a linear path of SCREENS; the controller holds a
// per-screen back-history (a stack) so a `← back` affordance pops one step at a
// time. The FORK is the flow's root (spec §2, `ForkScreen`); `freeform` (B3),
// `guided` (B4), `synthesizing` (myth-umggn), `preview` + `rejection` (B5) are
// real screens firing neutral intents. The controller owns the carried
// payloads (the live synthesis stream, the synthesized preview, the rejection
// reason, the freeform seed) and maps each screen's intents to a
// `screen`/route. Composes @mythrun/ui only (R5 — no ad-hoc UI).
//
// myth-umggn: guided synthesis STREAMS. The guided screen opens the stream
// (its notices keep every pre-stream failure); on the 200 head the controller
// advances to `synthesizing`, which renders the brief writing itself. Its
// terminals SWAP the top of the history (never push) so `← back` from
// preview/rejection lands on the guided picks — the synthesizing beat is a
// transition, not a place to return to. The controller owns the stream
// handle's lifecycle: it closes it on back-out (aborting the Sonnet burn), on
// replacement, and on unmount.

// The screens the flow can be on. `fork` is always the history root.
type Screen = 'fork' | 'freeform' | 'guided' | 'synthesizing' | 'preview' | 'rejection'

export function CampaignNewRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The back-history stack: the last entry is the current screen; `fork` is the
  // permanent root (never popped), so `back` is shown iff the stack has depth.
  const [history, setHistory] = useState<Screen[]>(['fork'])
  const current = history[history.length - 1] ?? 'fork'
  // The carried payloads. `synthesis` is the live guided stream the
  // synthesizing screen renders; `previewPayload` is the completed synthesis
  // the preview screen renders + commits; `rejection` is the reason the
  // rejection screen shows; `freeformPrefill` seeds the freeform field
  // (default blank; the rejection screen's "edit as freeform" drops the judged
  // concept in here).
  const [synthesis, setSynthesis] = useState<SynthesisStream | null>(null)
  const [previewPayload, setPreviewPayload] = useState<PreviewPayload | null>(null)
  const [rejection, setRejection] = useState<RejectionState | null>(null)
  const [freeformPrefill, setFreeformPrefill] = useState('')

  // Stream lifecycle backstop: whenever the handle is replaced — and when the
  // route unmounts — close the PRIOR stream. Closing a terminal stream is a
  // no-op; closing a live one aborts the request (and the server aborts its
  // Sonnet call), so an abandoned brief never generates into the void.
  useEffect(() => {
    if (synthesis === null) return
    return () => {
      synthesis.close()
    }
  }, [synthesis])

  const go = (next: Screen): void => {
    setHistory((h) => [...h, next])
  }
  // Replace the CURRENT screen (the synthesizing → preview/rejection handoff):
  // the brief-writing beat must not sit in the back-history.
  const swap = (next: Screen): void => {
    setHistory((h) => [...h.slice(0, -1), next])
  }
  const back = (): void => {
    // Backing out of a live synthesis is an intentional abandon — stop the
    // stream (and the server's Sonnet burn) before leaving the screen.
    if (current === 'synthesizing') {
      synthesis?.close()
      setSynthesis(null)
    }
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h))
  }
  // A fresh (blank) entry to freeform — clears any stale "edit as freeform" seed.
  const goFreeformBlank = (): void => {
    setFreeformPrefill('')
    go('freeform')
  }
  // The generating route (Phase C makes it phase-aware). A real campaign create —
  // via ANY commit path (guided preview Begin, or a guided draft committed through
  // the freeform screen after guided→switch or a rejection→"edit as freeform") —
  // clears the guided draft exactly once, here. The clear is IDEMPOTENT (a no-op
  // when no draft was written, e.g. pure freeform), so the picks still survive
  // synthesize → preview → rework → a 410-restart (those re-prefill) and only an
  // actual create drops them (spec §11). Then a real navigate — the screen fires a
  // neutral intent; the controller owns the route.
  const toCampaign = (campaignId: string): void => {
    clearGuidedDraft()
    void navigate(`/campaigns/${campaignId}`)
  }

  return (
    // One centred reading-measure column (`maxWidth="form"`) so every funnel screen
    // shares a single spine (incl. the back affordance) instead of sprawling edge-to-edge.
    <Stack gap={6} maxWidth="form" data-testid="route-campaign-new">
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
          onStreaming={(stream) => {
            setSynthesis(stream)
            go('synthesizing')
          }}
          onFreeform={goFreeformBlank}
        />
      ) : current === 'synthesizing' && synthesis ? (
        <SynthesizingScreen
          stream={synthesis}
          onSynthesized={(payload) => {
            setPreviewPayload(payload)
            swap('preview')
          }}
          onRejected={(r) => {
            setRejection(r)
            swap('rejection')
          }}
          onRetry={back}
        />
      ) : current === 'preview' && previewPayload ? (
        <PreviewScreen
          payload={previewPayload}
          onCommitted={toCampaign}
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
