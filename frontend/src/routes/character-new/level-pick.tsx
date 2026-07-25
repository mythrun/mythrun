import { useEffect, useState } from 'react'
import { Stack, Heading, Text, Grid, Button, LevelCard } from '@mythrun/ui'
import {
  getMyCampaigns,
  getStartingSituations,
  isHttpError,
  setStartingLevel as setStartingLevelApi,
  type ApiContext,
  type CampaignSummary,
  useApiContext,
} from '@mythrun/client-core'
import type { CharacterLevel } from '@mythrun/client-core/contract'
import { useTranslation } from 'react-i18next'
import { useNavigate, useParams } from 'react-router-dom'

// The STARTING-LEVEL PICK (MYT-90 character creation, D2) — the party-wide beat
// between the situation pick (D1) and character creation (D3), and OWNER-ONLY. The
// owner (`CampaignSummary.creator === null` — the viewer made this world) sets the
// party's SHARED starting level (1–5); every character the table makes is built at
// that level. A member (a joined world, a non-null creator) — or an unresolved /
// failed role probe — sees a calm WAITING HOLD instead of the picker; the level is
// the owner's to set. The five levels are STATIC (not fetched) — each level's
// `grantGloss` is a plain-D&D one-line i18n gloss of what it grants, caster-
// specifics hedged. Single-select with a default of 3 (the mockup's pre-selection,
// the canonical spec); confirming POSTs the level via `setStartingLevel` and hands
// off to the CREATE beat (`/campaigns/:id/character/new`). A 409 `level_locked`
// (already set) is idempotent-success — hand off anyway; any OTHER failure surfaces
// a calm retryable note and keeps the picker up. All UI composes @mythrun/ui.

/** The set sink — defaults to the real endpoint; tests substitute it. */
type SetStartingLevel = (ctx: ApiContext, campaignId: string, level: number) => Promise<void>
/** The campaigns source (the role probe) — defaults to `/api/campaigns/mine`; tests
 *  substitute it. Same shape + wiring the situation pick uses to read a world's role. */
type FetchCampaigns = (ctx: ApiContext) => Promise<readonly CampaignSummary[]>
type FetchStartingLevel = (ctx: ApiContext, campaignId: string) => Promise<number | null>

/** Read the persisted party starting level (from the situations projection). The
 *  picker seeds its pre-selection from this so Back → re-confirm can't silently
 *  clobber a chosen level with the default (MYT-102 QA M1). */
const defaultFetchStartingLevel: FetchStartingLevel = (ctx, campaignId) =>
  getStartingSituations(ctx, campaignId).then((r) => r.startingLevel)

const defaultFetchCampaigns: FetchCampaigns = (ctx) =>
  getMyCampaigns(undefined, ctx).then((r) => r.campaigns)

/** The viewer's role for this campaign. `owner` sees the picker; `member` (and the
 *  unresolved `loading` state) sees the calm hold — the gate fails CLOSED so the
 *  owner-only picker never flashes for a non-owner. */
type RoleState = 'loading' | 'owner' | 'member'

/** Resolve the viewer's role from the hub payload: `creator === null` means the
 *  viewer made this world (owner); any other case — a non-null creator, a campaign
 *  we can't see, or a failed probe — resolves to `member` (the safe, gated default). */
function useOwnerRole(
  campaignId: string,
  ctx: ApiContext,
  fetchCampaigns: FetchCampaigns,
): RoleState {
  const [role, setRole] = useState<RoleState>('loading')
  useEffect(() => {
    let active = true
    setRole('loading')
    void fetchCampaigns(ctx)
      .then((list) => {
        if (!active) return
        const campaign = list.find((c) => c.id === campaignId) ?? null
        setRole(campaign !== null && campaign.creator === null ? 'owner' : 'member')
      })
      .catch(() => {
        // A failed role probe fails CLOSED — the member hold, never the owner picker.
        if (active) setRole('member')
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, fetchCampaigns])
  return role
}

/** The party's default starting level — the mockup's pre-selection (a common
 *  "begin at 3" table convention); the canonical mockup IS the spec. */
const DEFAULT_LEVEL: CharacterLevel = 3

interface LevelChoice {
  readonly level: CharacterLevel
  readonly grantGloss: string
}

/** The five level choices, each with its plain-D&D i18n grant gloss. Literal
 *  i18n keys (not dynamically constructed) so the typed-key rail stays satisfied. */
function useLevelChoices(): readonly LevelChoice[] {
  const { t } = useTranslation()
  return [
    { level: 1, grantGloss: t('startingLevel.grant1') },
    { level: 2, grantGloss: t('startingLevel.grant2') },
    { level: 3, grantGloss: t('startingLevel.grant3') },
    { level: 4, grantGloss: t('startingLevel.grant4') },
    { level: 5, grantGloss: t('startingLevel.grant5') },
  ]
}

/** The member (non-owner) WAITING HOLD — a calm eyebrow + heading + line; the owner
 *  sets the party level, so a member just holds until the table is set. Never
 *  renders the owner-only picker (no level cards). */
function MemberHold(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Stack gap={4} data-testid="level-pick-hold">
      <Stack gap={1}>
        <Text role="ui-caption" as="p">
          {t('startingLevel.eyebrow')}
        </Text>
        <Heading level={1} role="title">
          {t('startingLevel.holdTitle')}
        </Heading>
      </Stack>
      <Text role="ui-caption" as="p">
        {t('startingLevel.hold')}
      </Text>
    </Stack>
  )
}

/** Seed the pre-selection from the persisted level (owner only) so the picker
 *  reflects a prior choice instead of always showing the default — otherwise
 *  Back → re-confirm silently overwrites e.g. 5 with 3 (MYT-102 QA M1). A failed
 *  probe just leaves the default. */
function usePersistedLevelSeed(
  role: RoleState,
  ctx: ApiContext,
  campaignId: string,
  fetchStartingLevel: FetchStartingLevel,
  setSelected: (level: CharacterLevel) => void,
): void {
  useEffect(() => {
    if (role !== 'owner') return
    let active = true
    void fetchStartingLevel(ctx, campaignId)
      .then((lvl) => {
        if (active && lvl !== null && lvl >= 1 && lvl <= 5) setSelected(lvl as CharacterLevel)
      })
      .catch(() => {
        // Calm: a failed probe just leaves the default pre-selection.
      })
    return () => {
      active = false
    }
  }, [role, ctx, campaignId, fetchStartingLevel, setSelected])
}

export interface LevelPickRouteProps {
  /** The set sink — defaults to the real endpoint; tests substitute it. */
  setStartingLevel?: SetStartingLevel
  /** The role probe — defaults to the real `/api/campaigns/mine` endpoint; tests
   *  substitute it to render the owner picker vs. the member hold. */
  fetchCampaigns?: FetchCampaigns
  /** The persisted-level probe — seeds the pre-selection so a re-confirm never
   *  silently downgrades a stored level (MYT-102 QA M1). */
  fetchStartingLevel?: FetchStartingLevel
}

export function LevelPickRoute({
  setStartingLevel = setStartingLevelApi,
  fetchCampaigns = defaultFetchCampaigns,
  fetchStartingLevel = defaultFetchStartingLevel,
}: LevelPickRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const role = useOwnerRole(id, ctx, fetchCampaigns)
  const choices = useLevelChoices()
  const [selected, setSelected] = useState<CharacterLevel>(DEFAULT_LEVEL)
  usePersistedLevelSeed(role, ctx, id, fetchStartingLevel, setSelected)
  const [submitFailed, setSubmitFailed] = useState(false)

  const handleConfirm = (): void => {
    setSubmitFailed(false)
    void setStartingLevel(ctx, id, selected)
      .then(() => void navigate(`/campaigns/${id}/character/new`))
      .catch((err: unknown) => {
        // A locked level is already set — hand off to the create beat idempotently.
        // Any OTHER failure surfaces a calm retryable note; the picker stays.
        if (isHttpError(err) && err.status === 409 && err.code === 'level_locked') {
          void navigate(`/campaigns/${id}/character/new`)
          return
        }
        setSubmitFailed(true)
      })
  }

  // Non-owners never see the owner-only picker. While the role probe is in flight we
  // hold on a neutral loading line (no owner framing leaks); a member gets the hold.
  if (role === 'loading') {
    return (
      <Stack gap={4} data-testid="level-pick-loading">
        <Text role="ui-caption" as="p">
          {t('startingLevel.loading')}
        </Text>
      </Stack>
    )
  }
  if (role === 'member') {
    return <MemberHold />
  }

  return (
    // The page-seated block (ux-run2 myth-ma8yv, critique 023): a minHeight="page"
    // column with 1:2 grow spacers seats the one decision optically above center
    // instead of top-anchoring it over a dead lower half. On short viewports the
    // content exceeds the floor and the spacers quietly collapse.
    <Stack minHeight="page" data-testid="level-pick">
      <Stack grow={1} />
      <Stack gap={5}>
        <Stack gap={1}>
          <Text role="ui-caption" as="p">
            {t('startingLevel.eyebrow')}
          </Text>
          <Heading level={1} role="title">
            {t('startingLevel.prompt')}
          </Heading>
          <Text role="prose-body" as="p">
            {t('startingLevel.lede')}
          </Text>
        </Stack>
        {/* 5-across on a normal desktop, collapsing to a single stacked column at
            375px: min(176px,100%) tracks stack when only one fits. auto-FIT (not
            auto-fill) so EMPTY tracks collapse and the five real cards stretch to
            the full measure — the card row and the confirm button below share
            their right edge (ux-run2 myth-ma8yv, critique 023: auto-fill's
            phantom sixth track ended the row ~200px shy of the button). */}
        <Grid columns="auto-fit" minColumnPx={176} gap={3}>
          {choices.map((choice) => (
            <LevelCard
              key={choice.level}
              level={choice.level}
              eyebrow={t('startingLevel.cardEyebrow')}
              grantGloss={choice.grantGloss}
              selected={choice.level === selected}
              onSelect={() => {
                setSelected(choice.level)
              }}
            />
          ))}
        </Grid>
        <Stack gap={2}>
          <Button variant="primary" onPress={handleConfirm} data-testid="level-pick-confirm">
            {t('startingLevel.cta', { level: selected })}
          </Button>
          {/* The choice's permanence, stated plainly (ux-run2 myth-nyjtl): the
              level is party-wide and locks once set — exactly what a hesitating
              newcomer wants to know, and true of the product (409 level_locked). */}
          <Text role="ui-caption" as="p" data-testid="level-pick-permanence">
            {t('startingLevel.permanence')}
          </Text>
          {submitFailed && (
            <Text role="ui-caption" as="p">
              {t('startingLevel.error')}
            </Text>
          )}
        </Stack>
      </Stack>
      <Stack grow={2} />
    </Stack>
  )
}
