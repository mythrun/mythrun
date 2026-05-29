// MYT-57: focused test for loadStartingSituationInputs.
//
// Pre-fix the dispatcher arm passed '(stage not implemented yet)' for all
// three summary fields, which (combined with the in-stage constrained-name
// retry) silently survived most worlds but broke ones with high thematic
// pull toward non-location entities (e.g. haunted-carnival, whose carnival
// thematic anchor sits in faction + NPC buckets). The fix loads the real
// entity summaries from the DB.
//
// This test seeds a fixture mirroring haunted-carnival's bucket shape and
// asserts the loader returns the canonical "- Name: prose" bulleted list
// per kind, with NPCs and factions distinct from locations.

import { describe, it, expect, afterAll } from 'vitest'
import { type Pool } from 'pg'
import { createTestPool } from '../../../repo/__tests__/_helpers/test-pool.js'
import { makeTestScope, cleanupTestScope } from '../../../repo/__tests__/_helpers/test-scope.js'
import { uuidv7 } from '../../../repo/uuidv7.js'
import { loadStartingSituationInputs } from '../world-gen-processor.js'

interface SeedRow {
  readonly name: string
  readonly entity_type: 'location' | 'npc' | 'faction'
  readonly prose: string
}

const HAUNTED_CARNIVAL_FIXTURE: readonly SeedRow[] = [
  { name: 'Hollowfrost and the Crossroads Proper', entity_type: 'location', prose: 'A weathered crossroads village ringed by mire and frost-stricken fields.' },
  { name: 'The Tallow Wood', entity_type: 'location', prose: 'An old forest where the light fades early and the trees lean inward.' },
  { name: 'The Parish Church of Hollowfrost', entity_type: 'location', prose: 'A stone-bones chapel that has buried more than it has baptized.' },
  // Factions whose names overlap with the location bucket above — this is
  // the haunted-carnival ambiguity the placeholder bug couldn't survive.
  { name: 'The Parish of Hollowfrost', entity_type: 'faction', prose: 'The lay-administrative body of the church; not the building itself.' },
  { name: 'The Wonder-Workers', entity_type: 'faction', prose: 'The carnival itself: performers, roustabouts, an unspoken hierarchy.' },
  { name: 'The Card-Reader', entity_type: 'npc', prose: 'A laconic fortune-teller whose accuracy people remember selectively.' },
  { name: 'The Beast-Handler', entity_type: 'npc', prose: 'The one with the answers to the questions about the wagons after dark.' },
]

describe('loadStartingSituationInputs (MYT-57)', () => {
  const pool: Pool = createTestPool(process.env.DATABASE_URL ?? '')
  const scope = makeTestScope('myt-57-loader')

  afterAll(async () => {
    await cleanupTestScope(pool, scope)
    await pool.end()
  })

  let userIndex = 0
  async function seedFixture(rows: readonly SeedRow[]): Promise<{ worldId: string }> {
    const userId = uuidv7()
    const worldId = uuidv7()
    const idx = userIndex++
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
      [userId, scope.userSub(idx), scope.displayName(idx), scope.username(idx)],
    )
    await pool.query(
      `INSERT INTO worlds (id, created_by, name, concept, status)
       VALUES ($1, $2, $3, 'fixture-concept', 'generating')`,
      [worldId, userId, scope.worldName(idx)],
    )
    for (const row of rows) {
      const entityId = uuidv7()
      await pool.query(
        `INSERT INTO entities (id, world_id, name, entity_type, access_level, created_in)
         VALUES ($1, $2, $3, $4, 'known', 'stage:world_and_factions')`,
        [entityId, worldId, row.name, row.entity_type],
      )
      await pool.query(
        `INSERT INTO prose_kernels (id, entity_id, content)
         VALUES ($1, $2, $3)`,
        [uuidv7(), entityId, row.prose],
      )
    }
    return { worldId }
  }

  it('returns one bulleted "- name: prose" line per kind, separated by bucket', async () => {
    const { worldId } = await seedFixture(HAUNTED_CARNIVAL_FIXTURE)
    const client = await pool.connect()
    try {
      const inputs = await loadStartingSituationInputs(client, worldId)

      // Locations: 3 entries, all the real location names, NOT factions or NPCs.
      const locLines = inputs.locationsSummary.split('\n')
      expect(locLines).toHaveLength(3)
      expect(locLines[0]).toMatch(/^- Hollowfrost and the Crossroads Proper:/)
      expect(locLines).toEqual(expect.arrayContaining([
        expect.stringMatching(/^- The Tallow Wood:/),
        expect.stringMatching(/^- The Parish Church of Hollowfrost:/),
      ]))
      // Critically: location bucket does NOT contain the look-alike faction.
      expect(inputs.locationsSummary).not.toContain('The Parish of Hollowfrost:')
      expect(inputs.locationsSummary).not.toContain('The Wonder-Workers')

      // Factions: 2 entries
      expect(inputs.factionsSummary.split('\n')).toHaveLength(2)
      expect(inputs.factionsSummary).toContain('- The Parish of Hollowfrost:')
      expect(inputs.factionsSummary).toContain('- The Wonder-Workers:')

      // NPCs: 2 entries
      expect(inputs.npcsSummary.split('\n')).toHaveLength(2)
      expect(inputs.npcsSummary).toContain('- The Card-Reader:')
      expect(inputs.npcsSummary).toContain('- The Beast-Handler:')
    } finally {
      client.release()
    }
  })

  it('renders empty buckets as "(none)" so the prompt section headers stay grammatical', async () => {
    // Seed just one NPC, no locations or factions.
    const { worldId } = await seedFixture([
      { name: 'The Only Stranger', entity_type: 'npc', prose: 'A wandering hand with calluses.' },
    ])
    const client = await pool.connect()
    try {
      const inputs = await loadStartingSituationInputs(client, worldId)
      expect(inputs.locationsSummary).toBe('(none)')
      expect(inputs.factionsSummary).toBe('(none)')
      expect(inputs.npcsSummary).toBe('- The Only Stranger: A wandering hand with calluses.')
    } finally {
      client.release()
    }
  })
})
