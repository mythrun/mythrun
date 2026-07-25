// backend/scripts/smoke/freeform-proposal-smoke.ts — constructed-state real-LLM
// smoke for myth-6t06f + myth-z3icr.
//
// The freeform path's proposal is a NEW prompt against a CHANGED schema (the
// title field), which is exactly the seam a mocked test cannot gate: the mock
// hands back a shape the model may never produce. This runs both proposal
// inputs through real Sonnet and checks the output is usable:
//
//   1. FREEFORM  — the player's own description in, a titled proposal out. The
//      premise must survive (the named elements are the player's, not ours).
//   2. BRAINSTORM — the three-picks path, checked for the same new title field
//      (its prompt changed too).
//
// No DB and no server: these stages persist nothing. Only an API key.
//
// Usage (from backend/): tsx --env-file=.env.development scripts/smoke/freeform-proposal-smoke.ts

import {
  synthesizeConcept,
  synthesizeFromConcept,
  type SynthesizerResult,
} from '../../src/llm/prep/synthesize-concept.js'

// A premise with FOUR checkable specifics: the salvage guilds, the tide, the
// harbour-master, and the name "Kell Harbour". A proposal that keeps the
// player's world will keep them.
const PLAYER_CONCEPT =
  'Kell Harbour is a drowned port where the tide goes out twice a year and the salvage guilds race each other into the exposed streets. The harbour-master decides who gets which street, and everyone knows the lottery is rigged. I want it damp, cramped, and about who owes whom.'

// Matched against a HYPHEN- AND SPACE-STRIPPED blob: the model may write the
// player's "harbour-master" as "harbourmaster" and still be keeping their world.
// This checks the element survived, not the punctuation.
const KEPT = ['kellharbour', 'salvage', 'tide', 'harbourmaster']

const PICKS = [
  { title: 'Spirited Away', whyILikeIt: 'a working world with its own rules that nobody explains' },
  { title: 'Disco Elysium', whyILikeIt: 'a soaked, tired city and the politics of who cleans up' },
  { title: 'Annihilation', whyILikeIt: 'the landscape itself is the antagonist' },
]

function report(label: string, result: SynthesizerResult): void {
  console.log(`\n── ${label} ──`)
  console.log(`  title: ${result.title}`)
  console.log(`  concept (${String(result.concept.length)} chars):`)
  console.log(`    ${result.concept.slice(0, 400)}…`)
  console.log(`  aesthetics: ${result.intentSummary.aesthetics.join(' · ')}`)
  console.log(`  themes: ${result.intentSummary.themes.join(' · ')}`)
}

/** The title is a NAME the proposal page headlines — not a sentence, not a pitch. */
function checkTitle(title: string): boolean {
  const words = title.trim().split(/\s+/).length
  const ok = words >= 1 && words <= 8 && !title.includes(':') && title.length <= 120
  console.log(`  ${ok ? '✅' : '❌'} title is a headline-able name (${String(words)} words)`)
  return ok
}

async function main(): Promise<void> {
  let exitCode = 0

  const t0 = Date.now()
  const freeform = await synthesizeFromConcept(PLAYER_CONCEPT)
  console.log(`freeform proposal in ${String(Math.round((Date.now() - t0) / 1000))}s`)
  report('FREEFORM — the player own words', freeform)
  if (!checkTitle(freeform.title)) exitCode = 1

  // The player's premise is FIXED: a proposal that renames their harbour or
  // drops their guilds is not their world, however good the prose is.
  const blob = `${freeform.title}\n${freeform.concept}`.toLowerCase().replace(/[-\s]/g, '')
  for (const kept of KEPT) {
    const held = blob.includes(kept)
    console.log(`  ${held ? '✅' : '❌'} kept the player element "${kept}"`)
    if (!held) exitCode = 1
  }
  // A proposal talks about the world, never back at the player.
  const talksBack = /\byou (asked|wanted|said|described)\b/i.test(freeform.concept)
  console.log(`  ${talksBack ? '❌ talks back at the player' : '✅ writes the world, not a reply'}`)
  if (talksBack) exitCode = 1

  const t1 = Date.now()
  const brainstorm = await synthesizeConcept(PICKS)
  console.log(`\nbrainstorm proposal in ${String(Math.round((Date.now() - t1) / 1000))}s`)
  report('BRAINSTORM — three picks', brainstorm)
  if (!checkTitle(brainstorm.title)) exitCode = 1
  // The source titles must not surface in the prose (the standing constraint).
  const echoed = /spirited away|disco elysium|annihilation/i.test(
    `${brainstorm.title} ${brainstorm.concept}`,
  )
  console.log(`  ${echoed ? '❌ echoed a source title' : '✅ no source titles in the proposal'}`)
  if (echoed) exitCode = 1

  console.log(`\n${exitCode === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED'}`)
  process.exit(exitCode)
}

main().catch((e: unknown) => {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
})
