import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { Box, Drawer, Heading, IconButton, ResizeHandle, Stack, useViewportBelowLg } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import {
  getCharacterCreationProgress,
  getStartingSituations,
  getWorldSnapshot,
  submitCharacter,
  useApiContext,
  type ApiContext,
  type CharacterCreationProgress,
  type GuidedChoicesPayload,
  type StartingSituation,
  type StartingSituationsResponse,
  type SubmitCharacterBody,
  type SubmitCharacterResponse,
} from '@mythrun/client-core'
import { defaultFetchMe, type FetchMe } from './character-new/viewer-signals.ts'
import {
  createMachine,
  clearCharacterDraft,
  type CreateState,
  type CreateEvent,
  type SessionDraftStore,
} from '@mythrun/client-core/character'
import { createWebLocalDraftStore } from '../platform/web/character-draft-store.ts'
import { usePanelWidth } from '../platform/web/use-panel-width.ts'
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

/** The docked wiki rail's resizable width (px) — clamp floor/ceiling, the default
 *  (≈ the prior 22rem basis), and the persistence key. The reader drags the rail's
 *  ResizeHandle to taste and the chosen width survives navigation (persisted through
 *  the platform width store — R1 keeps web globals out of route code). */
const WIKI_MIN_WIDTH = 288
const WIKI_MAX_WIDTH = 560
const WIKI_DEFAULT_WIDTH = 352
const WIKI_WIDTH_KEY = 'mythrun:character-new:wiki-width'

/** The situations source — defaults to the real endpoint; tests substitute it. */
type FetchSituations = (ctx: ApiContext, campaignId: string) => Promise<StartingSituationsResponse>
/** The concept submit sink — defaults to the real endpoint; tests substitute it. */
type SubmitCharacterFn = (
  ctx: ApiContext,
  campaignId: string,
  body: SubmitCharacterBody,
) => Promise<SubmitCharacterResponse>
/** The progress source — defaults to the real endpoint; tests substitute it. */
type FetchProgress = (ctx: ApiContext, campaignId: string) => Promise<CharacterCreationProgress>

// myth-qkjdq: concept statuses that mean the viewer is ALREADY past "start a
// character" — the create flow must not (re)start them. A refresh / deep-link of
// /character/new consults the roster and hands off to the campaign surface, whose
// routing table owns the waiting beat (`processing`), the reveal (`completed`),
// party staging, the play entry (`integrated`), and the failure surface (`failed`).
// `none`/`submitted` (a fresh or reset concept) stay on the create flow.
const IN_FLIGHT_CONCEPT_STATUSES = new Set(['processing', 'completed', 'integrated', 'failed'])

/** Fetch the viewer's OWN concept status for the deep-link/refresh handoff.
 *  `undefined` while loading, on a calm fetch failure, or when the viewer has no
 *  concept row yet — all of which keep the player on the create flow (the safe
 *  default; the backend 409-guards a re-submit of a locked concept anyway). A
 *  late resolve after unmount is dropped. */
function useViewerConceptStatus(
  campaignId: string,
  ctx: ApiContext,
  fetchMe: FetchMe,
  fetchProgress: FetchProgress,
): string | undefined {
  const [status, setStatus] = useState<string | undefined>(undefined)
  useEffect(() => {
    let active = true
    void Promise.all([fetchMe(ctx), fetchProgress(ctx, campaignId)])
      .then(([me, progress]) => {
        if (!active) return
        setStatus(progress.concepts.find((c) => c.userId === me.user.id)?.status)
      })
      .catch(() => {
        // Calm: stay on the create flow (undefined → no handoff).
      })
    return () => {
      active = false
    }
  }, [campaignId, ctx, fetchMe, fetchProgress])
  return status
}

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
): {
  situation: StartingSituation | undefined
  startingLevel: number | null
  /** True once the fetch RESOLVED with the owner's prerequisites still unset
   *  (no chosen situation or no level) — the deep-link guard (MYT-102 audit):
   *  /character/new reached by URL before the picks routes back to the campaign
   *  surface, whose routing table owns the situation/level/hold screens. Stays
   *  false while loading and on fetch failure (calm degradation keeps winning). */
  prerequisitesMissing: boolean
} {
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
  return {
    situation: chosenSituation(response),
    startingLevel: response?.startingLevel ?? null,
    prerequisitesMissing:
      response !== null && (response.chosenIndex === null || response.startingLevel === null),
  }
}

/** Selection has no consumer on this route — there is no graph to keep in step
 *  (the reveal's concern); the wiki's own internal navigation is self-contained. */
function noopSelect(): void {
  // Intentionally empty (see above).
}

/** The desktop wiki rail — a DOCKED, horizontally-resizable sidebar (not the old
 *  floating pair of boxes). OPEN: one bordered panel with its "Your world" header
 *  ATTACHED to the scrolling body (a single object), a ResizeHandle on its inner
 *  edge for drag-to-resize, sticky + viewport-capped so the wiki scrolls inside the
 *  panel while the player scrolls a long creation column. COLLAPSED: a thin bordered
 *  edge-strip where the panel's edge was — the panel's collapsed self (its trigger
 *  reads as part of the same object), not a disconnected button. */
function WikiRail({
  open,
  onToggle,
  t,
  width,
  onResize,
  children,
}: {
  open: boolean
  onToggle: () => void
  t: TFunction
  width: number
  onResize: (width: number) => void
  children: ReactNode
}): React.JSX.Element {
  if (!open) {
    /* eslint-disable mythrun-ui/no-ad-hoc-ui -- the collapsed rail edge-strip is layout scaffold: a raw full-height button with an up-reading (writing-mode) vertical label, not expressible via Box/IconButton props */
    return (
      <aside className="sticky top-[var(--space-4)] self-start" data-testid="character-new-wiki-rail">
        <button
          type="button"
          onClick={onToggle}
          aria-label={t('worldReveal.wikiOpen')}
          data-testid="character-new-wiki-toggle"
          className="flex h-[80dvh] cursor-pointer select-none flex-col items-center gap-[var(--space-3)] rounded-none border border-border-strong bg-surface px-[var(--space-1)] py-[var(--space-3)] text-ink-tertiary hover:bg-surface-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-fg"
        >
          <span aria-hidden="true" className="font-ui text-sm">‹</span>
          <span aria-hidden="true" className="font-ui text-[0.65rem] uppercase tracking-wide [writing-mode:vertical-rl]">
            {t('worldReveal.title')}
          </span>
        </button>
      </aside>
    )
    /* eslint-enable mythrun-ui/no-ad-hoc-ui -- end of the collapsed rail edge-strip scaffold */
  }
  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the docked rail row (resize handle + fixed-width panel); the sticky definite-height flex layout is not expressible via Box props
    <aside className="sticky top-[var(--space-4)] flex h-[80dvh] self-start" data-testid="character-new-wiki-rail">
      <ResizeHandle
        value={width}
        min={WIKI_MIN_WIDTH}
        max={WIKI_MAX_WIDTH}
        onChange={onResize}
        edge="leading"
        label={t('worldReveal.wikiResize')}
      />
      {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the docked panel at the reader-chosen width (dynamic style): header ATTACHED to the scrolling body as one bordered object. No border-l — the ResizeHandle's rule IS the panel's left edge (one line, not a double-hairline seam; ux-run2 myth-sd5vh) */}
      <div style={{ width: `${String(width)}px` }} className="flex min-h-0 shrink-0 flex-col rounded-none border-y border-r border-border-strong bg-surface">
        {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the panel header row (title + collapse), joined to the body by the shared bottom border */}
        <div className="flex items-center justify-between gap-[var(--space-2)] border-b border-border-strong px-[var(--space-3)] py-[var(--space-2)]">
          <Heading level={2} role="title">{t('worldReveal.title')}</Heading>
          <IconButton
            icon="chevron-right"
            label={t('worldReveal.wikiClose')}
            variant="ghost"
            size="sm"
            onPress={onToggle}
            data-testid="character-new-wiki-toggle"
          />
        </div>
        {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the rail scroll region; min-h-0 overflow so a long wiki scrolls inside the panel, not the page */}
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-[var(--space-3)]">{children}</div>
      </div>
    </aside>
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
  wikiWidth,
  onWikiResize,
  children,
}: {
  belowLg: boolean
  railOpen: boolean
  onToggleRail: () => void
  drawerOpen: boolean
  onDrawerOpenChange: (open: boolean) => void
  t: TFunction
  wikiWidth: number
  onWikiResize: (width: number) => void
  children: ReactNode
}): React.JSX.Element {
  if (belowLg) {
    // Narrow: the edge-handle Drawer (full-width sheet) — resize doesn't apply.
    return (
      <Drawer
        data-testid="character-new-wiki-drawer"
        title={t('worldReveal.title')}
        openLabel={t('worldReveal.wikiOpen')}
        closeLabel={t('worldReveal.wikiClose')}
        open={drawerOpen}
        onOpenChange={onDrawerOpenChange}
      >
        {/* The wiki FILLS the sheet and scrolls internally (myth-1k9qt) — while
            the sheet body was the scroller, the wiki's own container never
            moved and its per-page scroll memory captured 0 every time. */}
        <Box grow>{children}</Box>
      </Drawer>
    )
  }

  return (
    <WikiRail open={railOpen} onToggle={onToggleRail} t={t} width={wikiWidth} onResize={onWikiResize}>
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
  /** The viewer-identity source (myth-qkjdq roster handoff) — defaults to the real
   *  endpoint; tests substitute it. */
  fetchMe?: FetchMe
  /** The progress source (myth-qkjdq roster handoff) — defaults to the real
   *  endpoint; tests substitute it. */
  fetchProgress?: FetchProgress
  /** The player-input draft store — defaults to the real localStorage-backed web
   *  store; tests substitute an in-memory fake to assert persistence/restore. */
  draftStore?: SessionDraftStore
}

export function CharacterNewRoute({
  fetchSituations = getStartingSituations,
  submit = submitCharacter,
  fetchSnapshot = getWorldSnapshot,
  fetchMe = defaultFetchMe,
  fetchProgress = getCharacterCreationProgress,
  draftStore,
}: CharacterNewRouteProps = {}): React.JSX.Element {
  const { t } = useTranslation()
  const ctx = useApiContext()
  const navigate = useNavigate()
  // The route only matches with an `:id`; `?? ''` keeps the hook calls unconditional.
  const { id = '' } = useParams<{ id: string }>()
  const [flow, setFlow] = useState<CreateState>(createMachine.initial)
  const dispatch = (event: CreateEvent): void => {
    setFlow((state) => createMachine.transition(state, event))
  }
  // The guided path reports its current selection's canonical name (myth-ehcf4);
  // the wiki panel uses it as the match needle for its step-aware context strip.
  const [stepContext, setStepContext] = useState<string | undefined>(undefined)

  const { situation, startingLevel, prerequisitesMissing } = useStartingContext(id, ctx, fetchSituations)
  // myth-qkjdq: consult the roster on entry. A refresh / deep-link that lands here
  // while the viewer already has an in-flight or finished concept hands off to the
  // campaign surface's routing table instead of showing the start of creation.
  const viewerConceptStatus = useViewerConceptStatus(id, ctx, fetchMe, fetchProgress)

  // Player-input durability: persist the player's OWN written concept/grounding as
  // they type, keyed by campaign, so a failed generation ("the character didn't
  // take shape") followed by "Start over" — or any other return to the flow —
  // RESTORES their words instead of an empty box. The server also retains the last
  // SUBMITTED concept on the failed row, but the localStorage draft is stronger: it
  // captures words typed before any submit and survives a reload / tab close.
  // Created once per mount (useMemo) so the store identity is stable.
  const draftStoreImpl = useMemo(() => draftStore ?? createWebLocalDraftStore(), [draftStore])
  // Clear the draft ONLY once the character is confirmed created (concept
  // 'integrated'). A failure or a "Start over" deliberately leaves it — those are
  // exactly the returns where the words must survive. This is best-effort hygiene:
  // an uncleared draft is invisible post-success (the create flow never re-mounts
  // for a non-'submitted' concept), so leaving it costs nothing. The path components
  // (FreeformPath / GuidedPath) own the read + persist; the route owns only the store
  // lifetime + this confirmed-creation clear.
  useEffect(() => {
    if (viewerConceptStatus === 'integrated') clearCharacterDraft(draftStoreImpl, id)
  }, [viewerConceptStatus, draftStoreImpl, id])

  const groundingWhisper = situation?.invitation ?? t('characterCreate.freeform.groundingWhisperFallback')

  // The wiki model lives at the ROUTE, so collapsing the rail unmounts only the
  // panel — reopening re-renders the already-fetched model, never refetches.
  // Token 0: creation mounts a COMPLETE world (no silent tail stages to fold in,
  // the reveal's refresh concern).
  const wiki = useWikiModel(id, fetchSnapshot, 0)
  const [wikiQuery, setWikiQuery] = useState('')
  const [railOpen, setRailOpen] = useState(true) // desktop default OPEN (UX §9)
  const [drawerOpen, setDrawerOpen] = useState(false) // narrow default closed (the prompts own the glass)
  // The docked rail's persisted + clamped + resizable width (the ResizeHandle drives it).
  const { width: wikiWidth, onResize: handleWikiResize } = usePanelWidth(WIKI_WIDTH_KEY, WIKI_MIN_WIDTH, WIKI_MAX_WIDTH, WIKI_DEFAULT_WIDTH)
  const belowLg = useViewportBelowLg()

  // Deep-link guard (MYT-102): /character/new reached before the owner picked a
  // situation + level routes back to the campaign surface — its routing table
  // owns the situation/level/hold screens; the backend 409-gates submits anyway,
  // this just keeps the player off a screen that cannot succeed.
  if (prerequisitesMissing) {
    return <Navigate to={`/campaigns/${id}`} replace />
  }

  // Roster handoff (myth-qkjdq): the viewer already has an in-flight or finished
  // concept — a refresh mid-processing lands on the campaign surface's waiting
  // beat, post-completion on the reveal — rather than the start of creation.
  if (viewerConceptStatus !== undefined && IN_FLIGHT_CONCEPT_STATUSES.has(viewerConceptStatus)) {
    return (
      <Navigate to={`/campaigns/${id}`} replace data-testid="character-new-roster-handoff" />
    )
  }

  // The guided path hands over its STRUCTURED picks alongside the flattened
  // conceptText (myth-4jhrk: the backend persists the picks and pins the
  // subclass end-to-end — prose alone loses it); the freeform path omits the
  // field. Conditional spread keeps an absent payload absent, not undefined.
  const submitBoth = (
    conceptText: string,
    situationGroundingText: string,
    guidedChoices?: GuidedChoicesPayload,
  ): Promise<void> =>
    submit(ctx, id, {
      conceptText,
      situationGroundingText,
      ...(guidedChoices !== undefined && { guidedChoices }),
    }).then(() => undefined)

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
        onBack={() => {
          void navigate(`/campaigns/${id}`)
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
        onBack={() => {
          dispatch('back')
        }}
        onStepContext={setStepContext}
        store={draftStoreImpl}
        campaignId={id}
      />
    )
  } else if (flow === 'processing') {
    // The post-submit HANDOFF (MYT-102): a successful submit routes straight to
    // the campaign surface, whose routing table resolves conceptStatus
    // 'processing' to the REAL loading beat (countdown, seeded stages, stall
    // notice) — the durable, refresh-safe state machine. Nobody waits on a dead
    // placeholder here again.
    screen = <Navigate to={`/campaigns/${id}`} replace data-testid="character-processing-handoff" />
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
        onBack={() => {
          dispatch('back')
        }}
        store={draftStoreImpl}
        campaignId={id}
      />
    )
  }

  // The wiki panel — ONE element shared by both layout regimes so the reader
  // state (query, current page) rides whichever mount the viewport picks. The
  // guided path's selection needle makes it step-aware (myth-ehcf4).
  const wikiPanel = (
    <WikiPanel
      state={wiki}
      externalSelection={undefined}
      onSelect={noopSelect}
      query={wikiQuery}
      onQuery={setWikiQuery}
      {...(stepContext !== undefined ? { stepContext } : {})}
    />
  )

  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- create-screen layout row (creation column DOCKED against the wiki rail; the rail's ResizeHandle is the divider, so no row gap); not expressible via @mythrun/ui Stack props (BaseProps bans className)
    <div className="flex min-w-0 flex-row" data-testid="route-character-new">
      {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- the creation column; min-w-0 flex-1 so long prose never spills the row, with trailing space so the docked rail's handle doesn't crowd the prose */}
      <div className="min-w-0 flex-1 pr-[var(--space-4)]">
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
        wikiWidth={wikiWidth}
        onWikiResize={handleWikiResize}
      >
        {wikiPanel}
      </CreationWiki>
    </div>
  )
}
