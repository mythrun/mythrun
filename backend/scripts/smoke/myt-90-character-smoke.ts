// backend/scripts/smoke/myt-90-character-smoke.ts
//
// MYT-90 A9: constructed-state real-LLM smoke for the character-creation
// pipeline. Proves the backend generation path (A4 deterministic level
// injection, A5 strengthened validateCoherence, A6 situation invitation)
// against REAL Anthropic + real Postgres (mythrun_dev) — not mocks.
//
// For each of levels 1, 5 (and an optional level-2 wizard for the
// subclass-at-2 path) it:
//   1. seeds an ephemeral user + campaign (status setup, starting_level=L,
//      starting_situation_index=0) + a character_concepts row against an
//      EXISTING completed world (rich vocabulary_registry + real situation
//      entries — the world itself is NOT mutated by character gen);
//   2. runs the REAL `runCharacterCreationJob` (concept → sheet, real
//      Sonnet) end-to-end;
//   3. asserts the persisted `characters` row: level === startingLevel (the
//      A4 injection invariant) AND the persisted sheet round-trips
//      schema-valid AND passes `validateCoherence(sheet, L)` (A5);
//   4. prints the full sheet for a human register/quality eyeball.
//
// Then it runs the REAL `runStartingSituationStage` (A6) against the world's
// entity summaries and asserts every generated `invitation` is non-trivial +
// 2nd-person, printing them for register eyeball. The world's
// starting_situations columns are snapshotted before and restored after, so
// the shared dev world is left pristine.
//
// Smoke vs eval (feedback_smoke_vs_eval): this asserts DB/pipeline plumbing +
// mechanical VALIDITY AT LEVEL (an under-leveled but internally-coherent sheet
// still passes — that is the honest limit; qualitative quality rides on the
// prompt and is judged by the printed dump). If level-5 generation is
// unreliable (terminal-fail / repeated coherence regeneration) the script
// SURFACES it as a finding rather than reducing scope (root-cause-first).
//
// Usage (from backend/):
//   tsx --env-file=.env.development scripts/smoke/myt-90-character-smoke.ts [worldId]
// Requires: mythrun_dev up with a completed world; ANTHROPIC_API_KEY in env.
// Cost: ~$0.10–3 of Anthropic (a handful of real Sonnet calls). Expected.

import type { Pool } from 'pg'
import { createPgPool } from '../../src/db/postgres.js'
import { createRepo } from '../../src/repo/index.js'
import { uuidv7 } from '../../src/repo/uuidv7.js'
import { runCharacterCreationJob } from '../../src/llm/prep/character-creation-processor.js'
import { validateCoherence } from '../../src/llm/prep/stages/character-sheet.js'
import { runStartingSituationStage } from '../../src/llm/prep/stages/starting-situation.js'
import { loadStartingSituationInputs } from '../../src/llm/prep/world-gen-processor.js'
import {
  CharacterSheetOutputSchema,
  type CharacterSheetOutput,
} from '../../src/llm/schemas/character-sheet.js'
import { VocabularyRegistrySchema } from '../../src/llm/schemas/vocabulary-registry.js'

// Default: "The Rust-Iron Marches" — the intro smoke's reference world (rich
// vocabulary_registry + 3 real starting_situation_entries whose location
// entities still resolve). Any status='complete' world with situation entries
// works; override via argv[2].
const WORLD_ID = process.argv[2] ?? '019f4242-fa95-71ba-9f86-cc1cd23cc570'

// One shared unique tag per run so ephemeral users/campaigns are grep-able and
// cleaned up deterministically even if the process is killed mid-run.
const TAG = `myt90smoke-${Date.now().toString(36)}`

interface RunSpec {
  readonly label: string
  readonly level: number
  readonly conceptText: string
  readonly situationGroundingText: string
}

// Three concepts spanning a martial L1, a caster L5 (exercises the spell-level
// slot cap at a non-trivial level), and a wizard L2 (Arcane Tradition / subclass
// at level 2 — the reviewers flagged this path). Register: Rust-Iron Marches is
// grim, late-medieval dark fantasy; the concept prose stays in that register.
const RUNS: readonly RunSpec[] = [
  {
    label: 'L1 martial',
    level: 1,
    conceptText:
      'A charcoal-burner\'s daughter who came down out of the Black Pines after the winter levy took her brother, looking for honest work at the toll-bridge. She carries a woodsman\'s hatchet and knows how to use it; she trusts the trees more than any priest.',
    situationGroundingText:
      'She has come to the toll-bridge at Grausvelt asking after work and after the man who last saw her brother alive.',
  },
  {
    label: 'L5 caster',
    level: 5,
    conceptText:
      'A defrocked inquisitor who, after burning the wrong ledger, learned to work quiet miracles no bishop ever sanctioned. He walks the edge-roads under an assumed name, a wandering priest of a god the church has not gotten around to naming. Scarred, competent, and quietly heretical.',
    situationGroundingText:
      'He arrives among the crowd at Vaerin\'s Cross, keeping his old inquisitor\'s bearing hidden beneath a pilgrim\'s cloak.',
  },
  {
    label: 'L2 wizard (subclass-at-2)',
    level: 2,
    conceptText:
      'A hedge-scholar who apprenticed years in a monastic library and taught himself the small, tolerated arcana of wards and warning-glyphs. He peddles protective charms along the pilgrim roads, one step ahead of the inquisition\'s interest. He is unmistakably a wizard: bookish, precise, forever taking notes.',
    situationGroundingText:
      'He has set up at the charcoal camp to trade wards for shelter, listening for word of what moves through the pines.',
  },
]

interface AssertResult {
  readonly ok: boolean
  readonly label: string
  readonly detail: string
}

const results: AssertResult[] = []
function record(ok: boolean, label: string, detail: string): void {
  results.push({ ok, label, detail })
  console.log(`  ${ok ? '✅' : '❌'} ${label} — ${detail}`)
}

function fail(msg: string): never {
  console.error(`\n❌ SMOKE FAILED (setup): ${msg}`)
  process.exit(1)
}

// -- ephemeral seed ---------------------------------------------------------

interface Seeded {
  readonly userId: string
  readonly campaignId: string
}

let seedCounter = 0
async function seedRun(pool: Pool, spec: RunSpec): Promise<Seeded> {
  const userId = uuidv7()
  const campaignId = uuidv7()
  const n = seedCounter++
  await pool.query(
    `INSERT INTO users (id, cognito_sub, display_name, username)
       VALUES ($1, $2, $3, $4)`,
    [userId, `${TAG}-sub-${String(n)}`, `${TAG} player ${String(n)}`, `${TAG}_u${String(n)}`],
  )
  await pool.query(
    `INSERT INTO campaigns (id, world_id, created_by, name, starting_situation_index, starting_level)
       VALUES ($1, $2, $3, $4, 0, $5)`,
    [campaignId, WORLD_ID, userId, `${TAG} ${spec.label}`, spec.level],
  )
  await pool.query(
    `INSERT INTO campaign_members (id, campaign_id, user_id, role, invite_accepted)
       VALUES ($1, $2, $3, 'owner', true)`,
    [uuidv7(), campaignId, userId],
  )
  await pool.query(
    `INSERT INTO character_concepts (
       id, campaign_id, user_id, concept_text, situation_grounding_text,
       guided_choices, status
     ) VALUES ($1, $2, $3, $4, $5, '{}'::jsonb, 'processing')`,
    [uuidv7(), campaignId, userId, spec.conceptText, spec.situationGroundingText],
  )
  return { userId, campaignId }
}

// -- read the persisted sheet back into a schema-valid CharacterSheetOutput --
//
// Reconstructs the full sheet from `characters` + the four sub-tables so we can
// (a) prove the PERSISTED row round-trips through CharacterSheetOutputSchema and
// (b) re-run validateCoherence against the state the player will actually use —
// not the transient in-memory LLM object the processor already discarded.

interface CharacterRow {
  readonly name: string
  readonly class: string
  readonly species: string
  readonly level: number
  readonly str: number
  readonly dex: number
  readonly con: number
  readonly int: number
  readonly wis: number
  readonly cha: number
  readonly hit_points: number
  readonly max_hit_points: number
  readonly armor_class: number
  readonly proficiency_bonus: number
  readonly gold: number
  readonly hit_die: number
  readonly spellcasting_progression: string
}

async function readPersistedSheet(
  pool: Pool,
  campaignId: string,
  userId: string,
): Promise<{ row: CharacterRow; characterId: string; sheet: CharacterSheetOutput } | null> {
  const charRes = await pool.query<CharacterRow & { id: string }>(
    `SELECT c.id, c.name, c.class, c.species, c.level, c.str, c.dex, c.con, c.int,
            c.wis, c.cha, c.hit_points, c.max_hit_points, c.armor_class,
            c.proficiency_bonus, c.gold, c.hit_die, c.spellcasting_progression
       FROM characters c
       JOIN campaign_characters cc ON cc.character_id = c.id
      WHERE cc.campaign_id = $1 AND cc.user_id = $2`,
    [campaignId, userId],
  )
  const row = charRes.rows[0]
  if (row === undefined) return null
  const characterId = row.id

  const skills = await pool.query<{ skill_name: string; proficiency_level: string }>(
    `SELECT skill_name, proficiency_level FROM character_skills WHERE character_id = $1`,
    [characterId],
  )
  const features = await pool.query<{
    feature_name: string
    description: string
    max_uses: number | null
    recharge: string
  }>(
    `SELECT feature_name, description, max_uses, recharge FROM character_features WHERE character_id = $1`,
    [characterId],
  )
  const equipment = await pool.query<{ item_name: string; quantity: number; consumable: boolean }>(
    `SELECT item_name, quantity, consumable FROM character_equipment WHERE character_id = $1`,
    [characterId],
  )
  const spells = await pool.query<{
    spell_name: string
    spell_level: number
    prepared: boolean
    ritual: boolean
  }>(
    `SELECT spell_name, spell_level, prepared, ritual FROM character_spells WHERE character_id = $1`,
    [characterId],
  )

  // Build the plain object then PARSE it — parsing is itself an assertion that
  // the persisted row is a schema-valid sheet (hit_die literal, pb/AC bounds,
  // sub-table shapes). starting_gold maps from the `gold` ledger column.
  const sheet = CharacterSheetOutputSchema.parse({
    str: row.str,
    dex: row.dex,
    con: row.con,
    int: row.int,
    wis: row.wis,
    cha: row.cha,
    hit_points: row.hit_points,
    max_hit_points: row.max_hit_points,
    armor_class: row.armor_class,
    proficiency_bonus: row.proficiency_bonus,
    starting_gold: row.gold,
    hit_die: row.hit_die,
    spellcasting_progression: row.spellcasting_progression,
    skills: skills.rows.map((s) => ({
      name: s.skill_name,
      proficient: s.proficiency_level !== 'none',
      expertise: s.proficiency_level === 'expertise',
    })),
    features: features.rows.map((f) => ({
      name: f.feature_name,
      description: f.description,
      max_uses: f.max_uses,
      recharge: f.recharge,
    })),
    equipment: equipment.rows.map((e) => ({
      name: e.item_name,
      quantity: e.quantity,
      consumable: e.consumable,
    })),
    spells: spells.rows.map((sp) => ({
      name: sp.spell_name,
      level: sp.spell_level,
      prepared: sp.prepared,
      ritual: sp.ritual,
    })),
  })
  return { row, characterId, sheet }
}

function printSheet(row: CharacterRow, sheet: CharacterSheetOutput): void {
  const conMod = Math.floor((sheet.con - 10) / 2)
  console.log('  ┌─ persisted sheet ────────────────────────────────────────')
  console.log(`  │ ${row.name} — ${row.species} ${row.class}, level ${String(row.level)}`)
  console.log(
    `  │ STR ${String(sheet.str)}  DEX ${String(sheet.dex)}  CON ${String(sheet.con)} (${conMod >= 0 ? '+' : ''}${String(conMod)})  ` +
      `INT ${String(sheet.int)}  WIS ${String(sheet.wis)}  CHA ${String(sheet.cha)}`,
  )
  console.log(
    `  │ HP ${String(sheet.max_hit_points)}  AC ${String(sheet.armor_class)}  ` +
      `PB +${String(sheet.proficiency_bonus)}  hit die d${String(sheet.hit_die)}  ` +
      `gold ${String(sheet.starting_gold)}  caster: ${sheet.spellcasting_progression}`,
  )
  console.log(`  │ features (${String(sheet.features.length)}):`)
  for (const f of sheet.features) console.log(`  │   • ${f.name}: ${f.description}`)
  console.log(`  │ equipment: ${sheet.equipment.map((e) => `${e.name}×${String(e.quantity)}`).join(', ')}`)
  if (sheet.spells.length > 0) {
    console.log(
      `  │ spells: ${sheet.spells.map((s) => `${s.name} (L${String(s.level)})`).join(', ')}`,
    )
  } else {
    console.log('  │ spells: (none)')
  }
  console.log('  └──────────────────────────────────────────────────────────')
}

// -- one character run ------------------------------------------------------

async function runCharacterCase(pool: Pool, spec: RunSpec): Promise<void> {
  console.log(`\n=== ${spec.label} (starting_level=${String(spec.level)}) ===`)
  const { userId, campaignId } = await seedRun(pool, spec)

  const events: Record<string, unknown>[] = []
  const t0 = Date.now()
  await runCharacterCreationJob(
    {
      pool,
      costCapUsd: 50,
      publishEvent: (_cid, e) => {
        events.push(e)
        return Promise.resolve()
      },
    },
    { data: { campaignId, userId }, updateProgress: () => Promise.resolve(), name: 'character-creation' },
  )
  const elapsed = Date.now() - t0

  // Per-stage spend + a coherence-retry proxy: the character_sheet stage
  // accumulates spend across EVERY generate→validate attempt, so an elevated
  // sheet cost relative to a single generation is the observable signal of
  // repeated coherence regeneration (A5 retry loop). Reported, not asserted.
  const runsRes = await pool.query<{ stage: string; status: string; cost_usd: string; error: string | null }>(
    `SELECT stage, status, cost_usd, error FROM pipeline_runs
      WHERE campaign_id = $1 AND user_id = $2 ORDER BY started_at`,
    [campaignId, userId],
  )
  let totalCost = 0
  for (const r of runsRes.rows) totalCost += Number(r.cost_usd)
  console.log(
    `  pipeline finished in ${String(elapsed)}ms — $${totalCost.toFixed(4)} across ${String(runsRes.rowCount)} stages`,
  )
  for (const r of runsRes.rows) {
    console.log(
      `    · ${r.stage}: ${r.status} ($${Number(r.cost_usd).toFixed(4)})${r.error === null ? '' : ` — error: ${r.error}`}`,
    )
  }

  // L5-unreliability surfacing (root-cause-first): a terminal stage-failed on
  // character_sheet is the exact "level-5 generation is unreliable" finding the
  // brief asks to report — do NOT reduce scope silently.
  const stageFailed = events.find((e) => e.type === 'stage-failed')
  if (stageFailed !== undefined) {
    record(
      false,
      `${spec.label}: pipeline completed`,
      `TERMINAL stage-failed on '${String(stageFailed.stage)}': ${String(stageFailed.reason)} — ` +
        `character generation UNRELIABLE at this level (see coherence retries above)`,
    )
    return
  }
  const completed = events.some((e) => e.type === 'character_creation_complete')
  record(completed, `${spec.label}: pipeline completed`, completed ? 'character_creation_complete emitted' : 'no completion event')

  const persisted = await readPersistedSheet(pool, campaignId, userId)
  if (persisted === null) {
    record(false, `${spec.label}: persisted character row`, 'no characters row found for this (campaign,user)')
    return
  }
  const { row, sheet } = persisted
  printSheet(row, sheet)

  // A4: the persisted level equals the deterministic campaign.starting_level
  // (the injection invariant — never the LLM's echoed level).
  record(
    row.level === spec.level,
    `${spec.label}: A4 level injection`,
    `persisted characters.level = ${String(row.level)} (expected ${String(spec.level)})`,
  )

  // (Round-trip through the schema already happened inside readPersistedSheet;
  // reaching here means the persisted row is schema-valid.)
  record(true, `${spec.label}: persisted sheet is schema-valid`, 'CharacterSheetOutputSchema.parse round-tripped')

  // A5: strengthened validateCoherence at the persisted level — pb + HP band +
  // spell-level cap. VALIDITY at level, not level-appropriateness.
  try {
    validateCoherence(sheet, spec.level)
    record(true, `${spec.label}: A5 validateCoherence`, `sheet coherent at level ${String(spec.level)}`)
  } catch (err) {
    record(
      false,
      `${spec.label}: A5 validateCoherence`,
      `INCOHERENT at level ${String(spec.level)}: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  // Optional (L2 wizard): the subclass-at-2 path should carry ≥1 class feature.
  // Soft check + eyeball — detecting a specific subclass name would mean
  // string-matching free prose (a ZFC violation), so we assert non-empty
  // features and print them (the class + feature list above is the eyeball).
  if (spec.level === 2) {
    record(
      sheet.features.length >= 1,
      `${spec.label}: carries class/subclass features`,
      `class='${row.class}', ${String(sheet.features.length)} feature(s) — see dump for the subclass eyeball`,
    )
  }
}

// -- A6: situation invitation ----------------------------------------------

async function runInvitationCase(pool: Pool): Promise<void> {
  console.log('\n=== A6 situation invitation (real Sonnet, world untouched) ===')
  const repo = createRepo(pool)
  const ctx = await repo.worlds.getCharacterConceptContext(WORLD_ID)
  if (ctx === null) fail(`world ${WORLD_ID} not found for invitation run`)

  // Snapshot the world's starting-situation columns so the shared dev world is
  // left pristine after A6 regenerates them.
  const snap = await pool.query<{ starting_situations: string | null; starting_situation_entries: unknown }>(
    `SELECT starting_situations, starting_situation_entries FROM worlds WHERE id = $1`,
    [WORLD_ID],
  )
  const before = snap.rows[0]
  if (before === undefined) fail('could not snapshot world starting-situation columns')

  const vocab = VocabularyRegistrySchema.parse(ctx.vocabulary_registry)
  const inputs = await loadStartingSituationInputs(pool, WORLD_ID)

  try {
    const t0 = Date.now()
    const cost = await runStartingSituationStage(repo, {
      worldId: WORLD_ID,
      worldName: ctx.name,
      tone: ctx.tone ?? '',
      themes: ctx.themes ?? '',
      keyTensions: ctx.key_tensions ?? '',
      locationsSummary: inputs.locationsSummary,
      npcsSummary: inputs.npcsSummary,
      factionsSummary: inputs.factionsSummary,
      canonicalNames: '',
      vocabularyRegistry: vocab,
    })
    console.log(`  Sonnet returned in ${String(Date.now() - t0)}ms — $${cost.costUsd.toFixed(4)}`)

    const entriesRes = await pool.query<{ entries: { title: string; invitation: string }[] }>(
      `SELECT starting_situation_entries AS entries FROM worlds WHERE id = $1`,
      [WORLD_ID],
    )
    const entries = entriesRes.rows[0]?.entries ?? []
    record(entries.length === 3, 'A6: three situation entries regenerated', `got ${String(entries.length)}`)

    // 2nd-person register heuristic: an invitation that addresses the player
    // ("you"/"your"/imperative) reads in-register. This is a structural floor,
    // not a quality eval — the printed prose is the human register check.
    const secondPersonRe = /\b(you|your|yours|yourself)\b/i
    for (const [i, e] of entries.entries()) {
      const inv = e.invitation
      const nonTrivial = inv.trim().length >= 12
      const secondPerson = secondPersonRe.test(inv)
      console.log(`  ┌─ invitation ${String(i)} — "${e.title}"`)
      console.log(`  │ ${inv}`)
      console.log('  └──────────────────────────────────────────────────────')
      record(
        nonTrivial && secondPerson,
        `A6: invitation ${String(i)} non-trivial + 2nd-person`,
        `len=${String(inv.trim().length)}, 2nd-person=${String(secondPerson)}`,
      )
    }
  } finally {
    // Restore the world's starting-situation columns verbatim.
    await pool.query(
      `UPDATE worlds SET starting_situations = $2, starting_situation_entries = $3::jsonb WHERE id = $1`,
      [WORLD_ID, before.starting_situations, JSON.stringify(before.starting_situation_entries)],
    )
    console.log('  (world starting-situation columns restored to pre-smoke state)')
  }
}

// -- cleanup ----------------------------------------------------------------

async function cleanup(pool: Pool): Promise<void> {
  // characters.user_id is NO ACTION → delete characters (cascades sub-tables +
  // campaign_characters) before the campaign + user deletes. Deleting the
  // campaign cascades character_concepts / campaign_members / pipeline_runs.
  await pool.query(`DELETE FROM characters WHERE user_id IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`, [
    `${TAG}-sub-%`,
  ])
  await pool.query(`DELETE FROM campaigns WHERE created_by IN (SELECT id FROM users WHERE cognito_sub LIKE $1)`, [
    `${TAG}-sub-%`,
  ])
  await pool.query(`DELETE FROM users WHERE cognito_sub LIKE $1`, [`${TAG}-sub-%`])
}

// -- main -------------------------------------------------------------------

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') {
    fail('DATABASE_URL not set (use --env-file=.env.development)')
  }
  if ((process.env.ANTHROPIC_API_KEY ?? '') === '') {
    fail('ANTHROPIC_API_KEY not set (use --env-file=.env.development)')
  }
  const pool = createPgPool(databaseUrl)

  console.log(`\n########## MYT-90 character-creation real-LLM smoke ##########`)
  console.log(`world: ${WORLD_ID} | tag: ${TAG}`)

  try {
    for (const spec of RUNS) {
      await runCharacterCase(pool, spec)
    }
    await runInvitationCase(pool)
  } finally {
    await cleanup(pool)
  }

  // Summary + exit code.
  const failures = results.filter((r) => !r.ok)
  console.log('\n########## SUMMARY ##########')
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.label} — ${r.detail}`)
  console.log(`\n${String(results.length - failures.length)}/${String(results.length)} assertions passed.`)

  await pool.end()
  if (failures.length > 0) {
    console.error(`\n❌ SMOKE FAILED: ${String(failures.length)} assertion(s) failed (see above).`)
    process.exit(1)
  }
  console.log('\n✅ SMOKE PASSED.')
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
