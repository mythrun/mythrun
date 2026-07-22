import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useSession,
  useRollReveal,
  buildRevealView,
  useKnowledgeCache,
  useSessionSheet,
  type ApiContext,
  type KnowledgeCache,
  type KnowledgeCacheDeps,
  type LedgerUpdateFrame,
  type SessionParams,
  type SessionSheetState,
  type SessionView,
} from '@mythrun/client-core'
import { snapshotToGraph } from '@mythrun/client-core/worldgen'
import type { RollCardLabels } from '@mythrun/client-core/contract'
import { MessageStream, ThinkingIndicator, SessionInput } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { SessionCompleteNotice, NoCharacterNotice } from './notices.tsx'
import {
  KnowledgePanel,
  buildHighlightLabels,
  usePlayKnowledge,
  type PlayKnowledgeHooks,
} from './knowledge-panel.tsx'
import { MAX_PLAYER_MESSAGE_LEN, composeSummon, connectionLineStatus, resolveTypingNames } from './session-compose.ts'

// The live session shell (MYT-92 T16) — the `ready` phase: the streamed multiplayer
// transcript over the WS transport view-model (`useSession`). It composes the six
// @mythrun/ui play components into the play stage and owns the route-side wiring the
// view-model deliberately leaves to the composer:
//   • the SEND handlers — `onSend` sends + clears; `onSummonDm` composes the visible
//     `@dm` token into the text (the explicit-text path) then sends + clears.
//   • the CONNECTION line — `reconnecting`/`failed` → a quiet i18n system line
//     pinned under the transcript; else null.
//   • the TYPING names — SessionView presence carries userIds only; resolve them to
//     display names via the campaign roster (unknown ids omitted).
//   • the SESSION END → recap landing — a `session_end` shows the brief "complete"
//     transition and navigates to the recap route (the recap READ is a filed bead).
//
// Layout: a full-height flex row — the transcript column (flex-1, min-w-0) beside the
// MYT-94 knowledge sidebar (`KnowledgePanel`: a collapsible ~30% desktop rail, the
// shipped Drawer on narrow viewports — it owns its own responsive flip). The
// transcript scrolls INSIDE its column (MessageStream is `h-full`), so the min-h-0
// flex-scroll chain (the AppFrame full-bleed root → here) is unbroken. `min-h-0`/
// `flex` layout roots are the sanctioned raw-element escape hatch (mirroring
// app-frame.tsx): not expressible via @mythrun/ui Stack props (BaseProps bans
// className), scoped to the layout scaffold — every piece of visible content composes
// the DS.
//
// MYT-94 also threads the settled-prose entity HIGHLIGHTING into MessageStream: the
// knowledge cache's matcher index + the chat→wiki `onEntityOpen` bridge + the
// resolved popover chrome, passed ONLY once the cache index has settled (a null
// index means plain DM prose — enforced ignorance holds either way).

/** The `useSession` seam — injected for tests; defaults to the real hook. */
type UseLiveSession = (ctx: ApiContext, params: SessionParams) => SessionView

// The real client-core knowledge hooks, bound to their production deps — the default
// `PlayKnowledgeHooks` the shell passes when tests inject none (the same real-hook
// default seam `useLiveSession = useSession` rides). The cache's graph projection is
// the canonical `snapshotToGraph` (a stable module ref); the sheet uses the real
// endpoints + the canonical curated adapter.
const CACHE_DEPS: KnowledgeCacheDeps = { snapshotToGraph }
function useDefaultCache(campaignId: string, refreshToken: number): KnowledgeCache {
  return useKnowledgeCache(campaignId, refreshToken, CACHE_DEPS)
}
function useDefaultSheet(
  campaignId: string,
  viewerUserId: string,
  viewerCharacterName: string,
  ledgerFrames: readonly LedgerUpdateFrame[],
): SessionSheetState {
  return useSessionSheet(campaignId, viewerUserId, viewerCharacterName, ledgerFrames)
}
const DEFAULT_KNOWLEDGE_HOOKS: PlayKnowledgeHooks = { useCache: useDefaultCache, useSheet: useDefaultSheet }

export interface SessionShellProps {
  readonly ctx: ApiContext
  readonly campaignId: string
  readonly sessionId: string
  readonly viewerUserId: string
  readonly displayName: string
  readonly characterName: string
  /** userId → displayName, for resolving presence typing names. */
  readonly party: ReadonlyMap<string, string>
  readonly reducedMotion: boolean
  /** Injected session hook (tests); defaults to `useSession`. */
  readonly useLiveSession?: UseLiveSession
  /** Injected knowledge data hooks (tests); defaults to the real client-core hooks. */
  readonly knowledgeHooks?: PlayKnowledgeHooks
}

export function SessionShell({
  ctx,
  campaignId,
  sessionId,
  viewerUserId,
  displayName,
  characterName,
  party,
  reducedMotion,
  useLiveSession = useSession,
  knowledgeHooks = DEFAULT_KNOWLEDGE_HOOKS,
}: SessionShellProps): React.JSX.Element {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const session = useLiveSession(ctx, { sessionId, viewerUserId, displayName, characterName })
  const [draft, setDraft] = useState('')

  // The view-model exposes send/summon as METHODS (not arrow props), so call them on
  // `session` rather than destructuring a bare unbound reference (@typescript-eslint/
  // unbound-method). The data fields are plain values — safe to destructure.
  const { items, connection, thinking, typingUserIds, ended } = session

  // The dice-moment reveal (MYT-93, spec §5). PRESENTATION ONLY — the roll arrived
  // whole in the skill_check/dice_roll frame; this layer just delays the DISPLAY and
  // gates the post-check prose behind Continue. `buildRevealView` DERIVES the per-card
  // phase + the set of prose-gated turnIds from `items` + the reducer state; both are
  // threaded to MessageStream as plain data (R1 — @mythrun/ui holds no reveal runtime).
  // A pending (un-continued) card does NOT disable SessionInput — the player may keep
  // typing (the spec is silent; keep the calm default).
  const reveal = useRollReveal()
  const rollReveal = useMemo(() => buildRevealView(items, reveal.state), [items, reveal.state])
  const rollLabels = useMemo(() => buildRollLabels(t), [t])

  // The MYT-94 knowledge layer — the one-snapshot cache + the in-session sheet + the
  // shared sidebar state, threaded into BOTH the chat (settled-prose highlighting)
  // and the sidebar. `connection.status` drives the boundary refetch; the transcript
  // supplies the ledger frames the sheet overlay folds.
  const knowledge = usePlayKnowledge({
    campaignId,
    viewerUserId,
    viewerCharacterName: characterName,
    items,
    connectionStatus: connection.status,
    hooks: knowledgeHooks,
  })
  const highlightLabels = useMemo(() => buildHighlightLabels(t), [t])

  // Session end → the recap route (the recap read is a filed bead; 92 only lands).
  useEffect(() => {
    if (ended) void navigate(`/campaigns/${campaignId}/recap`)
  }, [ended, navigate, campaignId])

  const onSend = (): void => {
    session.sendMessage(draft)
    setDraft('')
  }
  const onSummonDm = (): void => {
    session.summonDm(composeSummon(draft))
    setDraft('')
  }
  // `reveal.roll` / `reveal.advance` are typed as METHODS on the RollReveal view, so
  // thread them through local arrows rather than bare references (@typescript-eslint/
  // unbound-method — the same rail the send/summon handlers above satisfy).
  const onRoll = (key: string): void => {
    reveal.roll(key)
  }
  const onContinue = (key: string): void => {
    reveal.advance(key)
  }

  const lineToken = connectionLineStatus(connection.status)
  const connectionLine = lineToken === null ? null : t(`play.connection.${lineToken}`)
  const typingNames = useMemo(
    () => resolveTypingNames(typingUserIds, party),
    [typingUserIds, party],
  )

  if (ended) return <SessionCompleteNotice />

  // myth-mnik3: the transport terminally failed because the viewer has no
  // integrated character (server close 4404 'no_character'). Reconnecting can't
  // help — surface an explicit "make a character" state with a route into
  // creation, instead of a live shell whose input is disabled behind a quiet
  // reconnect line. A terminal `failed{denied}`/`{exhausted}` still falls through
  // to the shell (the connection line + disabled input already cover those).
  if (connection.status === 'failed' && connection.failedReason === 'no_character') {
    return (
      <NoCharacterNotice
        onCreate={() => {
          void navigate(`/campaigns/${campaignId}/character/new`)
        }}
      />
    )
  }

  return (
    // eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- play-stage layout row; the min-h-0 flex-scroll root is not expressible via @mythrun/ui Stack props (BaseProps bans className)
    <div className="flex min-h-0 flex-1 flex-row gap-[var(--space-4)]" data-testid="session-shell">
      {/* The transcript column — flex-1, min-w-0 so long prose never spills the row. */}
      {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- transcript column min-h-0/min-w-0 flex-scroll root; not expressible via @mythrun/ui Stack props */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-[var(--space-2)] p-[var(--space-4)]">
        {/* The scroll slot — MessageStream is `h-full`, so it fills this flex-1
            min-h-0 region and scrolls internally (the page never scrolls). */}
        {/* eslint-disable-next-line mythrun-ui/no-ad-hoc-ui -- transcript scroll slot; MessageStream (h-full) fills this flex-1 min-h-0 region */}
        <div className="flex min-h-0 flex-1 flex-col">
          <MessageStream
            items={items}
            connectionLine={connectionLine}
            reducedMotion={reducedMotion}
            rollReveal={rollReveal}
            rollLabels={rollLabels}
            onRoll={onRoll}
            onContinue={onContinue}
            // The errata eyebrow for a `dm_correction` row (myth-d6knq) — resolved
            // route-side; the DS slip is i18n-agnostic. `text` is DM DATA.
            correctionLabel={t('play.correction.label')}
            // Settled-prose entity highlighting (MYT-94) — passed ONLY once the
            // cache index has settled; a null index leaves DM prose plain.
            {...(knowledge.highlight !== undefined
              ? { highlight: knowledge.highlight, onEntityOpen: knowledge.onEntityOpen, highlightLabels }
              : {})}
          />
        </div>
        <ThinkingIndicator
          thinking={thinking}
          typingNames={typingNames}
          thinkingLabel={t('play.thinking.dm')}
          typingLabel={t('play.thinking.typing')}
        />
        <SessionInput
          value={draft}
          onChange={setDraft}
          onSend={onSend}
          onSummonDm={onSummonDm}
          // The composer is gated only when the transport has terminally failed —
          // sends during a transient `reconnecting` stay pending + resend (the
          // view-model owns that). `ended` short-circuits to the complete notice above.
          disabled={connection.status === 'failed'}
          placeholder={t('play.input.placeholder')}
          summonLabel={t('play.input.summon')}
          sendLabel={t('play.input.send')}
          maxLength={MAX_PLAYER_MESSAGE_LEN}
        />
      </div>
      {/* The knowledge sidebar (MYT-94) — fills MYT-92's placeholder seam: the
          three knowledge tabs (world wiki / relationship graph / character sheet),
          default-OPEN on desktop (~30% rail), the shipped Drawer on narrow
          viewports. KnowledgePanel owns the responsive rail↔drawer flip. */}
      <KnowledgePanel knowledge={knowledge} reducedMotion={reducedMotion} />
    </div>
  )
}

/** Resolve the dice-moment label bundle threaded to each RollCard (MYT-93).
 *  Extracted so the shell body stays a thin composition; the outcome-tier map uses the
 *  frame's snake_case tiers (`great_success`) keyed off the camelCase i18n leaf. */
function buildRollLabels(t: TFunction): RollCardLabels {
  return {
    roll: t('play.roll.roll'),
    continue: t('play.roll.continue'),
    tier: {
      fail: t('play.roll.tier.fail'),
      success: t('play.roll.tier.success'),
      great_success: t('play.roll.tier.greatSuccess'),
    },
    dc: t('play.roll.dc'),
    advantage: t('play.roll.advantage'),
    disadvantage: t('play.roll.disadvantage'),
    dieResult: t('play.roll.dieResult'),
  }
}
