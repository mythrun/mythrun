// backend/src/repo/snapshots.ts
//
// myth-d1h — repo for the world_snapshots table (migration 001 lines 313–319,
// index idx_world_snapshots_campaign from 002). Backend Core spec §5.2:
// `create`, `getById`, `listByCampaign`, `getLatest`.
//
// A snapshot is a campaign-scoped world-state checkpoint: `data` is an opaque
// serialized blob (TEXT, not JSONB — the column predates the store's shape and
// the repo layer stays agnostic about what a caller checkpoints). `session_preps
// .snapshot_id` is the FK that ties a prep bundle to the checkpoint it was
// built from.
//
// ORDERING (load-bearing): `created_at DEFAULT now()` is TRANSACTION time in
// Postgres, so two snapshots written inside one transaction share a timestamp
// to the microsecond. Both ordered reads therefore tiebreak on `id DESC` —
// ids are UUIDv7, which is time-ordered, so the tiebreak is the true write
// order rather than an arbitrary one. Without it "latest" is a coin flip.

import type { ClientLike } from './_types.js'
import { uuidv7 } from './uuidv7.js'

export interface WorldSnapshotRow {
  readonly id: string
  readonly campaignId: string
  readonly label: string
  /** Opaque serialized world state. The repo does not parse it. */
  readonly data: string
  readonly createdAt: Date
}

interface WorldSnapshotDbRow {
  readonly id: string
  readonly campaign_id: string
  readonly label: string
  readonly data: string
  readonly created_at: Date
}

function toWorldSnapshotRow(r: WorldSnapshotDbRow): WorldSnapshotRow {
  return {
    id: r.id,
    campaignId: r.campaign_id,
    label: r.label,
    data: r.data,
    createdAt: r.created_at,
  }
}

const COLUMNS = 'id, campaign_id, label, data, created_at'

export interface CreateSnapshotInput {
  readonly campaignId: string
  readonly label: string
  readonly data: string
}

/** Composable binder over a single ClientLike, so `repo.snapshots.X` and
 *  `tx.snapshots.X` share one body (a snapshot is normally written inside the
 *  same transaction as the state it checkpoints). */
export function snapshotsNs(c: ClientLike) {
  return {
    create: async (input: CreateSnapshotInput): Promise<WorldSnapshotRow> => {
      const { rows } = await c.query<WorldSnapshotDbRow>(
        `INSERT INTO world_snapshots (id, campaign_id, label, data)
              VALUES ($1, $2, $3, $4)
           RETURNING ${COLUMNS}`,
        [uuidv7(), input.campaignId, input.label, input.data],
      )
      const r = rows[0]
      if (!r) throw new Error('snapshots.create: INSERT returned no row')
      return toWorldSnapshotRow(r)
    },

    getById: async (id: string): Promise<WorldSnapshotRow | null> => {
      const { rows } = await c.query<WorldSnapshotDbRow>(
        `SELECT ${COLUMNS} FROM world_snapshots WHERE id = $1`,
        [id],
      )
      const r = rows[0]
      return r ? toWorldSnapshotRow(r) : null
    },

    /** Newest first (see the ORDERING note in the header). */
    listByCampaign: async (campaignId: string): Promise<readonly WorldSnapshotRow[]> => {
      const { rows } = await c.query<WorldSnapshotDbRow>(
        `SELECT ${COLUMNS} FROM world_snapshots
          WHERE campaign_id = $1
          ORDER BY created_at DESC, id DESC`,
        [campaignId],
      )
      return rows.map(toWorldSnapshotRow)
    },

    getLatest: async (campaignId: string): Promise<WorldSnapshotRow | null> => {
      const { rows } = await c.query<WorldSnapshotDbRow>(
        `SELECT ${COLUMNS} FROM world_snapshots
          WHERE campaign_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        [campaignId],
      )
      const r = rows[0]
      return r ? toWorldSnapshotRow(r) : null
    },
  }
}
