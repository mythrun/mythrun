// MYT-74a T10 — `buildReconcileWorker` boot wiring, split from the main processor
// suite (session-reconcile.test.ts) so the bullmq module mock + the file-size cap
// each stay in their lane (mirrors scribe-worker-boot.test.ts).
//
// Exercise buildReconcileWorker against a mocked broker: assert it builds a Worker
// on QUEUE_SESSION_RECONCILE and drives the captured processor through the REAL
// boot closures (createRepo / makeWorkingSetRepo / createSessionLock /
// createSearchResolvers.findSimilarEntities). The reconciler LLM is module-mocked.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import IoRedisMock from 'ioredis-mock'
import type { Pool, PoolClient } from 'pg'

import { QUEUE_SESSION_RECONCILE, type ReconcileJobPayload } from '../session-reconcile.js'
import { buildReconcileWorker } from '../session-reconcile.js'
import type { VoyageEmbedder } from '../../llm/embed.js'

const CAMPAIGN = 'c-recon-boot-1'
const SESSION = 's-recon-boot-1'
const WORLD = 'w-recon-boot-1'

type CapturedProcessor = (job: { data: ReconcileJobPayload }) => Promise<void>
const bullmqCapture: { processor: CapturedProcessor | null; workerName: string | null } = {
  processor: null,
  workerName: null,
}

vi.mock('bullmq', () => ({
  Worker: vi.fn().mockImplementation((name: string, processor: CapturedProcessor) => {
    bullmqCapture.processor = processor
    bullmqCapture.workerName = name
    return { close: () => Promise.resolve(), on: vi.fn() }
  }),
  Queue: vi.fn().mockImplementation((name: string) => ({ name, add: () => Promise.resolve({}) })),
}))

// The reconciler is module-mocked — the boot path never reaches it on the
// early-out / empty-working-set drives, but the mock guards against an
// accidental real Opus call leaking into the boot suite.
vi.mock('../../llm/session-reconciler.js', () => ({
  runSessionReconciler: () =>
    Promise.reject(new Error('reconciler must not run on the boot-drive paths')),
}))

const embedder: VoyageEmbedder = {
  embedDocuments: () => Promise.resolve([]),
  embedQuery: () => Promise.resolve([]),
}

/** A fake pool whose `query` answers the session gate read + `markReconciled`,
 *  and whose `connect()` returns a transaction-capable client (BEGIN/COMMIT +
 *  the gate UPDATE) so the empty-working-set commit drives the REAL
 *  applyReconcileCommit through repo.transaction. `reconciled` flips the gate
 *  read between the already-done early-out and the fresh-session commit path. */
function makeFakePool(reconciled: boolean): Pool {
  const sessionRow = {
    id: SESSION,
    campaign_id: CAMPAIGN,
    session_number: 3,
    status: 'active',
    started_at: new Date(0),
    ended_at: null,
    summary: null,
    st_running_summary: null,
    handoff: null,
    reconciled_at: reconciled ? new Date(0) : null,
  }
  const query = (sql: string): Promise<{ rows: unknown[]; rowCount: number }> => {
    if (sql.includes('FROM sessions') && sql.includes('WHERE id')) {
      return Promise.resolve({ rows: [sessionRow], rowCount: 1 })
    }
    // markReconciled (the gate) → 1 row updated (this execution wins).
    if (sql.includes('UPDATE sessions') && sql.includes('reconciled_at')) {
      return Promise.resolve({ rows: [], rowCount: 1 })
    }
    return Promise.resolve({ rows: [], rowCount: 0 })
  }
  const client = {
    query,
    release: vi.fn(),
  } as unknown as PoolClient
  return {
    query,
    connect: () => Promise.resolve(client),
  } as unknown as Pool
}

describe('buildReconcileWorker — boot wiring + processor closure', () => {
  beforeEach(() => {
    bullmqCapture.processor = null
    bullmqCapture.workerName = null
  })

  it('builds a Worker on QUEUE_SESSION_RECONCILE', () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const worker = buildReconcileWorker(redis, redis, 'recon:', makeFakePool(false), embedder, logger)
    expect(worker).toBeDefined()
    expect(bullmqCapture.workerName).toBe(QUEUE_SESSION_RECONCILE)
  })

  it('already-reconciled session → drives the real getById + workingSet.clear closures', async () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    // Seed a working-set item so the defensive clear has something to drop.
    await redis.rpush(`recon:session:${CAMPAIGN}:workingset`, JSON.stringify({ subjectName: 'x' }))

    buildReconcileWorker(redis, redis, 'recon:', makeFakePool(true), embedder, logger)
    const processor = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')

    await processor({ data: { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD } })

    // The defensive clear ran against the REAL makeWorkingSetRepo (DEL the key).
    const raw = await redis.lrange(`recon:session:${CAMPAIGN}:workingset`, 0, -1)
    expect(raw).toHaveLength(0)
    expect(logger.info).toHaveBeenCalled()
  })

  it('fresh session + empty working set → drives lock + load + the real empty-plan commit', async () => {
    const redis = new IoRedisMock()
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

    buildReconcileWorker(redis, redis, 'recon:', makeFakePool(false), embedder, logger)
    const processor = bullmqCapture.processor
    if (processor === null) throw new Error('processor was not captured')

    // No working-set key → empty load → the empty-plan commit fires the gate
    // through the REAL applyReconcileCommit + repo.transaction (BEGIN/COMMIT on
    // the fake client), then the working set is cleared.
    await processor({ data: { campaignId: CAMPAIGN, sessionId: SESSION, worldId: WORLD } })

    // committed:true (gate UPDATE returned rowCount 1) → reconcile_committed info log.
    const committedLog = logger.info.mock.calls.find((c) => c[1] === 'reconcile_committed')
    expect(committedLog).toBeDefined()
    expect(logger.error).not.toHaveBeenCalled()
  })
})
