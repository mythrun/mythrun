/**
 * Player-facing speaker attribution for session_messages rows. One source of
 * truth for "who said it", shared by the WS replay path (routes/ws-session.ts)
 * and transcript search (MYT-74d).
 */

/** A message authored by the DM tier (FT-rendered dm_text rows carry a null
 *  user_id). */
export const DM_SPEAKER_NAME = 'DM'

/** A message authored by a user who has since left the campaign (absent from
 *  the active character map). NOT "DM" — collapsing a departed player's line
 *  into the DM is a "who said it" mis-attribution. */
export const DEPARTED_AUTHOR_NAME = 'Former player'

/**
 * Resolve a session_messages.user_id to a player-facing speaker:
 *  - null            → "DM"
 *  - present in map  → the speaking character's name
 *  - non-null/absent → DEPARTED_AUTHOR_NAME (departed player)
 */
export function resolveSpeaker(
  userId: string | null,
  characterByUser: ReadonlyMap<string, string>,
): string {
  if (userId === null) return DM_SPEAKER_NAME
  return characterByUser.get(userId) ?? DEPARTED_AUTHOR_NAME
}
