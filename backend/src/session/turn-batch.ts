// backend/src/session/turn-batch.ts — MYT-67 T5 (spec §4.3 / §4.6).
//
// The turn-batch builder. Reads the transcript slice `(lastRespondedSeq, max]`
// and projects the player messages in it into the `TriggerMessage[]` the DM
// trigger classifier and the tiers consume. The DM trigger worker calls this
// once it acquires the per-session lock, before classifying.
//
// Two structural rules from the spec:
//   - Only `player_message` rows enter the batch — DM/system messages are not
//     "what the players just said," so they are filtered out (they also lack a
//     `userId` to attribute).
//   - The batch is capped to the LAST `MAX_BATCH` player messages: a long
//     quiet-window extension can accumulate more chat than the classifier
//     prompt should carry, and the most recent messages are the relevant ones.
//
// `maxSeq` is the highest PLAYER-message seq in the slice (NOT the highest row
// seq — a trailing DM/system row must not advance the responded-watermark), or
// `lastRespondedSeq` unchanged when the slice holds no player messages. The
// worker persists this as the new `lastRespondedSeq` after it responds.

import type { Repo } from '../repo/index.js'
import type { SessionMessage } from '../repo/types.js'
import type { TriggerMessage } from './tiers/types.js'
import { MAX_BATCH } from './dm-trigger-config.js'

const PLAYER_MESSAGE_TYPE = 'player_message'

/** A `player_message` row is guaranteed to carry a `userId` (the author). */
type PlayerMessage = SessionMessage & { userId: string }

function isPlayerMessage(row: SessionMessage): row is PlayerMessage {
  return row.messageType === PLAYER_MESSAGE_TYPE && row.userId !== null
}

export async function buildTurnBatch(
  repo: Repo,
  campaignId: string,
  sessionId: string,
  lastRespondedSeq: number,
): Promise<{ batch: TriggerMessage[]; maxSeq: number }> {
  const rows = await repo.sessionMessages.listAfterSeq(sessionId, lastRespondedSeq)
  const players = rows.filter(isPlayerMessage)

  const members = await repo.campaigns.listMembersBasic(campaignId)
  const displayNames = new Map(members.map((m) => [m.user_id, m.display_name]))

  // Keep the most recent MAX_BATCH; `listAfterSeq` returns seq-ASC, so the tail
  // is the newest. maxSeq is computed over the full player set (below) so the
  // watermark still advances past messages the cap dropped.
  const capped = players.slice(-MAX_BATCH)

  // characterName is the player's display name for now. True per-PC character
  // attribution (the integrated character's name, resolved via the campaign's
  // character mapping) is deferred to a later issue; until then the display
  // name is the closest available label, with the userId as a hard fallback.
  const batch: TriggerMessage[] = capped.map((row) => ({
    userId: row.userId,
    characterName: displayNames.get(row.userId) ?? row.userId,
    text: row.content,
  }))

  const lastPlayer = players[players.length - 1]
  const maxSeq = lastPlayer ? lastPlayer.seq : lastRespondedSeq

  return { batch, maxSeq }
}
