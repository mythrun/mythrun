import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Stack, Box, Button, Icon } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import { ForkScreen } from './campaign-new/fork.tsx'
import { FreeformScreen } from './campaign-new/freeform.tsx'

// The campaign-create flow (`/campaigns/new`, spec §1) — a thin screen state
// machine. The player walks a linear path of SCREENS; the controller holds a
// per-screen back-history (a stack) so a `← back` affordance pops one step at a
// time. The FORK is the flow's root (spec §2, `ForkScreen`); the other screens are
// STUB placeholders Tasks B3–B5 replace, kept trivially small so the controller
// can already route to them. Composes @mythrun/ui only (R5 — no ad-hoc UI).

// The screens the flow can be on. `fork` is always the history root.
type Screen = 'fork' | 'freeform' | 'guided' | 'preview' | 'rejection'

// The not-yet-built screens (Tasks B3–B5). A minimal, data-testid'd `Box` (a
// @mythrun/ui primitive, not a raw <div>) the controller can already route to;
// each grows its own body + i18n keys when its task lands.
function ScreenStub({ screen }: { screen: Exclude<Screen, 'fork'> }): React.JSX.Element {
  return <Box data-testid={`screen-${screen}`} />
}

export function CampaignNewRoute(): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  // The back-history stack: the last entry is the current screen; `fork` is the
  // permanent root (never popped), so `back` is shown iff the stack has depth.
  const [history, setHistory] = useState<Screen[]>(['fork'])
  const current = history[history.length - 1] ?? 'fork'

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
      ) : (
        <ScreenStub screen={current} />
      )}
    </Stack>
  )
}
