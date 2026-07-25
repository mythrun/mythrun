// transcript-presentation (ux-run3) — pure DISPLAY derivations over the settled
// transcript, computed route-side and passed to MessageStream as plain data (R1:
// @mythrun/ui holds no client-core runtime). Two concerns live here:
//
//   • orderForDisplay (myth-twraw): the FT may stream prose BEFORE its roll tool
//     call, so a check card can arrive AFTER the prose it caused — read back
//     later, the roll happens after its consequences. Once a card is RELEASED
//     (its theater done, its gate lifted), it settles into its CAUSAL slot:
//     immediately before its own turn's first prose segment. Un-released cards
//     keep arrival order — the live gesture (card as the tail centerpiece while
//     the prose is gated invisible) is untouched.
//
//   • buildTableTalkView (myth-1msig): an Ask-the-DM exchange is out-of-character
//     table talk, and the durable transcript must keep that boundary — the @dm
//     question and its answering DM turn group into one marked block the stream
//     wraps in the table-note register. Keyed off the EXPLICIT `@dm` token (a UI
//     command — the sanctioned ZFC exception; nothing semantic is inspected).
//
// Both are deterministic list transforms over transport-delivered data — no
// cognition, no heuristics beyond the explicit token gate.

import type { TranscriptItem } from './transcript-types.ts'
import type { RollRevealView } from './roll-reveal.ts'

/** The explicit-text @DM summon token (spec §2). The route composes it into the
 *  VISIBLE message text so the summon persists + broadcasts as an ordinary
 *  `player_message` (the backend's explicit-trigger path — the table SEES the
 *  summon). A protocol token, not user copy, so it is not an i18n key. Moved
 *  here from the web route wire (session-compose re-exports it) so the
 *  table-talk grouping and the composer share ONE definition. */
export const DM_TOKEN = '@dm'

/** True when a player message is the explicit @DM summon gesture. Mirrors the
 *  backend's summon classifier (backend routes/ws-trigger-actions.ts): trimmed
 *  text beginning with the literal token, case-insensitive. Pinned by intent —
 *  a divergence would frame non-summon messages (or miss real ones). */
export function isDmSummon(text: string): boolean {
  return text.trimStart().toLowerCase().startsWith(DM_TOKEN)
}

/** The two in-stream card kinds (skill_check / dice_roll). */
function isCard(item: TranscriptItem): boolean {
  return item.kind === 'skill_check' || item.kind === 'dice_roll'
}

/**
 * Display order for the transcript (myth-twraw): every RELEASED card files into
 * its causal slot — before its own turn's first `dm` segment — wherever arrival
 * order put it after the prose. Multiple released cards of one turn keep their
 * relative order. Returns the input array itself when nothing moves (memo- and
 * render-friendly identity).
 */
export function orderForDisplay(
  items: readonly TranscriptItem[],
  reveal: RollRevealView,
): readonly TranscriptItem[] {
  let moved = false
  const out = [...items]
  for (const item of items) {
    if (!isCard(item) || reveal.phaseByKey[item.key] !== 'released') continue
    const cardIdx = out.indexOf(item)
    const firstProseIdx = out.findIndex((it) => it.kind === 'dm' && it.turnId === item.turnId)
    if (firstProseIdx === -1 || firstProseIdx > cardIdx) continue
    out.splice(cardIdx, 1)
    out.splice(firstProseIdx, 0, item)
    moved = true
  }
  return moved ? out : items
}

/** The table-talk grouping MessageStream wraps in the marked OOC block: item key
 *  → block ordinal. Items absent from the map render unframed. */
export interface TableTalkView {
  readonly blockByKey: Readonly<Record<string, number>>
}

/**
 * Group each @dm question with its answering DM turn (myth-1msig). The question
 * opens a pending exchange; the NEXT `dm` segment claims it and pins the
 * answering turnId; further segments of that turn join the same block. Any other
 * item — an in-fiction player message, a mechanical frame, another turn's prose —
 * closes the exchange (the question still frames alone; a mid-answer roll never
 * gets swallowed into the block). Deterministic, replay-stable: the same items
 * always group the same way, so the durable record keeps its frames on reread.
 */
export function buildTableTalkView(items: readonly TranscriptItem[]): TableTalkView {
  const blockByKey: Record<string, number> = {}
  let nextBlock = 0
  let pending: { block: number; turnId: string | null } | null = null
  for (const item of items) {
    if (item.kind === 'player') {
      pending = null
      if (isDmSummon(item.text)) {
        blockByKey[item.key] = nextBlock
        pending = { block: nextBlock, turnId: null }
        nextBlock += 1
      }
    } else if (
      item.kind === 'dm' &&
      pending !== null &&
      (pending.turnId === null || pending.turnId === item.turnId)
    ) {
      pending.turnId = item.turnId
      blockByKey[item.key] = pending.block
    } else {
      pending = null
    }
  }
  return { blockByKey }
}
