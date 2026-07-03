import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Stack, Box, Text, Button, Icon } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { ConceptRejection } from '@mythrun/client-core'
import { ForkScreen } from './campaign-new/fork.tsx'
import { FreeformScreen } from './campaign-new/freeform.tsx'
import { GuidedScreen } from './campaign-new/guided.tsx'

// The campaign-create flow (`/campaigns/new`, spec §1) — a thin screen state
// machine. The player walks a linear path of SCREENS; the controller holds a
// per-screen back-history (a stack) so a `← back` affordance pops one step at a
// time. The FORK is the flow's root (spec §2, `ForkScreen`); `freeform` (B3) +
// `guided` (B4) are real screens firing neutral intents; `preview` + `rejection`
// remain trivially-small stubs Task B5 replaces (they already receive the carried
// payload so the wiring is exercised). Composes @mythrun/ui only (R5 — no ad-hoc UI).

// The screens the flow can be on. `fork` is always the history root.
type Screen = 'fork' | 'freeform' | 'guided' | 'preview' | 'rejection'

// The synthesized preview the guided path parks under an opaque id (Task B5 — the
// preview screen — consumes it to render + commit the concept).
interface PreviewPayload {
  previewId: string
  concept: string
}

// The not-yet-built PREVIEW screen (Task B5). Still a stub, but it already
// receives the carried payload so the controller wiring is exercised end-to-end;
// B5 replaces the body. Renders the previewId (a dynamic value, not translatable
// copy) so the plumbing is observable.
function PreviewStub({ payload }: { payload: PreviewPayload | null }): React.JSX.Element {
  return (
    <Box data-testid="screen-preview">
      <Text role="meta" data-testid="preview-payload">
        {payload?.previewId ?? ''}
      </Text>
    </Box>
  )
}

export function CampaignNewRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The back-history stack: the last entry is the current screen; `fork` is the
  // permanent root (never popped), so `back` is shown iff the stack has depth.
  const [history, setHistory] = useState<Screen[]>(['fork'])
  const current = history[history.length - 1] ?? 'fork'
  // The guided synthesis outputs the controller carries forward to B5's preview /
  // rejection screens. Defined now (this task) so the payload shape is fixed.
  const [previewPayload, setPreviewPayload] = useState<PreviewPayload | null>(null)
  const [rejection, setRejection] = useState<ConceptRejection | null>(null)

  const go = (next: Screen): void => {
    setHistory((h) => [...h, next])
  }
  const back = (): void => {
    setHistory((h) => (h.length > 1 ? h.slice(0, -1) : h))
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
        <ForkScreen
          onFreeform={() => {
            go('freeform')
          }}
          onGuided={() => {
            go('guided')
          }}
        />
      ) : current === 'freeform' ? (
        <FreeformScreen
          onCommitted={(campaignId) => {
            // The generating route (Phase C makes it phase-aware). A real navigate
            // now — the screen fires a neutral intent; the controller owns the route.
            void navigate(`/campaigns/${campaignId}`)
          }}
          onGuided={() => {
            go('guided')
          }}
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
          onFreeform={() => {
            go('freeform')
          }}
        />
      ) : current === 'preview' ? (
        <PreviewStub payload={previewPayload} />
      ) : (
        // The rejection screen (Task B5). A stub that already receives the carried
        // reason so the guided 422 wiring is observable end-to-end.
        <Box data-testid="screen-rejection">
          <Text role="meta" data-testid="rejection-payload">
            {rejection?.reason ?? ''}
          </Text>
        </Box>
      )}
    </Stack>
  )
}
