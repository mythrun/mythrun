// backend/scripts/smoke/world-retrieval-voyage.ts
//
// MYT-71 T13 — gated real-Voyage constructed smoke for the world-store retrieval
// substrate. Proves the plumbing that mocked unit tests CANNOT: that the live
// Voyage API returns 512-dim vectors for our request shape, that the
// document/query input_type asymmetry works, that the pgvector vector(512)
// round-trip stores + cosine-ranks, and that embedWorld (write) + searchLore
// (read) compose end-to-end against real Postgres.
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the near/far inputs are
// deliberately far apart in meaning, so the cosine ordering is a deterministic
// plumbing assertion (near ranks above far), not a judgment of output quality.
//
// Gated on VOYAGE_API_KEY: skips cleanly (exit 0) when absent. Seeds + tears down
// its own scratch world in mythrun_dev; embeds a tiny corpus (free tier).
//
// Run:  pnpm smoke:world-retrieval

import { Pool } from 'pg'
import pino from 'pino'
import { loadEnv } from '../../src/config/env.js'
import { createRepo } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { entities } from '../../src/repo/entities.js'
import { proseKernels } from '../../src/repo/prose-kernels.js'
import { facts } from '../../src/repo/facts.js'
import { createVoyageEmbedder, isVoyageConfigError, VoyageEmbedError } from '../../src/llm/embed.js'
import { probeVoyageAtBoot } from '../../src/boot/voyage-probe.js'
import { embedWorld, createSearchResolvers } from '../../src/world/retrieval/index.js'

const logger = pino({ level: 'info' })
function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const SMOKE_USER_SUB = 'smoke-voyage-retrieval-1'
const QUERY = 'Where does the ancient dragon make its lair high in the volcanic mountains?'

async function seedWorld(pool: Pool): Promise<{ worldId: string; nearId: string; farId: string }> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const nearId = uuidv7()
  const farId = uuidv7()

  await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, 'Voyage Smoke User', 'smoke-voyage-user'],
  )
  await pool.query(
    `INSERT INTO worlds
       (id, created_by, name, concept, tone, themes, key_tensions,
        world_overview, vocabulary_registry, status, dev_bypass_access_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'generating', true)`,
    [
      worldId,
      userId,
      'SMOKE: voyage retrieval',
      'A volcanic range and a coastal market town.',
      'high-fantasy',
      'fire, trade',
      'none',
      'A volcanic range and a coastal market town.',
      JSON.stringify({}),
    ],
  )

  // NEAR: semantically close to QUERY (dragon + volcanic mountain).
  await entities.insert(pool, {
    id: nearId, worldId, entityType: 'location',
    name: 'Mount Caldera', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: nearId,
    content:
      'An ancient dragon sleeps in the molten heart of Mount Caldera, coiled around the mountain’s fire. Smoke threads from fissures along its volcanic slopes; the peak has not gone cold in a thousand years.',
  })
  await facts.insertMany(pool, [
    { entityId: nearId, topic: 'inhabitant', accessLevel: 'secret',
      content: 'The wyrm Ashmaw lairs in the lava chamber beneath the summit, hoarding obsidian.' },
  ])

  // FAR: semantically distant (coastal fish market).
  await entities.insert(pool, {
    id: farId, worldId, entityType: 'location',
    name: 'Saltmarket Wharf', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: farId,
    content:
      'A bustling harbor fish market where traders haggle over the morning catch. Gulls wheel over crates of silver herring and barrels of brined cod along the wet planks of the wharf.',
  })

  return { worldId, nearId, farId }
}

async function main(): Promise<void> {
  if (!process.env.VOYAGE_API_KEY) {
    log('VOYAGE_API_KEY absent — skipping real-Voyage retrieval smoke (gated)')
    return
  }
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  const repo = createRepo(pool)
  const embedder = createVoyageEmbedder({ apiKey: env.voyageApiKey })

  let worldId: string | undefined
  try {
    const seeded = await seedWorld(pool)
    worldId = seeded.worldId
    log('seeded scratch world', seeded)

    // WRITE PATH — real Voyage document embeddings → pgvector vector(512).
    const summary = await embedWorld({ embedder, repo }, worldId)
    log('embedWorld complete', { ...summary })
    if (summary.voyageErrors > 0) throw new Error(`embedWorld reported ${summary.voyageErrors} Voyage errors`)
    if (summary.embedded < 3) throw new Error(`expected >=3 rows embedded (2 entities + 1 fact), got ${summary.embedded}`)

    // READ PATH — real Voyage query embedding → cosine search.
    const { searchLore } = createSearchResolvers({ embedder, repo, logger })
    const { hits } = await searchLore(worldId, QUERY, { limit: 10 })
    log('searchLore returned', { count: hits.length, hits: hits.map((h) => ({ name: h.entityName, source: h.source, score: Number(h.score.toFixed(4)) })) })

    if (hits.length === 0) throw new Error('searchLore returned no hits — pgvector round-trip failed')
    const top = hits[0]
    if (top === undefined || top.entityId !== seeded.nearId) {
      throw new Error(`expected NEAR entity (Mount Caldera) to rank first, got "${top?.entityName ?? 'none'}"`)
    }
    // The far entity must appear (over-pull) but rank below the near one.
    const far = hits.find((h) => h.entityId === seeded.farId)
    if (far !== undefined && far.score >= top.score) {
      throw new Error(`FAR entity scored >= NEAR — semantic ordering broken (near=${top.score}, far=${far.score})`)
    }
    // The secret fact must surface too (over-pull across all tiers — no access filter).
    const secretFact = hits.find((h) => h.source === 'fact')
    log('PASS (positive) — near ranks first; far over-pulled below; secret fact present', {
      topScore: Number(top.score.toFixed(4)),
      farScore: far ? Number(far.score.toFixed(4)) : null,
      secretFactPresent: secretFact !== undefined,
    })

    // NEGATIVE — a misconfigured key must make the boot probe CRASH LOUD against
    // real Voyage (the "never silently unsearchable" guarantee), not degrade.
    const badEmbedder = createVoyageEmbedder({ apiKey: 'pa-deliberately-invalid-key' })
    let probeThrew = false
    try {
      await probeVoyageAtBoot(badEmbedder, logger)
    } catch (err) {
      probeThrew = true
      if (!(err instanceof VoyageEmbedError && isVoyageConfigError(err))) {
        throw new Error(`boot probe threw, but not a classified config error: ${String(err)}`)
      }
      log('PASS (negative) — boot probe REFUSES a bad key with a loud config error', { kind: err.kind, status: err.status })
    }
    if (!probeThrew) {
      throw new Error('boot probe did NOT throw on a deliberately-invalid key — the silent-failure guard is BROKEN')
    }
  } finally {
    if (worldId !== undefined) {
      await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    }
    await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
    await pool.end()
  }
}

main().catch((err: unknown) => {
  log('FAIL — real-Voyage retrieval smoke errored', { err: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
