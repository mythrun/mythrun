import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Drawer, Heading, IconButton, Stack, Text, useViewportBelowLg } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useParams } from 'react-router-dom'
import {
  getStartingSituations,
  getWorldSnapshot,
  submitCharacter,
  useApiContext,
  type ApiContext,
  type StartingSituation,
  type StartingSituationsResponse,
  type SubmitCharacterBody,
  type SubmitCharacterResponse,
} from '@mythrun/client-core'
import { createMachine, type CreateState, type CreateEvent } from '@mythrun/client-core/character'
import { PathChooser } from './character-new/path-chooser.tsx'
import { FreeformPath } from './character-new/freeform-path.tsx'
import { GuidedPath } from './character-new/guided-path.tsx'
import { WikiPanel, useWikiModel, type FetchSnapshot } from './wiki-panel.tsx'

// The CHARACTER-CREATE screen (`/campaigns/:id/character/new`, MYT-90 D3) — the
// entry to character creation: the two-path CHOOSER + the FREEFORM path. The
// route owns the create-machine state (a small pure brain in @mythrun/client-core/
// character), the campaignId (route param), the api context, and the one-time
// starting-situations fetch (the chosen situation's `invitation` becomes the
// freeform grounding whisper; its title/location/prose become the recap card —
// MYT-102). The path components are thin route-local compositions of DS
// primitives.
//
// THE WORLD WIKI DURING CREATION (MYT-102): the route mounts the promoted
// WikiPanel (routes/wiki-panel.tsx — the same member-readable snapshot read the
// reveal and the join summary use; enforced ignorance is SERVER-side) so the
// player can consult the actual world while writing their character. Two layout
// regimes on the DS's `lg`-step JS flip (`useViewportBelowLg` — the play-sidebar
// idiom, one structural mount): desktop → a collapsible ~30% side rail beside
// the creation column (default OPEN); narrow → the shipped edge-handle Drawer,
// whose children stay MOUNTED across close→open (reader page + scroll survive).
// The snapshot model lives HERE (not in the rail), so collapsing the rail never
// refetches. Selection has no consumer on this route (no graph to keep in step),
// so the panel's onSelect is a no-op; query state is local per the reveal idiom.
//
// The GUIDED branch (D4) is a controlled <GuidedPath> over the client-core guided
// reducer + submitCharacter (the reducer owns the step sequence + the conditional
// Subclass skip, gated by the party's starting level). On a successful submit the
// machine reaches `processing` — the post-submit seam Track B owns; MYT-102 leaves
// it as the committed placeholder line, which Track B swaps for the D5
// <CharacterLoadingBeat>. D6 (reveal/confirm) owns the `reveal`/`staging` machine
// states — unreachable here (nothing dispatches `ready`/`confirm` yet).

/** The guided builder needs a numeric party level to gate its Subclass step. The
 *  owner sets the real level before anyone reaches character creation; this level-1
 *  default only covers the (unreachable-in-practice) window where the situations
 *  fetch has not resolved — level 1 is the D&D floor, so it never over-offers a
 *  subclass. */
const DEFAULT_STARTING_LEVEL = 1

/** The desktop wiki rail's width — the sanctioned layout escape hatch (a fixed
 *  side-panel basis is not expressible via @mythrun/ui Box props). ~30% at common
 *  desktop widths — the same basis as the play screen's knowledge rail. */
const RAIL_WIDTH_CLASS = 'w-[22rem]'

/** The situations source — defaults to the real endpoint; tests substitute it. */
type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>
/** The concept submit sink — defaults to the real endpoint; tests substitute it. */
type SubmitCharacterFn = (
  ctx: ApiContext,
  campaignId: string,
  body: SubmitCharacterBody,
) => Promise<SubmitCharacterResponse>

/** The chosen situation, or `undefined` when there is no usable pick yet (still
 *  loading, a failed fetch, no `chosenIndex`, or an index that matches no
 *  situation) — the grounding step then shows the generic whisper fallback and
 *  the paths render no recap card. */
function chosenSituation(response: StartingSituationsResponse | null): StartingSituation | undefined {
  if (response === null) return undefined
  if (response.chosenIndex === null) return undefined
  return response.situations[response.chosenIndex]
}

/** Fetch the starting situations once and surface the chosen SITUATION (its
 *  `invitation` is the grounding whisper; its title/location/prose feed the
 *  MYT-102 recap card) AND the party's starting level (the guided path needs the
 *  level to gate its Subclass step). A failed/transient fetch stays `null` (the
 *  grounding step falls back to the generic whisper, the level to its default,
 *  the recap stays absent — never throws into the route); `active` drops a late
 *  resolve after unmount. */
function useStartingContext(
  campaignId: string,
  ctx: ApiContext,
  fetchSituations: FetchSituations,
): { situation: StartingSituation | undefined; startingLevel: number | null } {
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
  return { situation: chosenSituation(response), startingLevel: response?.startingLevel ?? null }
}

/** Selection has no consumer on this route — there is no graph to keep in step
 *  (the reveal's concern); the wiki's own internal navigation is self-contained. */
function noopSelect(): void {
  // Intentionally empty (see above).
}

/** The desktop wiki rail: the ~30% panel (default OPEN) with a collapse toggle,
 *  or the slim collapsed handle — the play screen's knowledge-rail idiom. Sticky
 *  + viewport-capped so the wiki stays consultable (and scrolls INSIDE the rail)
 *  while the player scrolls a long creation column. */
function WikiRail({
  open,
  onToggle,
  t,
  children,
}: {
  open: boolean
  onToggle: () => void
  t: TFunction
  children: ReactNode
}): React.JSX.Element {
  if (!open) {
    return (
      <Box border surface="base" padding={2} data-testid="character-new-wiki-rail">
        <IconButton
          icon="chevron-left"
          label={t('worldReveal.wikiOpen')}
          variant="ghost"
          size="sm"
          onPress={onToggle}
          data-testid="character-new-wiki-toggle"
        />
      </Box>
    )
  }
  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- fixed side-rail width + the sticky viewport-capped flex-scroll column; not expressible via @mythrun/ui Box props (BaseProps bans className)
    <div className={`sticky top-[var(--space-4)] flex max-h-[80dvh] flex-col gap-[var(--space-2)] self-start ${RAIL_WIDTH_CLASS}`} data-testid="character-new-wiki-rail">
      <Box border surface="base" padding={3}>
        <Stack direction="row" justify="between" align="center" gap={2}>
          <Heading level={2}>{t('worldReveal.title')}</Heading>
          <IconButton
            icon="chevron-right"
            label={t('worldReveal.wikiClose')}
            variant="ghost"
            size="sm"
            onPress={onToggle}
            data-testid="character-new-wiki-toggle"
          />
        </Stack>
      </Box>
      {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the rail scroll region; min-h-0 overflow so a long wiki scrolls inside the rail, not the page */}
      <div className="min-h-0 flex-1 overflow-y-auto rounded-none border border-border-strong bg-surface p-[var(--space-3)]">
        {children}
      </div>
    </div>
  )
}

/** The wiki's responsive mount — ONE structural mount chosen by the DS's
 *  `lg`-step JS flip (the play-sidebar idiom): the edge-handle Drawer below
 *  `lg` (mount-persistent children — the wiki survives close→open; portaled, so
 *  it costs the creation column no width), else the collapsible desktop rail. */
function CreationWiki({
  belowLg,
  railOpen,
  onToggleRail,
  drawerOpen,
  onDrawerOpenChange,
  t,
  children,
}: {
  belowLg: boolean
  railOpen: boolean
  onToggleRail: () => void
  drawerOpen: boolean
  onDrawerOpenChange: (open: boolean) => void
  t: TFunction
  children: ReactNode
}): React.JSX.Element {
  if (belowLg) {
    return (
      <Drawer
        data-testid="character-new-wiki-drawer"
        title={t('worldReveal.title')}
        openLabel={t('worldReveal.wikiOpen')}
        closeLabel={t('worldReveal.wikiClose')}
        open={drawerOpen}
        onOpenChange={onDrawerOpenChange}
      >
        {children}
      </Drawer>
    )
  }
  return (
    <WikiRail open={railOpen} onToggle={onToggleRail} t={t}>
      {children}
    </WikiRail>
  )
}

export interface CharacterNewRouteProps {
  /** The situations source — defaults to the real endpoint; tests substitute it. */
  fetchSituations?: FetchSituations
  /** The concept submit sink — defaults to the real endpoint; tests substitute it. */
  submit?: SubmitCharacterFn
  /** The wiki snapshot source (MYT-102) — defaults to the real member-readable
   *  endpoint; tests substitute it. */
  fetchSnapshot?: FetchSnapshot
}

export function CharacterNewRoute({
  fetchSituations = getStartingSituations,
  submit = submitCharacter,
  fetchSnapshot = getWorldSnapshot,
}: CharacterNewRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const [flow, setFlow] = useState<CreateState>(createMachine.initial)
  const dispatch = (event: CreateEvent): void => {
    setFlow((state) => createMachine.transition(state, event))
  }

  const { situation, startingLevel } = useStartingContext(id, ctx, fetchSituations)
  const groundingWhisper = situation?.invitation ?? t('characterCreate.freeform.groundingWhisperFallback')

  // The wiki model lives at the ROUTE, so collapsing the rail unmounts only the
  // panel — reopening re-renders the already-fetched model, never refetches.
  // Token 0: creation mounts a COMPLETE world (no silent tail stages to fold in,
  // the reveal's refresh concern).
  const wiki = useWikiModel(id, fetchSnapshot, 0)
  const [wikiQuery, setWikiQuery] = useState('')
  const [railOpen, setRailOpen] = useState(true) // desktop default OPEN (UX §9)
  const [drawerOpen, setDrawerOpen] = useState(false) // narrow default closed (the prompts own the glass)
  const belowLg = useViewportBelowLg()

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
    // The guided builder — the reducer owns the step sequence + the Subclass skip
    // (gated by `startingLevel`); a completed run submits BOTH fields via `submitBoth`.
    // The chooser routes here via createMachine.transition(_, 'chooseGuided').
    //
    // `key` on the level keeps it authoritative: the reducer seeds its level once at
    // mount, so a level that resolves AFTER a player enters the guided branch (the
    // narrow situations-fetch window) would otherwise stay stale and mis-gate the
    // Subclass step. Re-keying remounts on the (rare) change — only ever before any
    // picks exist, since the level is set server-side before this screen is reached.
    screen = (
      <GuidedPath
        key={startingLevel ?? DEFAULT_STARTING_LEVEL}
        startingLevel={startingLevel ?? DEFAULT_STARTING_LEVEL}
        groundingWhisper={groundingWhisper}
        {...(situation !== undefined ? { situation } : {})}
        submit={submitBoth}
        onSubmitted={() => {
          dispatch('submit')
        }}
        onSkipToFreeform={() => {
          dispatch('skipToFreeform')
        }}
      />
    )
  } else if (flow === 'processing') {
    // The post-submit seam — OWNED BY TRACK B (not MYT-102 Track C). D5 swaps this
    // placeholder for <CharacterLoadingBeat> driven by useCharacterCreationStream.
    // The machine reaches here on a successful submit; left as the committed
    // placeholder so Track B's inline loading-beat mount lands cleanly.
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
        {...(situation !== undefined ? { situation } : {})}
        submit={submitBoth}
        onSubmitted={() => {
          dispatch('submit')
        }}
      />
    )
  }

  // The wiki panel — ONE element shared by both layout regimes so the reader
  // state (query, current page) rides whichever mount the viewport picks.
  const wikiPanel = (
    <WikiPanel
      state={wiki}
      externalSelection={undefined}
      onSelect={noopSelect}
      query={wikiQuery}
      onQuery={setWikiQuery}
    />
  )

  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- create-screen layout row (creation column beside the wiki rail); not expressible via @mythrun/ui Stack props (BaseProps bans className)
    <div className="flex min-w-0 flex-row gap-[var(--space-4)]" data-testid="route-character-new">
      {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the creation column; min-w-0 flex-1 so long prose never spills the row */}
      <div className="min-w-0 flex-1">
        <Stack gap={5}>{screen}</Stack>
      </div>
      <CreationWiki
        belowLg={belowLg}
        railOpen={railOpen}
        onToggleRail={() => {
          setRailOpen((o) => !o)
        }}
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
        t={t}
      >
        {wikiPanel}
      </CreationWiki>
    </div>
  )
}
