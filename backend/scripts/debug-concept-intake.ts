// Debug helper: invoke concept_intake's underlying generateText call
// once, with the same prompt + schema, and dump the raw response so we
// can see what Sonnet returned and why Zod rejected it.
//
// Run via: pnpm --filter @mythrun/backend exec tsx scripts/debug-concept-intake.ts

import { generateText, Output } from 'ai'
import { SONNET } from '../src/llm/models.js'
import { WorldConceptSchema } from '../src/llm/prep/stages/concept-intake.js'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const PROMPT_TEMPLATE = readFileSync(
  resolve(import.meta.dirname, '../src/llm/prompts/prep/concept-intake.txt'),
  'utf8',
)

const concept = process.argv[2] ?? 'a windswept archipelago where rival lighthouse-keepers tend signal-fires fueled by trapped storm-spirits'

const prompt = PROMPT_TEMPLATE.replace('{{concept}}', concept).replace(
  '{{intent}}',
  '(none — freeform mode)',
)

console.log('--- PROMPT ---')
console.log(prompt)
console.log()
console.log('--- CALL ---')

try {
  const result = await generateText({
    model: SONNET,
    output: Output.object({ schema: WorldConceptSchema }),
    prompt,
    temperature: 0.9,
    maxRetries: 0,
  })
  console.log('--- OUTPUT (validated) ---')
  console.log(JSON.stringify(result.output, null, 2))
  console.log('--- USAGE ---')
  console.log(result.usage)
} catch (err) {
  console.log('--- ERROR ---')
  console.log(err)
  if (err instanceof Error && 'text' in err) {
    console.log('--- RAW TEXT ---')
    console.log((err as { text: string }).text)
  }
  if (err instanceof Error && 'cause' in err) {
    console.log('--- CAUSE ---')
    console.log((err as { cause: unknown }).cause)
  }
}
