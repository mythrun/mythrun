import { useEffect, useRef } from 'react'
import { CharacterLoadingBeat, Heading, Stack } from '@mythrun/ui'
import { useTranslation } from 'react-i18next'
import {
  useCharacterCreationStream,
  type CharacterCreationStreamDeps,
} from '@mythrun/client-core/character'
import { usePrefersReducedMotion } from '../../platform/web/use-prefers-reduced-motion.ts'

// The CHARACTER-LOADING SURFACE (MYT-90 D5) — the "coming into being" screen the
// D8 routing table mounts while the viewer's character concept is `processing`.
// It is a thin composition: the DS <CharacterLoadingBeat> (the 1-bit figure
// filling in beside the surfacing beat rows) driven by the client-core
// useCharacterCreationStream (the per-user SSE fold → `{ beats, done }`), under a
// screen headline that matches the other create beats (the chooser's `role="title"`).
//
// The one behaviour it owns is the SWAP: the instant the viewer's own
// `character_creation_complete` arrives (`done` flips true) it calls `onDone`
// EXACTLY ONCE — D8 re-evaluates routing and lands the player on the reveal. A
// latch ref keeps it one-shot even if the surface re-renders while `done` holds.
//
// SCOPE: the hook is LIVE-only (a mid-creation refresh restarts the beats until
// the next event, and a refresh AFTER completion won't re-flip `done`). The
// durable "already completed" case is D8's job — its concept-status routing sends
// a returning player straight to the reveal without ever mounting this surface —
// so here we only need the live `done → onDone` swap.

export interface CharacterLoadingSurfaceProps {
  /** The campaign whose status stream carries the per-player creation events. */
  campaignId: string
  /** The viewer whose stage progress this surface folds + waits on. */
  userId: string
  /** Called once when the viewer's creation completes — D8 re-routes to the reveal. */
  onDone: () => void
  /** Injected stream transport — defaults to the real SSE client; tests + stories
   *  substitute a hand-driven one (forwarded to useCharacterCreationStream). */
  deps?: CharacterCreationStreamDeps
}

export function CharacterLoadingSurface({
  campaignId,
  userId,
  onDone,
  deps,
}: CharacterLoadingSurfaceProps): React.JSX.Element {
  const { t } = useTranslation()
  const { beats, done } = useCharacterCreationStream(campaignId, userId, deps)
  const reducedMotion = usePrefersReducedMotion()

  // Fire the swap exactly once: `done` latches true in the hook and never goes
  // back, so a ref guard collapses any repeat renders-while-done to a single call.
  const swappedRef = useRef(false)
  useEffect(() => {
    if (done && !swappedRef.current) {
      swappedRef.current = true
      onDone()
    }
  }, [done, onDone])

  return (
    <Stack gap={5} data-testid="character-loading">
      <Heading level={1} role="title">
        {t('characterCreate.loading.title')}
      </Heading>
      <CharacterLoadingBeat beats={beats} reducedMotion={reducedMotion} />
    </Stack>
  )
}
