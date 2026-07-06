// backend/scripts/smoke/relationship-tiering.ts
//
// MYT-89 Phase A (A5) — real-LLM constructed-state smoke for relationship
// tiering + the reveal-snapshot security gate.
//
// Verifies END-TO-END that:
//   1. Stage 4 (entity_relationships) tiers relationships with the REAL LLM
//      (real Anthropic Sonnet), persisting a mix of access_level values into
//      the relationships table (A2/A3 emit the tier, A4 persists it).
//   2. The owner reveal snapshot (worldSnapshotView, bypass:false) surfaces
//      ONLY `known`-tier relationships — a `secret` connection between two
//      `known` entities is EXCLUDED (A5, the enforced-ignorance leak spec §10
//      exists to close), and bypass:true widens to include it.
//
// Strategy: skip stages 1–3. Seed an end-of-stage-3 world where EVERY entity
// is `known`, so the entity tier filter never excludes an endpoint — the
// relationship's OWN access_level is then the only guard. The prose is written
// to imply a web of open, secret, and merely-rumored connections so the LLM
// has material to tier across all three levels.
//
// To make the exclusion DETERMINISTIC even if a given generation happens to
// emit all-`known` relationships, the smoke seeds ONE explicit `secret`
// relationship (a marker predicate) between two known entities into the DB
// AFTER stage 4 commits, then asserts the non-bypass snapshot excludes it and
// the bypass snapshot includes it.
//
// Runs against real Postgres + real Redis + real Anthropic via .env.development
// (the dev database, mythrun_dev). Cleans up its own world on entry and exit.

import { Pool } from 'pg'
import { Redis } from 'ioredis'
import { loadEnv } from '../../src/config/env.js'
import { createRepo } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { entities } from '../../src/repo/entities.js'
import { facts } from '../../src/repo/facts.js'
import { proseKernels } from '../../src/repo/prose-kernels.js'
import { runEntityRelationshipsStage } from '../../src/llm/prep/stages/entity-relationships.js'
import { worldSnapshotView } from '../../src/repo/world-snapshot-view.js'
import type { VocabularyRegistry } from '../../src/llm/schemas/vocabulary-registry.js'

const SMOKE_USER_SUB = 'smoke-rel-tier-1'
const SMOKE_DISPLAY_NAME = 'RelationshipTiering Smoke User'
const SMOKE_USERNAME = 'smoke-rel-tier-user'
const WORLD_NAME = 'SMOKE: relationship tiering seed'
const TONE = 'salt-and-lamplight harbor noir'
const THEMES = 'debt, tides, quiet corruption'
const KEY_TENSIONS =
  'The harbor runs on favors nobody admits to; the guilds keep public faces and private ledgers.'

// A marker predicate for the DB-seeded secret edge — distinctive so it can be
// asserted present/absent in the two snapshots without colliding with any
// predicate the LLM is likely to emit.
const SECRET_MARKER_PREDICATE = 'smoke_secret_backchannel'

const WALL_CLOCK_BUDGET_MS = 180_000

interface SeededWorld {
  readonly userId: string
  readonly worldId: string
  readonly campaignId: string
  readonly tidewardensId: string
  readonly giltLedgerId: string
  readonly drownedCourtId: string
  readonly harbormasterVellId: string
  readonly cinderquayId: string
  readonly saltglassId: string
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
  const tidewardensId = uuidv7()
  const giltLedgerId = uuidv7()
  const drownedCourtId = uuidv7()
  const harbormasterVellId = uuidv7()
  const cinderquayId = uuidv7()
  const saltglassId = uuidv7()

  const vocab: VocabularyRegistry = {
    entries: [
      {
        term: 'Cinderquay',
        definition:
          'The oldest dock district of the harbor city, half-flooded at high tide; where the guilds keep their public counting-houses and their private cellars.',
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
       (id, created_by, name, concept, tone, themes, era, key_tensions,
        world_overview, vocabulary_registry, status, dev_bypass_access_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'generating', false)`,
    [
      worldId,
      userId,
      WORLD_NAME,
      'A harbor city that runs on debts nobody writes down. Every guild wears a clean public face over a private ledger.',
      TONE,
      THEMES,
      'the long low tide',
      KEY_TENSIONS,
      'A harbor city where public alliances hide private debts.',
      JSON.stringify(vocab),
    ],
  )

  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, status)
     VALUES ($1, $2, $3, $4, 'setup')`,
    [campaignId, worldId, userId, WORLD_NAME],
  )

  // Every entity is `known` — the entity tier filter never excludes an
  // endpoint, so the relationship's own access_level is the sole guard.

  // ----- factions -----
  await entities.insert(pool, {
    id: tidewardensId, worldId, entityType: 'faction',
    name: 'The Tidewardens', accessLevel: 'known', createdIn: 'stage:world_and_factions',
  })
  await proseKernels.insert(pool, {
    entityId: tidewardensId,
    content:
      'The Tidewardens are the harbor guild that openly runs Cinderquay and keeps the Saltglass Lighthouse lit — everyone in the city knows this. The Gilt Ledger openly finances their sea-wall repairs, a partnership announced on brass plaques. Harbormaster Vell serves the Tidewardens publicly and proudly. But dockhands whisper of an unspoken truce between the Tidewardens and The Drowned Court — nothing anyone can prove, only a pattern of raids that never seem to touch the right warehouses.',
  })
  await facts.insertMany(pool, [
    { entityId: tidewardensId, topic: 'mandate', accessLevel: 'known',
      content: 'Charged by the city with keeping Cinderquay\'s docks and the Saltglass Lighthouse in working order.' },
  ])

  await entities.insert(pool, {
    id: giltLedgerId, worldId, entityType: 'faction',
    name: 'The Gilt Ledger', accessLevel: 'known', createdIn: 'stage:world_and_factions',
  })
  await proseKernels.insert(pool, {
    entityId: giltLedgerId,
    content:
      'The Gilt Ledger is the merchant-bank that everyone in the harbor borrows from. It publicly finances the Tidewardens and lends openly to half the city. In truth — and this is a secret known to no one outside its innermost partners — the Gilt Ledger secretly bankrolls The Drowned Court, laundering smuggling profits through its clean public accounts. It also secretly holds Harbormaster Vell\'s ruinous gambling debts, a leash it has never had to pull.',
  })
  await facts.insertMany(pool, [
    { entityId: giltLedgerId, topic: 'business', accessLevel: 'known',
      content: 'The principal lender of the harbor; its brass plaques hang on half the counting-houses of Cinderquay.' },
  ])

  await entities.insert(pool, {
    id: drownedCourtId, worldId, entityType: 'faction',
    name: 'The Drowned Court', accessLevel: 'known', createdIn: 'stage:world_and_factions',
  })
  await proseKernels.insert(pool, {
    entityId: drownedCourtId,
    content:
      'The Drowned Court presents itself to the city as a benevolent brotherhood of retired sailors — a public, respectable face. Beneath it they are the harbor\'s smuggling ring. They are rumored to keep a hideout somewhere under Cinderquay, though no watch patrol has found it. Their operations run on money the Gilt Ledger secretly provides and on the cargo Harbormaster Vell secretly waves through the tide-gates.',
  })
  await facts.insertMany(pool, [
    { entityId: drownedCourtId, topic: 'public_face', accessLevel: 'known',
      content: 'Publicly a charitable society of old sailors; widely respected at civic functions.' },
  ])

  // ----- npc -----
  await entities.insert(pool, {
    id: harbormasterVellId, worldId, entityType: 'npc',
    name: 'Harbormaster Vell', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: harbormasterVellId,
    content:
      'Harbormaster Vell is the city\'s honest-seeming master of the tide-gates, a public servant of the Tidewardens. His public reputation is spotless. Secretly he is in the pay of The Drowned Court, opening the tide-gates for their cargo on moonless nights; and secretly he is deep in debt to the Gilt Ledger, which is the lever that first bent him.',
  })
  await facts.insertMany(pool, [
    { entityId: harbormasterVellId, topic: 'office', accessLevel: 'known',
      content: 'Keeper of the tide-gates; answers publicly to the Tidewardens.' },
  ])

  // ----- locations -----
  await entities.insert(pool, {
    id: cinderquayId, worldId, entityType: 'location',
    name: 'Cinderquay', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: cinderquayId,
    content:
      'Cinderquay is the old dock district, openly controlled by the Tidewardens. Its counting-houses bear the Gilt Ledger\'s brass. Somewhere beneath its half-flooded cellars the Drowned Court is rumored to meet.',
  })

  await entities.insert(pool, {
    id: saltglassId, worldId, entityType: 'location',
    name: 'The Saltglass Lighthouse', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: saltglassId,
    content:
      'The Saltglass Lighthouse stands at the mouth of the harbor, kept lit by the Tidewardens. Its beam is the last thing a smuggler\'s boat needs dark, and some say Harbormaster Vell knows which nights it is left to gutter.',
  })

  return {
    userId, worldId, campaignId,
    tidewardensId, giltLedgerId, drownedCourtId,
    harbormasterVellId, cinderquayId, saltglassId,
  }
}

interface TieredRelationshipRow {
  readonly relationship_type: string
  readonly access_level: string
}

async function readAllRelationships(
  pool: Pool,
  worldId: string,
): Promise<readonly TieredRelationshipRow[]> {
  const r = await pool.query<TieredRelationshipRow>(
    `SELECT rel.relationship_type, rel.access_level
       FROM relationships rel
       JOIN entities e ON e.id = rel.source_entity_id
      WHERE e.world_id = $1
      ORDER BY rel.access_level, rel.relationship_type`,
    [worldId],
  )
  return r.rows
}

interface TierDist {
  known: number
  discoverable: number
  secret: number
}

function tierDistribution(rows: readonly TieredRelationshipRow[]): TierDist {
  const dist: TierDist = { known: 0, discoverable: 0, secret: 0 }
  for (const row of rows) {
    if (row.access_level === 'known') dist.known += 1
    else if (row.access_level === 'discoverable') dist.discoverable += 1
    else if (row.access_level === 'secret') dist.secret += 1
  }
  return dist
}

async function main(): Promise<void> {
  const startedAt = Date.now()
  const env = loadEnv()
  const pool = new Pool({ connectionString: env.databaseUrl })
  const keyPrefix = env.redisKeyPrefix
  const realtimePub = new Redis(env.redisRealtimeUrl)

  try {
    log('cleanup: removing any prior smoke-rel-tier-1 state')
    await cleanupPriorState(pool)

    log('seed: writing end-of-stage-3 state (all-known entities, secrecy in the prose)')
    const seeded = await seedEndOfStage3(pool)
    log(`seeded worldId=${seeded.worldId} campaignId=${seeded.campaignId}`)

    const vocab = (
      await pool.query<{ vocabulary_registry: VocabularyRegistry }>(
        `SELECT vocabulary_registry FROM worlds WHERE id = $1`,
        [seeded.worldId],
      )
    ).rows[0]?.vocabulary_registry as VocabularyRegistry

    // ------- STAGE 4 (REAL LLM) -------
    log('stage 4: invoking runEntityRelationshipsStage (real Anthropic Sonnet)')
    await runEntityRelationshipsStage(createRepo(pool), {
      campaignId: seeded.campaignId,
      worldId: seeded.worldId,
      worldName: WORLD_NAME,
      tone: TONE,
      themes: THEMES,
      keyTensions: KEY_TENSIONS,
      vocabularyRegistry: vocab,
      job: { updateProgress: async () => Promise.resolve() },
      redisRealtime: realtimePub,
      keyPrefix,
      // Persistence is tier-agnostic regardless of this flag; false mirrors a
      // production enforced-ignorance reveal (only known-between-known edges
      // would surface on the wire feed — which this smoke does not consume).
      bypassAccessFilter: false,
    })

    if (Date.now() - startedAt > WALL_CLOCK_BUDGET_MS) {
      throw new Error(`wall-clock budget exceeded (${String(WALL_CLOCK_BUDGET_MS)}ms) during stage 4`)
    }

    // ------- OBSERVE THE EMITTED TIER DISTRIBUTION -------
    const persisted = await readAllRelationships(pool, seeded.worldId)
    const dist = tierDistribution(persisted)
    log(
      `stage 4 done: persisted relationships=${String(persisted.length)} ` +
      `tierDistribution known=${String(dist.known)} discoverable=${String(dist.discoverable)} secret=${String(dist.secret)}`,
    )

    // Schema requires ≥5 relationships; a healthy generation persists several
    // real→real edges. Zero would mean the persist path is broken.
    if (persisted.length === 0) {
      throw new Error('stage 4 persisted zero relationships — the persist path is broken')
    }
    // Every persisted tier must be a valid enum value (A2/A3 schema guarantee;
    // asserted here as a wire-level check that the column round-trips).
    const invalid = persisted.filter(
      (r) => !['known', 'discoverable', 'secret'].includes(r.access_level),
    )
    if (invalid.length > 0) {
      throw new Error(`persisted relationships carry invalid access_level: ${JSON.stringify(invalid)}`)
    }
    const nonKnownFromLlm = dist.discoverable + dist.secret
    if (nonKnownFromLlm > 0) {
      log(`observation: LLM emitted ${String(nonKnownFromLlm)} non-known relationship(s) — the tier mix is live`)
    } else {
      log(
        'observation: LLM emitted ALL-known this run (NOT an A5 blocker — the ' +
        'deterministic repo/view tests are the security guarantee). Seeding an ' +
        'explicit secret edge below still exercises the exclusion.',
      )
    }

    // ------- SEED AN EXPLICIT SECRET EDGE BETWEEN TWO KNOWN ENTITIES -------
    // Guarantees the exclusion is exercised even if this generation emitted no
    // secrets. Both endpoints are `known`, so ONLY the edge's own tier can hide
    // it. Seeded AFTER stage 4 because the stage wipes prior relationships on
    // its idempotency delete at persist start.
    log('seed: inserting one explicit secret relationship between two known entities')
    await pool.query(
      `INSERT INTO relationships
         (id, source_entity_id, target_entity_id, relationship_type, description, access_level, synth_key)
       VALUES ($1, $2, $3, $4, $5, 'secret', $6)`,
      [
        uuidv7(),
        seeded.giltLedgerId,
        seeded.drownedCourtId,
        SECRET_MARKER_PREDICATE,
        'The Gilt Ledger secretly bankrolls The Drowned Court (smoke-seeded secret edge).',
        'smoke/secret-marker/0',
      ],
    )

    // ------- THE SECURITY GATE: NON-BYPASS OWNER REVEAL SNAPSHOT -------
    log('snapshot: fetching owner reveal snapshot (bypass:false)')
    const revealed = await worldSnapshotView.fetch(pool, seeded.worldId, { bypass: false })

    const revealNonKnown = revealed.relationships.filter((r) => r.accessLevel !== 'known')
    if (revealNonKnown.length > 0) {
      throw new Error(
        `SECURITY FAILURE — non-known relationships surfaced in the reveal snapshot: ` +
        JSON.stringify(revealNonKnown.map((r) => ({ type: r.relationshipType, tier: r.accessLevel }))),
      )
    }
    const markerInReveal = revealed.relationships.some(
      (r) => r.relationshipType === SECRET_MARKER_PREDICATE,
    )
    if (markerInReveal) {
      throw new Error('SECURITY FAILURE — the seeded secret marker edge surfaced in the non-bypass snapshot')
    }
    log(
      `assertion: reveal snapshot relationships=${String(revealed.relationships.length)}, ` +
      `ALL known-tier, secret marker EXCLUDED ✓`,
    )

    // Sanity: the reveal snapshot's relationship count must equal the DB count
    // of known-tier relationships (all endpoints are known, so listAmong's
    // endpoint filter never drops one — the tier filter is the only difference).
    const knownInDb = dist.known
    if (revealed.relationships.length !== knownInDb) {
      throw new Error(
        `reveal snapshot known count=${String(revealed.relationships.length)} != DB known count=${String(knownInDb)} ` +
        `(all entities are known, so these must match)`,
      )
    }
    log(`assertion: reveal known count matches DB known count (${String(knownInDb)}) ✓`)

    // ------- BYPASS WIDENS: the secret marker IS visible under bypass -------
    log('snapshot: fetching bypass snapshot (bypass:true)')
    const bypassed = await worldSnapshotView.fetch(pool, seeded.worldId, { bypass: true })
    const markerInBypass = bypassed.relationships.some(
      (r) => r.relationshipType === SECRET_MARKER_PREDICATE,
    )
    if (!markerInBypass) {
      throw new Error('the seeded secret marker edge did NOT surface under bypass — bypass widening is broken')
    }
    if (bypassed.relationships.length <= revealed.relationships.length) {
      throw new Error(
        `bypass snapshot (${String(bypassed.relationships.length)}) should surface MORE relationships than ` +
        `the reveal snapshot (${String(revealed.relationships.length)}) — the seeded secret alone widens it`,
      )
    }
    log(
      `assertion: bypass snapshot relationships=${String(bypassed.relationships.length)}, ` +
      `secret marker INCLUDED, widened over reveal ✓`,
    )

    log(`SMOKE PASSED — relationship tiering + reveal-snapshot security gate verified end-to-end (${String(Date.now() - startedAt)}ms)`)

    // ------- CLEANUP -------
    log('cleanup: removing the smoke world')
    await cleanupPriorState(pool)
    log('cleanup: done')
  } finally {
    realtimePub.disconnect()
    await pool.end()
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
  process.exit(1)
})
