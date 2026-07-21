// backend/scripts/smoke/myt-zaqxh-intro-smoke.ts
//
// Constructed-state real-LLM smoke for the world_introduction stage (myth-zaqxh).
// Invokes the stage handler in-process against a REAL completed world's
// known-tier slice + REAL Anthropic (OPUS), then asserts the wire-level
// contract:
//
//   - schema-valid output (the handler's generateObject validates; a throw fails)
//   - the intro persisted to worlds.introduction (prose + resolved references)
//   - the snapshot view composes it (title = world name, references resolve to
//     real served entities)
//   - ENFORCED IGNORANCE: no secret-tier entity name leaks into the prose or the
//     references (structural — the handler only reads known-tier rows; this is
//     the belt-and-suspenders confirmation)
//
// Smoke vs eval: this asserts DB/compose plumbing + the ignorance boundary. The
// PROSE REGISTER (grounded actors/mechanics vs gesturing) is judged by a human
// reading the printed prose — which this script dumps at the end.
//
// Usage (from backend/):
//   tsx --env-file=.env.development scripts/smoke/myt-zaqxh-intro-smoke.ts [worldId]
// Requires: mythrun_dev up with a completed world; ANTHROPIC_API_KEY in env.

import { createPgPool } from '../../src/db/postgres.js'
import { createRepo } from '../../src/repo/index.js'
import { worldsNs } from '../../src/repo/worlds.js'
import { worldSnapshotView } from '../../src/repo/world-snapshot-view.js'
import {
  generateWorldIntroduction,
  persistWorldIntroduction,
} from '../../src/llm/prep/stages/world-introduction.js'

// Default: "The Rust-Iron Marches" (35 known + 3 secret entities in mythrun_dev).
const WORLD_ID = process.argv[2] ?? '019f4242-fa95-71ba-9f86-cc1cd23cc570'

function fail(msg: string): never {
  console.error(`\n❌ SMOKE FAILED: ${msg}`)
  process.exit(1)
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl === undefined || databaseUrl === '') fail('DATABASE_URL not set (use --env-file=.env.development)')
  const pool = createPgPool(databaseUrl)
  const repo = createRepo(pool)

  const summary = await worldsNs(pool).getSnapshotSummary(WORLD_ID)
  if (summary === null) fail(`world ${WORLD_ID} not found in mythrun_dev`)

  // The secret-tier names that MUST NOT leak into the intro.
  const secretNames = (
    await pool.query<{ name: string }>(
      `SELECT name FROM entities WHERE world_id = $1 AND access_level != 'known'`,
      [WORLD_ID],
    )
  ).rows.map((r) => r.name)

  console.log(`\n=== world_introduction smoke — "${summary.name}" (${WORLD_ID}) ===`)
  console.log(`tone: ${summary.tone ?? '(none)'} | themes: ${summary.themes ?? '(none)'}`)
  console.log(`non-known entities that must NOT appear: ${secretNames.length}`)
  console.log('\ncalling OPUS…')

  const t0 = Date.now()
  const { intro, cost } = await generateWorldIntroduction(repo, {
    worldId: WORLD_ID,
    worldName: summary.name,
    tone: summary.tone ?? '',
    themes: summary.themes ?? '',
    vocabularyRegistry: summary.vocabularyRegistry,
  })
  console.log(
    `OPUS returned in ${String(Date.now() - t0)}ms — ` +
      `$${cost.costUsd.toFixed(4)} (${String(cost.inputTokens)} in / ${String(cost.outputTokens)} out)`,
  )

  // 0. ASSERT-THEN-PERSIST — enforced ignorance is checked on the GENERATED
  //    output, BEFORE anything is written. A leaking intro must never reach
  //    worlds.introduction (the old ordering persisted first, then asserted, so a
  //    leak polluted the DB). No secret name may appear in the prose or in a
  //    reference name.
  const proseLower = intro.prose.toLowerCase()
  const refNamesLower = intro.references.map((r) => r.name.toLowerCase())
  const leaked = secretNames.filter(
    (n) => proseLower.includes(n.toLowerCase()) || refNamesLower.includes(n.toLowerCase()),
  )
  if (leaked.length > 0) {
    fail(`ENFORCED-IGNORANCE LEAK — secret names in generated intro (NOT persisted): ${JSON.stringify(leaked)}`)
  }

  // Clean → persist, then verify the DB/compose plumbing round-trips.
  await persistWorldIntroduction(repo, WORLD_ID, intro)

  // 1. Persisted round-trip.
  const persisted = await worldsNs(pool).getWorldIntroduction(WORLD_ID)
  if (persisted === null) fail('worlds.introduction was not persisted')
  if (persisted.prose.length < 200) fail(`prose too short (${String(persisted.prose.length)} chars)`)

  // 2. Snapshot compose (non-bypass = the player projection).
  const snap = await worldSnapshotView.fetch(pool, WORLD_ID, { bypass: false })
  if (snap.introduction === undefined) fail('snapshot did not compose the introduction')
  if (snap.introduction.title !== summary.name) {
    fail(`title mechanical check: expected "${summary.name}", got "${snap.introduction.title}"`)
  }

  // 3. References resolve to real SERVED entities.
  const servedIds = new Set(snap.entities.map((e) => e.id))
  const dangling = snap.introduction.references.filter((r) => !servedIds.has(r.entityId))
  if (dangling.length > 0) fail(`references dangle: ${JSON.stringify(dangling)}`)
  if (snap.introduction.references.length === 0) fail('no references survived resolution')

  console.log('\n✅ all structural assertions passed:')
  console.log(`   • persisted + snapshot-composed (title = "${snap.introduction.title}")`)
  console.log(`   • ${String(snap.introduction.references.length)} references, all resolve to served entities`)
  console.log(`   • 0 secret names leaked into prose/references`)

  console.log('\n────────────────── GENERATED INTRODUCTION ──────────────────')
  console.log(`# ${snap.introduction.title}\n`)
  console.log(persisted.prose)
  console.log('\nReferences (dig deeper):')
  for (const r of snap.introduction.references) console.log(`  → ${r.name}`)
  console.log('─────────────────────────────────────────────────────────────')

  await pool.end()
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
