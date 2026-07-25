// backend/scripts/smoke/guided-subclass-smoke.ts — constructed-state real-LLM smoke for myth-4jhrk.
//
// Reproduces run 2's exact scenario (level-3 Human Cleric, Hermit, guided pick
// "Life Domain") through the REAL pipeline (real Sonnet, mythrun_dev) and
// asserts the persisted features NAME the pinned subclass — the defect run 2
// surfaced was Grave Domain features overriding an explicit Life Domain pick.
//
// Usage (from backend/): tsx --env-file=.env.development scripts/smoke/guided-subclass-smoke.ts [worldId]

import type { Pool } from 'pg'
import { createPgPool } from '../../src/db/postgres.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { runCharacterCreationJob } from '../../src/llm/prep/character-creation-processor.js'

const WORLD_ID = process.argv[2] ?? '019f4242-fa95-71ba-9f86-cc1cd23cc570'
const TAG = `guidedsmoke-${Date.now().toString(36)}`

const GUIDED = {
  class: 'Cleric',
  subclass: 'Life Domain',
  species: 'Human',
  background: 'Hermit',
}

const CONCEPT_TEXT =
  'A quiet tide-keeper who has spent years washing the palms of drowned statues and reading schedules cut into wet stone. Human. Cleric (Life Domain). Hermit background. They believe the water is patient and that tending things is a form of prayer.'
const GROUNDING_TEXT =
  'They are ankle-deep at the drain, facing the three smooth-faced statues, when the story opens.'

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') throw new Error('DATABASE_URL not set')
  const pool: Pool = createPgPool(databaseUrl)
  const userId = uuidv7()
  const campaignId = uuidv7()
  let exitCode = 0
  try {
    await pool.query(
      `INSERT INTO users (id, cognito_sub, display_name, username) VALUES ($1, $2, $3, $4)`,
      [userId, `${TAG}-sub`, `${TAG} player`, `${TAG}_u`],
    )
    await pool.query(
      `INSERT INTO campaigns (id, world_id, created_by, name, starting_situation_index, starting_level)
         VALUES ($1, $2, $3, $4, 0, 3)`,
      [campaignId, WORLD_ID, userId, `${TAG} guided cleric`],
    )
    await pool.query(
      `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
         VALUES ($1, $2, $3, 'owner', true)`,
      [uuidv7(), campaignId, userId],
    )
    await pool.query(
      `INSERT INTO character_concepts (
         id, campaign_id, user_id, concept_text, situation_grounding_text, guided_choices, status
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'processing')`,
      [uuidv7(), campaignId, userId, CONCEPT_TEXT, GROUNDING_TEXT, JSON.stringify(GUIDED)],
    )

    const t0 = Date.now()
    await runCharacterCreationJob(
      {
        pool,
        costCapUsd: 50,
        publishEvent: () => Promise.resolve(),
      },
      {
        data: { campaignId, userId },
        updateProgress: () => Promise.resolve(),
        name: 'character-creation',
      },
    )
    console.log(`pipeline completed in ${String(Math.round((Date.now() - t0) / 1000))}s`)

    const char = await pool.query<{ id: string; name: string; class: string; species: string; level: number }>(
      `SELECT c.id, c.name, c.class, c.species, c.level
         FROM characters c JOIN campaign_characters cc ON cc.character_id = c.id
        WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
      [campaignId, userId],
    )
    const row = char.rows[0]
    if (row === undefined) throw new Error('no persisted character row')
    console.log(`persisted: ${row.name} — level ${String(row.level)} ${row.species} ${row.class}`)

    const feats = await pool.query<{ feature_name: string; description: string }>(
      `SELECT feature_name, description FROM character_features WHERE character_id = $1`,
      [row.id],
    )
    const all = feats.rows.map((f) => `${f.feature_name}: ${f.description}`).join('\n')
    const namesLife = feats.rows.some(
      (f) => f.feature_name.includes('Life Domain') || f.description.includes('Life Domain'),
    )
    const anyGrave = /grave domain|path to the grave|circle of mortality/i.test(all)

    console.log('\nFEATURES:')
    for (const f of feats.rows) console.log(`  - ${f.feature_name}`)
    console.log(`\n${namesLife ? '✅' : '❌'} a feature names the pinned subclass "Life Domain"`)
    console.log(`${anyGrave ? '❌ GRAVE DOMAIN CONTENT PRESENT' : '✅ no Grave Domain content'}`)
    console.log(`class persisted as Cleric: ${row.class === 'Cleric' ? '✅' : `❌ (${row.class})`}`)
    console.log(`species persisted as Human: ${row.species === 'Human' ? '✅' : `❌ (${row.species})`}`)

    if (!namesLife || anyGrave || row.class !== 'Cleric') exitCode = 1
  } finally {
    // Ephemeral cleanup: cascade from the campaign + user (FK order matters).
    try {
      const ch = await pool.query<{ character_id: string }>(
        `SELECT character_id FROM campaign_characters WHERE campaign_id = $1`,
        [campaignId],
      )
      for (const r of ch.rows) {
        await pool.query(`DELETE FROM campaign_characters WHERE character_id = $1`, [r.character_id])
        await pool.query(`DELETE FROM characters WHERE id = $1`, [r.character_id])
      }
      await pool.query(`DELETE FROM character_concepts WHERE campaign_id = $1`, [campaignId])
      await pool.query(`DELETE FROM campaign_members WHERE campaign_id = $1`, [campaignId])
      await pool.query(`DELETE FROM campaigns WHERE id = $1`, [campaignId])
      await pool.query(`DELETE FROM users WHERE id = $1`, [userId])
    } catch (e) {
      console.error('cleanup error (rows may linger, grep tag):', TAG, e)
    }
    await pool.end()
  }
  process.exit(exitCode)
}

main().catch((e: unknown) => {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
})
