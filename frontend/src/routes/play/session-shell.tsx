import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  useSession,
  type ApiContext,
  type SessionParams,
  type SessionView,
} from '@mythrun/client-core'
import { MessageStream, ThinkingIndicator, SessionInput, Show } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
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
          <MessageStream items={items} connectionLine={connectionLine} reducedMotion={reducedMotion} />
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
