// backend/scripts/smoke/entity-consolidation-flow.ts
//
// myth-tt2g P6.2b — constructed-state smoke for the phantom-reference
// generative path (stage 4 → stage 4b).
//
// The natural smoke at scripts/smoke/phantom-reconciliation.ts proves
// the skip path: world-gen completes when the LLM doesn't drop any
// phantom names. The constructed-state smoke proves the OTHER path:
// stage 4 sees prose name-drops, declares placeholders, and stage 4b
// generates real ghost entities for them.
//
// Strategy: skip stages 1–3 entirely. Seed the DB with end-of-stage-3
// state — vocabulary registry, a small entity inventory, prose that
// specifically name-drops 1–2 entities NOT in the inventory. Then
// invoke runEntityRelationshipsStage + runEntityConsolidationStage
// directly against real Postgres + real Redis + real Anthropic.
//
// Assertions: stage 4 writes ≥1 declaration into
// worlds.entity_consolidation_pending; stage 4b creates ≥1 entity
// with created_in='stage:entity_consolidation'; pending column
// clears; Redis emits at least one entity-added (with placeholderId)
// and at least one edge-added with resolved (non-placeholder) UUIDs.

import { Pool, type PoolClient } from 'pg'
import { Redis } from 'ioredis'
import { loadEnv } from '../../src/config/env.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { entities } from '../../src/repo/entities.js'
import { facts } from '../../src/repo/facts.js'
import { proseKernels } from '../../src/repo/prose-kernels.js'
import { entityHierarchy } from '../../src/repo/entity-hierarchy.js'
import { runEntityRelationshipsStage } from '../../src/llm/prep/stages/entity-relationships.js'
import { runEntityConsolidationStage } from '../../src/llm/prep/stages/entity-consolidation.js'
import type { VocabularyRegistry } from '../../src/llm/schemas/vocabulary-registry.js'

const SMOKE_USER_SUB = 'smoke-eccons-1'
const SMOKE_DISPLAY_NAME = 'EntityConsolidation Smoke User'
const SMOKE_USERNAME = 'smoke-eccons-user'
const WORLD_NAME = 'SMOKE: entity_consolidation seed'

interface SeededWorld {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly longVigilId: string
  readonly magisteriumId: string
  readonly boneReachId: string
  readonly saltPillarsId: string
  readonly oldCausewayId: string
}

function log(msg: string): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg })}\n`)
}

async function cleanupPriorState(pool: Pool): Promise<void> {
  const user = await pool.query<{ id: string }>(
    `SELECT id FROM users WHERE cognito_sub = $1`,
    [SMOKE_USER_SUB],
  )
  if (user.rows.length === 0) return
  const userId = user.rows[0]?.id ?? ''
  await pool.query(`DELETE FROM worlds WHERE created_by = $1`, [userId])
  await pool.query(`DELETE FROM users WHERE id = $1`, [userId])
}

async function seedEndOfStage3(pool: Pool): Promise<SeededWorld> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const campaignId = uuidv7()
  const longVigilId = uuidv7()
  const magisteriumId = uuidv7()
  const boneReachId = uuidv7()
  const saltPillarsId = uuidv7()
  const oldCausewayId = uuidv7()

  const vocab: VocabularyRegistry = {
    entries: [
      {
        term: 'Boneright',
        definition: 'A right of hunting passage on the salt-bone flats; conferred by the eldest hunter of a band to one of its members.',
        source: 'stage_1_5',
        access_level: 'known',
      },
      {
        term: 'Magisters',
        definition: 'Senior magic-users of the floating sky city above the Bone Reach; bound by the codex of the Long Memory.',
        source: 'stage_1_5',
        access_level: 'known',
      },
    ],
    adjacent_franchises: [],
  }

  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username)
     VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, SMOKE_DISPLAY_NAME, SMOKE_USERNAME],
  )

  await pool.query(
    `INSERT INTO worlds
       (id, created_by, name, concept, tone, themes, key_tensions,
        world_overview, vocabulary_registry, status, dev_bypass_access_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'generating', true)`,
    [
      worldId,
      userId,
      WORLD_NAME,
      'A bone-dust desert under a floating sky city. Hunting bands rule the dunes; magisters watch from above.',
      'low-fantasy, ash-and-salt',
      'rivalry, scarcity, distant authority',
      'The hunting bands compete for Boneright; the Magisterium tolerates them but does not intervene.',
      'A bone-dust desert under a floating sky city.',
      JSON.stringify(vocab),
    ],
  )

  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, userId, WORLD_NAME],
  )

  // ----- factions -----
  await entities.insert(pool, {
    id: longVigilId, worldId, entityType: 'faction',
    name: 'The Long Vigil', accessLevel: 'known',
    createdIn: 'stage:world_and_factions',
  })
  await proseKernels.insert(pool, {
    entityId: longVigilId,
    content:
      'The Long Vigil are the senior hunting band of the Bone Reach. They patrol the Salt Pillars and the Old Causeway; they hold the elder Boneright. Their rivals are the Ironjaw, a younger band ranging the western dunes who have begun contesting Bone Reach territory in defiance of long custom. To the north the Ash-and-Salt pretend independence but bow when the Long Vigil ride out in full.',
  })
  await facts.insertMany(pool, [
    { entityId: longVigilId, topic: 'leader', accessLevel: 'known',
      content: 'Led by Hunter-Eldest Sereth, who holds the longest unbroken Boneright in living memory.' },
    { entityId: longVigilId, topic: 'rivalry', accessLevel: 'known',
      content: 'Disputes territory with the Ironjaw, a rival hunting band that ranges the western dunes.' },
  ])

  await entities.insert(pool, {
    id: magisteriumId, worldId, entityType: 'faction',
    name: 'The Magisterium', accessLevel: 'known',
    createdIn: 'stage:world_and_factions',
  })
  await proseKernels.insert(pool, {
    entityId: magisteriumId,
    content:
      'The Magisterium is the council of magisters that rules the sky city above the Bone Reach. They guard the codex of the Long Memory and the Aetheric Conservatory where new magisters are formed. The Magisterium tolerates the Long Vigil and the Ironjaw and Ash-and-Salt; the codex names them but does not intervene in their disputes.',
  })
  await facts.insertMany(pool, [
    { entityId: magisteriumId, topic: 'jurisdiction', accessLevel: 'known',
      content: 'Authority over the sky city; does not enforce in the Bone Reach below.' },
    { entityId: magisteriumId, topic: 'institution', accessLevel: 'known',
      content: 'Trains successor magisters at the Aetheric Conservatory.' },
  ])

  // ----- locations -----
  await entities.insert(pool, {
    id: boneReachId, worldId, entityType: 'location',
    name: 'The Bone Reach', accessLevel: 'known',
    createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: boneReachId,
    content:
      'The Bone Reach is the salt-bleached basin under the sky city, a desert of vertebra-pillars and slow dunes. The hunting bands ride here for the megafauna that come to the salt at dusk.',
  })
  await facts.insertMany(pool, [
    { entityId: boneReachId, topic: 'terrain', accessLevel: 'known',
      content: 'Salt-and-bone flatland; dunes east, pillars west, the sky-city overhead.' },
  ])

  await entities.insert(pool, {
    id: saltPillarsId, worldId, entityType: 'location',
    name: 'The Salt Pillars', accessLevel: 'known',
    createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: saltPillarsId,
    content:
      'The Salt Pillars are a forest of leaning salt-crystal columns at the western edge of the Bone Reach, patrolled most often by the Long Vigil and contested intermittently by the Ironjaw.',
  })
  await facts.insertMany(pool, [
    { entityId: saltPillarsId, topic: 'use', accessLevel: 'known',
      content: 'Watchtower territory; Long Vigil maintains lookouts here.' },
  ])
  await entityHierarchy.insert(pool, { parentEntityId: boneReachId, childEntityId: saltPillarsId })

  await entities.insert(pool, {
    id: oldCausewayId, worldId, entityType: 'location',
    name: 'The Old Causeway', accessLevel: 'known',
    createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: oldCausewayId,
    content:
      'A weather-broken roadway crossing the Bone Reach east to west; the Long Vigil claims its eastern half by long custom. The Ash-and-Salt walk the western half as if independent. Travelers say the Procurement Office once owned the road; whether the sky-city remembers is unclear.',
  })
  await facts.insertMany(pool, [
    { entityId: oldCausewayId, topic: 'history', accessLevel: 'known',
      content: 'Once a Procurement Office trade road; now contested between hunting bands.' },
  ])
  await entityHierarchy.insert(pool, { parentEntityId: boneReachId, childEntityId: oldCausewayId })

  return { userId, worldId, campaignId, longVigilId, magisteriumId, boneReachId, saltPillarsId, oldCausewayId }
}

interface CapturedEvent {
  readonly channel: string
  readonly payload: Record<string, unknown>
}

async function subscribeToPipeline(
  redisRealtimeUrl: string,
  keyPrefix: string,
  campaignId: string,
  captured: CapturedEvent[],
): Promise<{ close: () => Promise<void> }> {
  const sub = new Redis(redisRealtimeUrl)
  const channel = `${keyPrefix}pipeline:campaign:${campaignId}`
  await new Promise<void>((resolve, reject) => {
    sub.subscribe(channel, (err) => { err ? reject(err) : resolve() })
  })
  sub.on('message', (ch, message) => {
    try {
      const payload = JSON.parse(message) as Record<string, unknown>
      captured.push({ channel: ch, payload })
    } catch {
      // ignore malformed frames
    }
  })
  return {
    close: async () => {
      await sub.unsubscribe()
      sub.disconnect()
    },
  }
}

async function runWithClient<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    return await fn(client)
  } finally {
    client.release()
  }
}

interface PendingDeclaration {
  readonly placeholderId: string
  readonly name: string
  readonly entityType: string
}

interface PendingShape {
  readonly declarations: readonly PendingDeclaration[]
  readonly relationships: readonly Record<string, unknown>[]
}

async function readPending(pool: Pool, worldId: string): Promise<PendingShape> {
  const row = await pool.query<{ entity_consolidation_pending: PendingShape }>(
    `SELECT entity_consolidation_pending FROM worlds WHERE id = $1`,
    [worldId],
  )
  return row.rows[0]?.entity_consolidation_pending ?? { declarations: [], relationships: [] }
}

async function countConsolidationEntities(pool: Pool, worldId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM entities
       WHERE world_id = $1 AND created_in = 'stage:entity_consolidation'`,
    [worldId],
  )
  return Number(r.rows[0]?.n ?? '0')
}

async function countAllRelationships(pool: Pool, worldId: string): Promise<number> {
  const r = await pool.query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM relationships rel
       JOIN entities e ON e.id = rel.source_entity_id
       WHERE e.world_id = $1`,
    [worldId],
  )
  return Number(r.rows[0]?.n ?? '0')
}

async function main(): Promise<void> {
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  const keyPrefix = env.redisKeyPrefix
  const captured: CapturedEvent[] = []
  let pipelineSub: { close: () => Promise<void> } | null = null

  try {
    log('cleanup: removing any prior smoke-eccons-1 state')
    await cleanupPriorState(pool)

    log('seed: writing end-of-stage-3 state')
    const seeded = await seedEndOfStage3(pool)
    log(`seeded worldId=${seeded.worldId} campaignId=${seeded.campaignId}`)

    pipelineSub = await subscribeToPipeline(
      env.redisRealtimeUrl,
      keyPrefix,
      seeded.campaignId,
      captured,
    )

    const realtimePub = new Redis(env.redisRealtimeUrl)
    const vocab = (
      await pool.query<{ vocabulary_registry: VocabularyRegistry }>(
        `SELECT vocabulary_registry FROM worlds WHERE id = $1`,
        [seeded.worldId],
      )
    ).rows[0]?.vocabulary_registry as VocabularyRegistry

    // ------- STAGE 4 -------
    log('stage 4: invoking runEntityRelationshipsStage')
    await runWithClient(pool, (client) =>
      runEntityRelationshipsStage(client, {
        campaignId: seeded.campaignId,
        worldId: seeded.worldId,
        worldName: WORLD_NAME,
        tone: 'low-fantasy, ash-and-salt',
        themes: 'rivalry, scarcity, distant authority',
        keyTensions: 'The hunting bands compete for Boneright; the Magisterium tolerates them but does not intervene.',
        vocabularyRegistry: vocab,
        job: { updateProgress: async () => Promise.resolve() },
        redisRealtime: realtimePub,
        keyPrefix,
        bypassAccessFilter: true,
      }),
    )

    const pendingAfterS4 = await readPending(pool, seeded.worldId)
    log(`stage 4 done: declarations=${String(pendingAfterS4.declarations.length)} placeholderRelationships=${String(pendingAfterS4.relationships.length)}`)
    if (pendingAfterS4.declarations.length === 0) {
      throw new Error(
        'stage 4 produced zero placeholder declarations. The seeded prose was designed to name-drop Ironjaw / Ash-and-Salt / Procurement Office. If this fails consistently, the prompt is no longer extracting phantoms — investigate.',
      )
    }

    // ------- STAGE 4b -------
    log('stage 4b: invoking runEntityConsolidationStage')
    const result = await runWithClient(pool, (client) =>
      runEntityConsolidationStage(client, {
        campaignId: seeded.campaignId,
        worldId: seeded.worldId,
        worldName: WORLD_NAME,
        tone: 'low-fantasy, ash-and-salt',
        themes: 'rivalry, scarcity, distant authority',
        keyTensions: 'The hunting bands compete for Boneright; the Magisterium tolerates them but does not intervene.',
        vocabularyRegistry: vocab,
        bypassAccessFilter: true,
        redisRealtime: realtimePub,
        keyPrefix,
      }),
    )
    log(`stage 4b done: costUsd=${result.costUsd.toFixed(4)} inputTokens=${String(result.inputTokens)} outputTokens=${String(result.outputTokens)}`)

    // ------- ASSERTIONS -------
    const ghosts = await countConsolidationEntities(pool, seeded.worldId)
    if (ghosts === 0) {
      throw new Error(`stage 4b produced zero stage:entity_consolidation entities; expected ≥1`)
    }
    log(`assertion: stage:entity_consolidation entities=${String(ghosts)} ✓`)

    const pendingAfterS4b = await readPending(pool, seeded.worldId)
    if (
      pendingAfterS4b.declarations.length !== 0 ||
      pendingAfterS4b.relationships.length !== 0
    ) {
      throw new Error(
        `stage 4b did not clear pending column: declarations=${String(pendingAfterS4b.declarations.length)} relationships=${String(pendingAfterS4b.relationships.length)}`,
      )
    }
    log('assertion: pending column cleared ✓')

    const totalRels = await countAllRelationships(pool, seeded.worldId)
    log(`assertion: relationships rows=${String(totalRels)}`)

    const entityAddedWithPh = captured.filter(
      (e) => e.payload.type === 'entity-added' && typeof e.payload.placeholderId === 'string',
    )
    const edgeAddedResolved = captured.filter(
      (e) =>
        e.payload.type === 'edge-added' &&
        typeof e.payload.from === 'string' &&
        typeof e.payload.to === 'string' &&
        !(e.payload.from as string).startsWith('new-') &&
        !(e.payload.to as string).startsWith('new-'),
    )
    if (entityAddedWithPh.length === 0) {
      throw new Error('no entity-added events carried placeholderId — stage 4b SSE emit broken')
    }
    log(`assertion: entity-added events with placeholderId=${String(entityAddedWithPh.length)} ✓`)
    if (edgeAddedResolved.length === 0) {
      throw new Error('no edge-added events with resolved (non-placeholder) endpoints — stage 4b SSE emit broken')
    }
    log(`assertion: edge-added events with resolved endpoints=${String(edgeAddedResolved.length)} ✓`)

    realtimePub.disconnect()
    log('SMOKE PASSED — generative path verified end-to-end')
    log(`inspect: world ${seeded.worldId}, campaign ${seeded.campaignId}`)
  } finally {
    if (pipelineSub !== null) await pipelineSub.close()
    await pool.end()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
