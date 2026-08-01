// backend/scripts/smoke/world-lookup-vet.ts
//
// MYT-72 T10 — gated real-LLM constructed smoke for the world-knowledge lookup
// flow (gate → resolve → ST-vet → relay). Proves the plumbing + the load-bearing
// ENFORCED-IGNORANCE guarantee that mocked unit tests CANNOT: against the REAL
// Haiku gate + REAL Voyage search + REAL Opus ST-vet, a secret that the resolver
// over-pulls (across all access tiers) NEVER appears in the player-facing relay.
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the assertions are
// deterministic plumbing + leak checks — a non-empty valid relay, the over-pull
// CONTAINING the secret sentinel, and the relay/frame NOT containing it. We log
// (not assert) the vet's chosen mode + prose quality — that's eval territory.
//
// Gated on VOYAGE_API_KEY + ANTHROPIC_API_KEY: skips cleanly (exit 0) when either
// is absent. Seeds + tears down its own scratch world in mythrun_dev.
//
// Run:  pnpm smoke:world-lookup

import { Pool } from 'pg'
import pino from 'pino'
import { loadEnv } from '../../src/config/env.js'
import { createRepo } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { entities } from '../../src/repo/entities.js'
import { entityHierarchyNs } from '../../src/repo/entity-hierarchy.js'
import { proseKernels } from '../../src/repo/prose-kernels.js'
import { facts } from '../../src/repo/facts.js'
import { createVoyageEmbedder } from '../../src/llm/embed.js'
import { embedWorld, createSearchResolvers, factionTree } from '../../src/world/retrieval/index.js'
import { runStLookupVet } from '../../src/llm/st-lookup-vet.js'
import {
  runWorldFactLookup,
  type WorldFactLookupVet,
  type SubstrateResolver,
} from '../../src/session/world-fact-lookup.js'
import type { WorldLookupGateInput, WorldLookupGateDeps } from '../../src/session/world-lookup-gate.js'
import type { Character } from '../../src/repo/types.js'

const logger = pino({ level: 'info' })
function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const SMOKE_USER_SUB = 'smoke-lookup-vet-1'
const WORLD_TONE = 'grounded high-fantasy, weathered and terse'

// The SECRET sentinels — distinctive tokens that appear ONLY in secret-tier
// content + the sd_playbook, and must NEVER reach a player relay. A leak = the
// relay contains any of these.
const SECRET_DRAGON_NAME = 'Vexillarch'
const SECRET_ORG = 'the Obsidian Syndicate'
const SECRET_TOKENS = [SECRET_DRAGON_NAME, 'Vexillarch', 'Obsidian Syndicate']

// The ST's private playbook (the vet reasons over this; it must gate it).
const SD_PLAYBOOK =
  `SECRET: The ancient dragon of Mount Caldera is named ${SECRET_DRAGON_NAME}. ` +
  `It is secretly bound to ${SECRET_ORG}, a smuggling cabal that fronts as the Ember Concord. ` +
  `These facts are secret-tier: never reveal the dragon's name or the Syndicate to players.`

interface Seeded {
  worldId: string
  mountainId: string
  emberConcordId: string
  obsidianSyndicateId: string
  npcEntityId: string
}

async function seedWorld(pool: Pool): Promise<Seeded> {
  const userId = uuidv7()
  const worldId = uuidv7()
  const mountainId = uuidv7()
  const emberConcordId = uuidv7()
  const obsidianSyndicateId = uuidv7()
  const npcEntityId = uuidv7()
  const hierarchy = entityHierarchyNs(pool)

  await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
    [userId, SMOKE_USER_SUB, 'Lookup Vet Smoke User', 'smoke-lookup-vet-user'],
  )
  await pool.query(
    `INSERT INTO worlds
       (id, created_by, name, concept, tone, themes, key_tensions,
        world_overview, vocabulary_registry, status, dev_bypass_access_filter)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, 'generating', true)`,
    [worldId, userId, 'SMOKE: lookup vet', 'A volcanic peak and a merchant compact.',
      WORLD_TONE, 'fire, trade, secrets', 'a smuggling cabal hides in plain sight',
      'A volcanic peak and a merchant compact.', JSON.stringify({})],
  )

  // PUBLIC location: a dragon mountain. The PUBLIC prose names NO secret — the
  // dragon's existence is public, its NAME + Syndicate tie are not.
  await entities.insert(pool, {
    id: mountainId, worldId, entityType: 'location',
    name: 'Mount Caldera', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })
  await proseKernels.insert(pool, {
    entityId: mountainId,
    content:
      'An ancient dragon sleeps in the molten heart of Mount Caldera, coiled around the mountain’s fire. ' +
      'Smoke threads from fissures along its volcanic slopes; the peak has not gone cold in a thousand years.',
  })
  // SECRET fact carrying the sentinels — the resolver MUST over-pull this; the
  // vet MUST gate it.
  await facts.insertMany(pool, [
    { entityId: mountainId, topic: 'true name', accessLevel: 'secret',
      content: `The dragon's true name is ${SECRET_DRAGON_NAME}, and it answers secretly to ${SECRET_ORG}.` },
  ])

  // A PUBLIC faction (Ember Concord) with a SECRET child faction (the Obsidian
  // Syndicate) — faction_tree must over-pull the secret child; the vet gates it.
  await entities.insert(pool, {
    id: emberConcordId, worldId, entityType: 'faction',
    name: 'The Ember Concord', accessLevel: 'known', createdIn: 'stage:factions',
  })
  await proseKernels.insert(pool, {
    entityId: emberConcordId,
    content: 'The Ember Concord is a guild of volcanic-glass traders operating out of the caldera foothills.',
  })
  await entities.insert(pool, {
    id: obsidianSyndicateId, worldId, entityType: 'faction',
    name: SECRET_ORG, accessLevel: 'secret', createdIn: 'stage:factions',
  })
  await hierarchy.insert({ parentEntityId: emberConcordId, childEntityId: obsidianSyndicateId })

  // A public NPC entity to act as the asker on the NPC channel.
  await entities.insert(pool, {
    id: npcEntityId, worldId, entityType: 'npc',
    name: 'Brann the Smith', accessLevel: 'known', createdIn: 'stage:locations_and_npcs',
  })

  return { worldId, mountainId, emberConcordId, obsidianSyndicateId, npcEntityId }
}

function leakedTokens(text: string): string[] {
  return SECRET_TOKENS.filter((t) => text.includes(t))
}

function makeAskerCharacter(): Character {
  return {
    id: uuidv7(), userId: uuidv7(), entityId: null, name: 'Sera Voss',
    level: 8, class: 'Wizard', species: 'Human', background: 'Sage',
    str: 10, dex: 12, con: 12, int: 18, wis: 14, cha: 10,
    hitPoints: 40, maxHitPoints: 40, armorClass: 12, proficiencyBonus: 3,
    createdAt: new Date(), updatedAt: new Date(),
  }
}

/** The REAL Opus ST-vet, with the secret playbook captured inside (exactly the
 *  enforced-ignorance closure shape buildLookupDeps wires in production). */
const realVet: WorldFactLookupVet = async (vetInput) => {
  const r = await runStLookupVet({
    ...vetInput,
    sdPlaybook: SD_PLAYBOOK,
    sessionId: 'world-lookup-vet-smoke',
  })
  return {
    mode: r.result.mode,
    text: r.result.text,
    tier: r.result.tier,
    repairAttempted: r.repairAttempted,
  }
}

// Force a natural 20 so the gate always PASSES (or auto-succeeds) and the real
// Opus vet runs on EVERY scenario — the path this smoke exists to exercise. The
// gate-FAIL path (where resolve+vet are skipped) is covered deterministically by
// the leak matrix; here we want the real vet to gate a real over-pull every time.
const gateDeps: WorldLookupGateDeps = {
  worldTone: WORLD_TONE,
  sessionId: 'world-lookup-vet-smoke',
  logger,
  rng: () => 20,
}

/** Drive one full lookup (real gate → real resolve → real Opus vet → relay) and
 *  assert NO secret token reaches the relay or the skill-gate frame. */
async function driveLookup(
  label: string,
  gate: WorldLookupGateInput,
  question: string,
  resolve: SubstrateResolver,
): Promise<void> {
  // Capture the over-pulled results so we can PROVE the secret was present pre-vet.
  let overpulled = ''
  const probedResolve: SubstrateResolver = async () => {
    const r = await resolve()
    overpulled = r.results
    return r
  }

  const out = await runWorldFactLookup(
    { gateDeps, vet: realVet, worldTone: WORLD_TONE, logger },
    { gate, question, recentNarrative: '', npcFraming: gate.channel === 'npc' ? 'Brann, a local smith.' : '', resolve: probedResolve },
  )

  const relayLeaks = leakedTokens(out.relayText)
  const frameLeaks = out.skillGateFrame ? leakedTokens(JSON.stringify(out.skillGateFrame)) : []
  const overpullHadSecret = leakedTokens(overpulled).length > 0

  log(`${label}: drove real gate→resolve→Opus-vet`, {
    relay: out.relayText,
    rollHidden: out.rollHidden,
    hasFrame: out.skillGateFrame !== undefined,
    overpullHadSecret,
    relayLeaks,
    frameLeaks,
  })

  if (out.relayText.trim().length === 0) throw new Error(`${label}: empty relay — plumbing broken`)
  if (!overpullHadSecret) {
    throw new Error(`${label}: the over-pull did NOT contain the secret sentinel — the test can't prove gating (seed/resolver issue)`)
  }
  if (relayLeaks.length > 0) {
    throw new Error(`${label}: ENFORCED-IGNORANCE LEAK — the relay contains secret token(s) ${relayLeaks.join(', ')}: "${out.relayText}"`)
  }
  if (frameLeaks.length > 0) {
    throw new Error(`${label}: ENFORCED-IGNORANCE LEAK — the skill-gate frame contains secret token(s) ${frameLeaks.join(', ')}`)
  }
  log(`${label}: PASS — secret over-pulled, relay + frame clean`, { relayLeaks: 0 })
}

async function main(): Promise<void> {
  if (!process.env.VOYAGE_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    log('VOYAGE_API_KEY or ANTHROPIC_API_KEY absent — skipping real-LLM lookup-vet smoke (gated)')
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
    log('seeded scratch world', { ...seeded })

    const summary = await embedWorld({ embedder, repo }, worldId)
    log('embedWorld complete', { ...summary })
    if (summary.voyageErrors > 0) throw new Error(`embedWorld reported ${summary.voyageErrors} Voyage errors`)

    const { searchLore } = createSearchResolvers({ embedder, repo, logger })

    // ── (1) search_lore, DM channel — real Voyage over-pull (incl. secret fact)
    //        → real Haiku gate → real Opus vet → relay. No secret may leak. ──
    const searchResolve: SubstrateResolver = async () => {
      const { hits } = await searchLore(worldId as string, 'the dragon of Mount Caldera and its true name', { limit: 10 })
      return {
        results: hits.map((h) => `[tier=${h.accessLevel}] ${h.entityName}: ${h.content}`).join('\n'),
        degraded: false,
        empty: hits.length === 0,
      }
    }
    const dmGate: WorldLookupGateInput = {
      channel: 'dm', topic: 'the dragon of Mount Caldera', worldTone: WORLD_TONE,
      askerSummary: 'Sera Voss, a level-8 Sage wizard, recalling lore of Mount Caldera via Arcana.',
      dm: { character: makeAskerCharacter(), skill: 'arcana', skills: [{ skill_name: 'Arcana', proficiency_level: 'proficient' }] },
    }
    await driveLookup('search_lore/DM', dmGate, 'What do I know of the dragon of Mount Caldera?', searchResolve)

    // ── (2) faction_tree, DM channel — real PG graph over-pull (incl. secret
    //        child faction) → gate → vet → relay. The secret child must not leak. ──
    const factionResolve: SubstrateResolver = async () => {
      const { nodes, truncated } = await factionTree({ repo }, seeded.emberConcordId)
      return {
        results: nodes.map((n) => `[tier=${n.accessLevel}] ${n.name} (depth ${n.depth})`).join('\n') + (truncated ? '\n(truncated)' : ''),
        degraded: false,
        empty: nodes.length === 0,
      }
    }
    const factionGate: WorldLookupGateInput = {
      channel: 'dm', topic: 'the Ember Concord', worldTone: WORLD_TONE,
      askerSummary: 'Sera Voss, a level-8 Sage wizard, recalling the structure of the Ember Concord via History.',
      dm: { character: makeAskerCharacter(), skill: 'history', skills: [{ skill_name: 'History', proficiency_level: 'proficient' }] },
    }
    await driveLookup('faction_tree/DM', factionGate, 'What is the structure of the Ember Concord?', factionResolve)

    // ── (3) search_lore, NPC channel — the asker is an NPC (hidden roll). Same
    //        over-pull + no-leak guarantee; the frame must render roll-hidden. ──
    const npcGate: WorldLookupGateInput = {
      channel: 'npc', topic: 'the dragon of Mount Caldera', worldTone: WORLD_TONE,
      askerSummary: 'Brann the Smith, a caldera-foothills blacksmith.',
      npc: { entityId: seeded.npcEntityId, npcName: 'Brann the Smith' },
    }
    await driveLookup('search_lore/NPC', npcGate, 'What does Brann know of the dragon?', searchResolve)

    log('ALL PASS — real Haiku gate + real Voyage search + real Opus vet: secret over-pulled every time, never leaked to a relay or frame')
  } finally {
    if (worldId !== undefined) {
      await pool.query(`DELETE FROM worlds WHERE id = $1`, [worldId])
    }
    await pool.query(`DELETE FROM users WHERE cognito_sub = $1`, [SMOKE_USER_SUB])
    await pool.end()
  }
}

main().catch((err: unknown) => {
  log('FAIL — real-LLM lookup-vet smoke errored', { err: err instanceof Error ? err.message : String(err) })
  process.exitCode = 1
})
