import type { ClientLike } from './_types.js'

// llm_resume_stamps (migration 038) — llm-outage-resilience §3.1: one row per
// parked prep run, keyed (pipeline, entity_id). The stamp — not the failed
// pipeline_runs row — is what distinguishes "parked, will resume" from
// "genuinely failed". Field lifecycle:
//
//   - next_resume_at    arms the resume (NULL = claimed/in-flight). Cleared on
//                       stage claim so the §3.2 overdue predicate goes false at
//                       stage-start; re-armed by the next park.
//   - resume_attempt    the ladder rung, capped at the top so the counter stays
//                       bounded. SURVIVES claims — clearing it on claim would
//                       reset a waking outage to the 30s rung (hot-cycling a
//                       solo-world outage with unbounded spend).
//   - park_consumed_ms  spent parked wall-clock, incremented by each rung's
//                       scheduled delay AT PARK TIME. SURVIVES claims; clears
//                       only with the row on stage completion. Degraded parks
//                       (sitewide outage already known) pass consume:false and
//                       add nothing — a solo ladder must not burn the 6h budget
//                       while the whole site is down.
//   - last_error_class  drives the hold copy (connectivity | rate-limit).

export interface ResumeStamp {
  readonly pipeline: 'world_gen' | 'session_prep' | 'character_creation'
  readonly entityId: string
  readonly resumeAttempt: number
  readonly nextResumeAt: Date | null
  readonly parkConsumedMs: number
  readonly lastErrorClass: 'connectivity' | 'rate-limit'
}

export interface ResumeStampsRepo {
  /** Park (or re-park) a run: attempt+1 capped at the ladder top,
   *  nextResumeAt = now+delay, parkConsumedMs += consume ? delayMs : 0. */
  readonly upsertPark: (p: {
    pipeline: ResumeStamp['pipeline']
    entityId: string
    delayMs: number
    consume: boolean
    errorClass: ResumeStamp['lastErrorClass']
  }) => Promise<ResumeStamp>
  /** On stage claim: disarm the resume; ladder + budget fields survive. */
  readonly clearNextResumeAt: (pipeline: string, entityId: string) => Promise<void>
  /** On stage completion / fresh manual episode: remove the row. */
  readonly clearStamp: (pipeline: string, entityId: string) => Promise<void>
  readonly get: (pipeline: string, entityId: string) => Promise<ResumeStamp | null>
  /** Armed stamps (nextResumeAt not null) — the recovery fast-path scan. */
  readonly listArmed: (pipeline?: string) => Promise<readonly ResumeStamp[]>
}

// rung 5+ holds at 900_000
export const PARK_LADDER_MS = [30_000, 120_000, 300_000, 900_000] as const
export const PARK_BUDGET_MS = 6 * 60 * 60 * 1000

// resume_attempt cap — at the cap nextParkDelayMs already returns the top rung,
// so higher values carry no information; capping keeps the counter bounded.
const RESUME_ATTEMPT_CAP = PARK_LADDER_MS.length

export function isParkExhausted(s: ResumeStamp): boolean {
  return s.parkConsumedMs >= PARK_BUDGET_MS
}

export function nextParkDelayMs(resumeAttempt: number): number {
  const rung = Math.min(Math.max(resumeAttempt, 0), PARK_LADDER_MS.length - 1)
  /* c8 ignore start — `??` arm: rung is clamped into the tuple's index range;
   * kept for noUncheckedIndexedAccess narrowing without a non-null assert. */
  return PARK_LADDER_MS[rung] ?? PARK_LADDER_MS[PARK_LADDER_MS.length - 1] ?? 0
  /* c8 ignore stop */
}

interface ResumeStampRow {
  readonly pipeline: ResumeStamp['pipeline']
  readonly entity_id: string
  readonly resume_attempt: number
  readonly next_resume_at: Date | null
  readonly park_consumed_ms: number
  readonly last_error_class: ResumeStamp['lastErrorClass']
}

// park_consumed_ms is BIGINT — pg returns int8 as string by default; the
// ::float8 cast lands it in JS as `number` (repo precedent: cost_usd in
// pipeline-runs.ts). Values stay far below 2^53 (≤ 6h budget + one 15m rung).
const RETURNING_COLUMNS = `pipeline, entity_id, resume_attempt, next_resume_at,
         park_consumed_ms::float8 AS park_consumed_ms, last_error_class`

const UPSERT_PARK_QUERY = `
  INSERT INTO llm_resume_stamps
    (pipeline, entity_id, resume_attempt, next_resume_at, park_consumed_ms, last_error_class)
  VALUES ($1, $2, 1, now() + make_interval(secs => $3::float8 / 1000.0), $4, $5)
  ON CONFLICT (pipeline, entity_id) DO UPDATE SET
    resume_attempt = LEAST(llm_resume_stamps.resume_attempt + 1, $6),
    next_resume_at = now() + make_interval(secs => $3::float8 / 1000.0),
    park_consumed_ms = llm_resume_stamps.park_consumed_ms + $4,
    last_error_class = $5,
    updated_at = now()
  RETURNING ${RETURNING_COLUMNS}
`

const GET_QUERY = `
  SELECT ${RETURNING_COLUMNS}
    FROM llm_resume_stamps
   WHERE pipeline = $1 AND entity_id = $2
`

const LIST_ARMED_QUERY = `
  SELECT ${RETURNING_COLUMNS}
    FROM llm_resume_stamps
   WHERE next_resume_at IS NOT NULL
   ORDER BY next_resume_at, entity_id
`

const LIST_ARMED_FOR_PIPELINE_QUERY = `
  SELECT ${RETURNING_COLUMNS}
    FROM llm_resume_stamps
   WHERE next_resume_at IS NOT NULL AND pipeline = $1
   ORDER BY next_resume_at, entity_id
`

function rowToStamp(r: ResumeStampRow): ResumeStamp {
  return {
    pipeline: r.pipeline,
    entityId: r.entity_id,
    resumeAttempt: r.resume_attempt,
    nextResumeAt: r.next_resume_at,
    parkConsumedMs: r.park_consumed_ms,
    lastErrorClass: r.last_error_class,
  }
}

// Composable binder — see sessionsNs for the pattern rationale. Every method is
// a single statement over a ClientLike, though in practice the processors bind
// it pool-side: like claimStage/markStageFailed, park bookkeeping must survive
// a stage-tx rollback.
export function resumeStampsNs(c: ClientLike): ResumeStampsRepo {
  return {
    async upsertPark(p): Promise<ResumeStamp> {
      const consumedMs = p.consume ? p.delayMs : 0
      const result = await c.query<ResumeStampRow>(UPSERT_PARK_QUERY, [
        p.pipeline,
        p.entityId,
        p.delayMs,
        consumedMs,
        p.errorClass,
        RESUME_ATTEMPT_CAP,
      ])
      /* c8 ignore start — INSERT … ON CONFLICT DO UPDATE always returns one
       * row; the throw guards TS narrowing without a non-null assert. */
      if (result.rows[0] === undefined) throw new Error('upsertPark returned no row')
      /* c8 ignore stop */
      return rowToStamp(result.rows[0])
    },
    async clearNextResumeAt(pipeline, entityId): Promise<void> {
      await c.query(
        `UPDATE llm_resume_stamps SET next_resume_at = NULL, updated_at = now()
          WHERE pipeline = $1 AND entity_id = $2`,
        [pipeline, entityId],
      )
    },
    async clearStamp(pipeline, entityId): Promise<void> {
      await c.query(`DELETE FROM llm_resume_stamps WHERE pipeline = $1 AND entity_id = $2`, [
        pipeline,
        entityId,
      ])
    },
    async get(pipeline, entityId): Promise<ResumeStamp | null> {
      const result = await c.query<ResumeStampRow>(GET_QUERY, [pipeline, entityId])
      const row = result.rows[0]
      return row === undefined ? null : rowToStamp(row)
    },
    async listArmed(pipeline): Promise<readonly ResumeStamp[]> {
      const result =
        pipeline === undefined
          ? await c.query<ResumeStampRow>(LIST_ARMED_QUERY)
          : await c.query<ResumeStampRow>(LIST_ARMED_FOR_PIPELINE_QUERY, [pipeline])
      return result.rows.map(rowToStamp)
    },
  }
}
