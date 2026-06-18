import type { ClientLike } from './_types.js'

/**
 * The prose-bearing message types — the searchable corpus (MYT-74d, D7).
 * Mechanical types (skill_check/dice_roll/world_fact_lookup/ledger) store
 * JSON.stringify blobs, not prose, so they are excluded from search.
 *
 * This list MUST stay in lockstep with the partial-index predicate in
 * migration 029 (`WHERE message_type IN ('dm_text', 'player_message')`) — the
 * SQL below inlines the same literal so the planner uses the partial index
 * (a parameterised `= ANY($n)` would NOT match the literal predicate). The
 * EXPLAIN repo test pins this coupling.
 */
export const SEARCHABLE_MESSAGE_TYPES = ['dm_text', 'player_message'] as const

export interface TranscriptHit {
  readonly sessionId: string
  readonly sessionNumber: number
  readonly seq: number
  readonly messageType: string
  readonly userId: string | null // resolved to a speaker by the route
  readonly content: string
  readonly snippet: string // ts_headline highlight
  readonly createdAt: Date
}

export interface SearchTranscriptArgs {
  readonly campaignId: string
  readonly query: string // the player's raw query
  // Optional narrow to one session. Explicitly allows `undefined` (not just
  // key-absent) so callers under exactOptionalPropertyTypes can pass through a
  // `sessionId: maybeUndefined` field without a conditional spread; the bind
  // coerces it to NULL (node-pg rejects a bare `undefined`).
  readonly sessionId?: string | undefined
  readonly limit: number
  readonly offset: number
}

interface TranscriptHitDbRow {
  session_id: string
  session_number: number
  seq: number
  message_type: string
  user_id: string | null
  content: string
  snippet: string
  created_at: Date
}

// Composable binder — see sessionMessagesNs for the pattern. A single read,
// so it binds cleanly on both the pool and tx surfaces.
export function transcriptSearchNs(c: ClientLike) {
  return {
    // FTS over the prose-bearing transcript. ts_headline runs in the OUTER
    // query over the rank-filtered-and-paginated page (never the full match
    // set). The ORDER BY is a TOTAL order (a single appendDmTurn shares one
    // created_at, and terse rows tie on rank) via the (session_id, seq)
    // tiebreaker, so LIMIT/OFFSET pagination can't skip or duplicate. The
    // message_type literal matches migration 029's partial-index predicate.
    searchTranscript: async (args: SearchTranscriptArgs): Promise<readonly TranscriptHit[]> => {
      const result = await c.query<TranscriptHitDbRow>(
        `SELECT sub.session_id, sub.session_number, sub.seq, sub.message_type,
                sub.user_id, sub.content,
                ts_headline('english', sub.content, sub.tsq,
                  'StartSel=<mark>,StopSel=</mark>,MaxFragments=2,MaxWords=18,MinWords=5') AS snippet,
                sub.created_at
           FROM (
             SELECT sm.session_id, s.session_number, sm.seq, sm.message_type,
                    sm.user_id, sm.content, sm.created_at, q.tsq,
                    ts_rank(sm.content_tsv, q.tsq) AS rank
               FROM session_messages sm
               JOIN sessions s ON s.id = sm.session_id
               CROSS JOIN LATERAL websearch_to_tsquery('english', $2) AS q(tsq)
              WHERE s.campaign_id = $1
                AND ($3::uuid IS NULL OR sm.session_id = $3)
                AND sm.message_type IN ('dm_text', 'player_message')
                AND sm.content_tsv @@ q.tsq
              ORDER BY rank DESC, sm.created_at DESC, sm.session_id, sm.seq DESC
              LIMIT $4 OFFSET $5
           ) sub
          ORDER BY sub.rank DESC, sub.created_at DESC, sub.session_id, sub.seq DESC`,
        [args.campaignId, args.query, args.sessionId ?? null, args.limit, args.offset],
      )
      return result.rows.map((r) => ({
        sessionId: r.session_id,
        sessionNumber: r.session_number,
        seq: r.seq,
        messageType: r.message_type,
        userId: r.user_id,
        content: r.content,
        snippet: r.snippet,
        createdAt: r.created_at,
      }))
    },
  }
}
