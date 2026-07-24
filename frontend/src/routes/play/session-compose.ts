import type { ConnectionStatus } from '@mythrun/client-core'
import type { TranscriptItem } from '@mythrun/client-core/contract'

// Pure route-wire helpers for the live-play shell (MYT-92 T16). The three
// load-bearing transforms the shell performs — composing the explicit-text @DM
// token, mapping the transport connection status to a quiet system line, and
// resolving typing userIds to display names — live here so they unit-test
// directly, without a React render. No cognition (ZFC): deterministic string /
// map plumbing over transport-delivered data only.

/** The explicit-text @DM summon token (spec §2). The route composes it into the
 *  VISIBLE message text so the summon persists + broadcasts as an ordinary
 *  `player_message` (the backend's explicit-trigger path — the table SEES the
 *  summon; the invisible `dm_invoke` frame is NOT used). A protocol token, not
 *  user copy, so it is not an i18n key. */
export const DM_TOKEN = '@dm'

/** Client mirror of the server's MAX_MESSAGE_TEXT_LEN (backend
 *  routes/ws-session.ts). The composer hard-caps at this so an over-long
 *  message can't be optimistically rendered then silently dropped by the server
 *  — and can't exceed the WS payload cap and trigger a reconnect storm (MYT-102
 *  QA F1). A backend bump must mirror here (there's no shared runtime constant
 *  across the API/client boundary; pinned by intent, not import). */
export const MAX_PLAYER_MESSAGE_LEN = 4_000

/** Compose the @DM summon message: the token, then the player's typed text (if
 *  any). An empty field summons with the bare token. */
export function composeSummon(value: string): string {
  const trimmed = value.trim()
  return trimmed.length > 0 ? `${DM_TOKEN} ${trimmed}` : DM_TOKEN
}

/** The connection statuses that surface a quiet system line pinned under the
 *  transcript (`reconnecting` / `failed`). Every settled status (`connecting` /
 *  `connected` / `closed`) renders no line. The shell maps the token to a resolved
 *  i18n string; a null means MessageStream's `connectionLine` prop is null. */
export function connectionLineStatus(status: ConnectionStatus): 'reconnecting' | 'failed' | null {
  if (status === 'reconnecting') return 'reconnecting'
  if (status === 'failed') return 'failed'
  return null
}

/** Resolve the presence typing userIds to display names via the campaign roster
 *  (SessionView carries userIds only). An id with no roster entry is OMITTED (a
 *  bare typing line) rather than rendering a raw id. */
export function resolveTypingNames(
  userIds: readonly string[],
  party: ReadonlyMap<string, string>,
): string[] {
  return userIds
    .map((id) => party.get(id))
    .filter((name): name is string => name !== undefined)
}

/** True while a DM turn is in flight (myth-dd63v). `thinking` covers the
 *  dm_thinking → first-delta window; a streaming `dm` item covers first-delta →
 *  turn_end. Together they span the whole turn — the window during which SENDING
 *  is not the expected next action, so the composer gates Send (never silently
 *  swallows it). ZFC: a boolean over transport-delivered state, no cognition. */
export function isDmWriting(items: readonly TranscriptItem[], thinking: boolean): boolean {
  if (thinking) return true
  return items.some((it) => it.kind === 'dm' && it.streaming)
}

/** The turnId of the most-recent LIVE long rest in the transcript, or null. The
 *  play surface hangs its wind-down offer off it (myth-lhp99). Keys off the
 *  STRUCTURED `restType` field on the `ledger_update` frame — never the
 *  human-readable summary prose. LIVE only (`seq === undefined`): a replayed rest
 *  from an earlier reconnect must not re-pop the offer. The per-participant rest
 *  burst shares one turnId, so this collapses to a single offer for the night. */
export function latestLiveLongRestTurn(items: readonly TranscriptItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]
    if (it?.kind === 'ledger_update' && it.frame.restType === 'long' && it.frame.seq === undefined) {
      return it.turnId
    }
  }
  return null
}
