import { useEffect, useState } from 'react'
import { Stack, Heading, Text, Button } from '@mythrun/ui'
import {
  getWorldSnapshot,
  useApiContext,
  type ApiContext,
  type WorldGenSnapshot,
} from '@mythrun/client-core'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

// The MEMBER-JOIN WORLD-INTRO SUMMARY (MYT-90 D9) — the brief entry surface a
// member reaches after accepting an invite (MYT-91 owns the invite→here
// navigation). It is a BRIEFER variant of the owner's world reveal (worldgen/
// reveal.tsx): where the owner gets the interactive graph beside the browsable
// wiki, a joining member just needs to know WHAT they're joining — so this shows
// the world's NAME (the introduction title, which is mechanically the world's
// name) + a short intro paragraph in the same paper/serif introduction register,
// then hands off to character creation.
//
// The situation + starting level are the OWNER's to set and are already fixed by
// the time a member lands here, so the member skips those beats — the single CTA
// goes straight to `/campaigns/:id/character/new`.
//
// It owns one fetch + one behaviour:
//   • FETCH the world snapshot (the same read the reveal wiki uses) and surface
//     `introduction.title` + `introduction.prose`. The endpoint is readable by
//     any campaign member (myth-0xwos) and serves the plot-safe world
//     projection, so a joined member gets real content; any failed fetch
//     (transient, or a true denial for a non-member) fails CLOSED to a calm,
//     retryable notice (never an error flash, never a fake identity).
//   • CTA "Create your character" → navigate to the create beat.
//
// Flat 1-bit paper register; all UI composes @mythrun/ui.

/** The world-snapshot read — defaults to the real endpoint; tests + stories substitute it. */
type FetchSnapshot = (ctx: ApiContext, campaignId: string) => Promise<WorldGenSnapshot>

/** The fetch lifecycle: loading → ready (the world name + intro prose) | error. */
type LoadState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly title: string; readonly prose: string }

export interface JoinSummaryRouteProps {
  /** The snapshot source — defaults to the real endpoint; tests + stories substitute it. */
  fetchSnapshot?: FetchSnapshot
}

export function JoinSummaryRoute({
  fetchSnapshot = getWorldSnapshot,
}: JoinSummaryRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const [load, setLoad] = useState<LoadState>({ status: 'loading' })
  // A retry nudge — bumping it re-runs the fetch effect.
  const [reloadKey, setReloadKey] = useState(0)

  useEffect(() => {
    let active = true
    setLoad({ status: 'loading' })
    void fetchSnapshot(ctx, id)
      .then((snapshot) => {
        if (!active) return
        const intro = snapshot.introduction
        // The endpoint 409s until the world_introduction stage commits, so a
        // served snapshot always carries the intro; a missing one is treated as
        // the same calm unavailable state rather than a bare, nameless world.
        if (intro === undefined) {
          setLoad({ status: 'error' })
          return
        }
        setLoad({ status: 'ready', title: intro.title, prose: intro.prose })
      })
      .catch(() => {
        if (active) setLoad({ status: 'error' })
      })
    return () => {
      active = false
    }
  }, [ctx, id, fetchSnapshot, reloadKey])

  if (load.status === 'loading') {
    return (
      <Stack gap={4} data-testid="join-summary-loading">
        <Text role="ui-caption" as="p">
          {t('characterCreate.joinSummary.loading')}
        </Text>
      </Stack>
    )
  }

  if (load.status === 'error') {
    return (
      <Stack gap={3} data-testid="join-summary-error">
        <Text role="ui-caption" as="p">
          {t('characterCreate.joinSummary.loadError')}
        </Text>
        <Button
          variant="secondary"
          onPress={() => {
            setReloadKey((k) => k + 1)
          }}
        >
          {t('characterCreate.joinSummary.retry')}
        </Button>
      </Stack>
    )
  }

  return (
    <Stack gap={5} data-testid="join-summary">
      <Stack gap={1}>
        <Text role="ui-caption" as="p">
          {t('characterCreate.joinSummary.eyebrow')}
        </Text>
        <Heading level={1} role="title" data-testid="join-summary-world-name">
          {load.title}
        </Heading>
      </Stack>
      <Text role="prose-body" as="p" data-testid="join-summary-intro">
        {load.prose}
      </Text>
      <Stack direction="row">
        <Button
          variant="primary"
          onPress={() => void navigate(`/campaigns/${id}/character/new`)}
          data-testid="join-summary-create"
        >
          {t('characterCreate.joinSummary.cta')}
        </Button>
      </Stack>
    </Stack>
  )
}
