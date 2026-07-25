// backend/scripts/smoke/pronoun-pin-smoke.ts — constructed-state real-LLM smoke for myth-gdycq.
//
// Reproduces run 3's exact failure shape: a character concept whose description
// NEVER specifies a gender. Run 3 answered "he/his" for it. Two arms, both
// through the REAL Sonnet call (no mocks, no DB — the concept stage persists
// nothing, so this needs only an API key):
//
//   A. the player PICKED they/them  → the deterministic pin must hold, whatever
//      the model echoed;
//   B. the player picked NOTHING    → the prompt's own resolution order must
//      land on they/them rather than guessing he/him. This is the arm that
//      would have caught run 3.
//
// The `pronouns` field is a hard assert. The prose scan is REPORTED, not
// asserted: a backstory legitimately uses gendered pronouns for OTHER people, so
// a hit is a signal for a human to read, not a failure.
//
// Usage (from backend/): tsx --env-file=.env.development scripts/smoke/pronoun-pin-smoke.ts

import { runCharacterConceptStage } from '../../src/llm/prep/stages/character-concept.js'
import type { CharacterConceptOutput } from '../../src/llm/schemas/character-concept.js'

// Deliberately gender-silent: a trade, a habit, a place. Nothing to infer from,
// which is exactly the input run 3 answered with "he/his".
const CONCEPT_TEXT =
  'A ledger-keeper from the salt quarter who counts everything twice and trusts no receipt they did not write themselves. They left the counting-house after a tally went missing and have been settling other people debts ever since, mostly badly.'

const ARGS = {
  campaignId: 'smoke-campaign',
  userId: 'smoke-user',
  worldId: 'smoke-world',
  worldName: 'The Salt Quarter',
  tone: 'weathered, procedural, quietly desperate',
  themes: 'debt, record-keeping, who gets believed',
  era: 'late mercantile',
  geographySummary: 'a tidal city of counting-houses and flooded undercrofts',
  politicalSummary: 'three guilds and a harbour authority that answers to none of them',
  keyTensions: 'the ledgers disagree and someone is being made to pay for it',
  vocabularyRegistry: { entries: [], adjacent_franchises: [] },
  conceptText: CONCEPT_TEXT,
}

const GENDERED = /\b(he|him|his|she|her|hers)\b/gi

/** Every prose field the concept stage writes, as one blob per field. */
function proseFields(concept: CharacterConceptOutput): { name: string; text: string }[] {
  return [
    { name: 'physical_description', text: concept.physical_description },
    { name: 'personality_traits', text: concept.personality_traits.join(' ') },
    { name: 'ideals', text: concept.ideals.join(' ') },
    { name: 'bonds', text: concept.bonds.join(' ') },
    { name: 'flaws', text: concept.flaws.join(' ') },
    { name: 'backstory', text: concept.backstory },
  ]
}

function reportProse(concept: CharacterConceptOutput): void {
  for (const field of proseFields(concept)) {
    const hits = field.text.match(GENDERED) ?? []
    if (hits.length === 0) {
      console.log(`    ${field.name}: no gendered pronouns`)
    } else {
      console.log(`    ${field.name}: ${hits.join(', ')}  <- read this field:`)
      console.log(`      ${field.text.slice(0, 240)}…`)
    }
  }
}

async function arm(
  label: string,
  guidedChoices: Record<string, unknown>,
): Promise<CharacterConceptOutput> {
  console.log(`\n── ${label} ──`)
  const t0 = Date.now()
  const result = await runCharacterConceptStage({ ...ARGS, guidedChoices })
  console.log(`  generated in ${String(Math.round((Date.now() - t0) / 1000))}s`)
  console.log(`  name: ${result.concept.name}`)
  console.log(`  gender: ${result.concept.gender}`)
  console.log(`  pronouns: ${String(result.concept.pronouns)}`)
  reportProse(result.concept)
  return result.concept
}

async function main(): Promise<void> {
  let exitCode = 0

  const picked = await arm('A. player picked they/them', { pronouns: 'they_them' })
  const pinHeld = picked.pronouns === 'they/them'
  console.log(`  ${pinHeld ? '✅' : '❌'} the pick survived to the concept ("they/them")`)
  if (!pinHeld) exitCode = 1

  const unpicked = await arm('B. no pick, gender-silent description', {})
  // The run-3 regression check: an unspecified character must not become he/him.
  const defaulted = unpicked.pronouns === 'they/them'
  const regressed = unpicked.pronouns === 'he/him'
  console.log(
    `  ${defaulted ? '✅' : regressed ? '❌ RUN-3 REGRESSION' : '⚠️'} unspecified resolved to ${String(unpicked.pronouns)}`,
  )
  if (!defaulted) exitCode = 1

  console.log(`\n${exitCode === 0 ? 'SMOKE PASSED' : 'SMOKE FAILED'}`)
  process.exit(exitCode)
}

main().catch((e: unknown) => {
  console.error('SMOKE FAILED:', e)
  process.exit(1)
})
