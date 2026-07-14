import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useSession,
  useRollReveal,
  buildRevealView,
  type ApiContext,
  type SessionParams,
  type SessionView,
} from '@mythrun/client-core'
import type { RollCardLabels } from '@mythrun/client-core/contract'
import { MessageStream, ThinkingIndicator, SessionInput, Show } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { SidebarPlaceholder } from './sidebar-placeholder.tsx'
import { SessionCompleteNotice } from './notices.tsx'
import { composeSummon, connectionLineStatus, resolveTypingNames } from './session-compose.ts'

// The live session shell (MYT-92 T16) — the `ready` phase: the streamed multiplayer
// transcript over the WS transport view-model (`useSession`). It composes the six
// @mythrun/ui play components into the play stage and owns the route-side wiring the
// view-model deliberately leaves to the composer:
//   • the SEND handlers — `onSend` sends + clears; `onSummonDm` composes the visible
//     `@dm` token into the text (the explicit-text path) then sends + clears.
//   • the CONNECTION line — `reconnecting`/`failed` → a quiet `[ph:]` system line
//     pinned under the transcript; else null.
//   • the TYPING names — SessionView presence carries userIds only; resolve them to
//     display names via the campaign roster (unknown ids omitted).
//   • the SESSION END → recap landing — a `session_end` shows the brief "complete"
//     transition and navigates to the recap route (the recap READ is a filed bead).
//
// Layout: a full-height flex row — the transcript column (flex-1, min-w-0) beside the
// desktop-only collapsible sidebar seam. The transcript scrolls INSIDE its column
// (MessageStream is `h-full`), so the min-h-0 flex-scroll chain (the AppFrame
// full-bleed root → here) is unbroken. `min-h-0`/`flex` layout roots are the
// sanctioned raw-element escape hatch (mirroring app-frame.tsx): not expressible via
// @mythrun/ui Stack props (BaseProps bans className), scoped to the layout scaffold —
// every piece of visible content composes the DS.

/** The `useSession` seam — injected for tests; defaults to the real hook. */
type UseLiveSession = (ctx: ApiContext, params: SessionParams) => SessionView

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
        />
      </div>
      {/* The sidebar seam — desktop only (MYT-92 wires no mobile drawer; the seam
          renders nothing on mobile). Collapsed by default; MYT-94 fills it. */}
      <Show above="lg">
        <SidebarPlaceholder />
      </Show>
    </div>
  )
}

/** Resolve the dice-moment [ph:] label bundle threaded to each RollCard (MYT-93).
 *  Extracted so the shell body stays a thin composition; the outcome-tier map uses the
 *  frame's snake_case tiers (`great_success`) keyed off the camelCase i18n leaf. The
 *  copy behind these keys is MYT-100's one pass — the values are `[ph:]` for now. */
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
