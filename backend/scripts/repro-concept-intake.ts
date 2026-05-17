// backend/scripts/repro-concept-intake.ts
//
// Runs the paint-job-validator loop with verbose per-step logging for
// the Harry-Potter-mirror concept. Captures generator output, judge
// output, retry prompt amendments, and final outcome. Inlines the
// loop logic so we can see every step; the production code stays
// unchanged.
//
// Usage: cd backend && pnpm exec tsx --env-file=.env.development scripts/repro-concept-intake.ts

import { generateText, Output, type LanguageModelUsage } from 'ai'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { SONNET } from '../src/llm/models.js'
import { LlmStructuredOutputError } from '../src/llm/errors.js'

const HARRY_POTTER_CONCEPT =
  'A magical world where wizards go to university to study their crafts but ' +
  "there's a dark evil wizard trying to kill the students! And also there's " +
  'a non-magical world that is not aware of this world'

// Mirror the actual production schemas exactly so we observe the same
// validation surface the live stage would.
const WorldConceptSchema = z.object({
  name: z.string().min(2).max(120),
  tone: z.string().min(10).max(400),
  themes: z.string().min(10).max(400),
  geography_summary: z.string().min(20).max(1200),
  political_summary: z.string().min(20).max(1200),
  era: z.string().min(2).max(400),
  key_tensions: z.string().min(20).max(1200),
  follow_up_questions: z.string().min(10).max(800),
})
type WorldConcept = z.infer<typeof WorldConceptSchema>

const PaintJobJudgementSchema = z.object({
  flagged: z.boolean(),
  confidence: z.number().min(0).max(1),
  mirroredWork: z.string().nullable(),
  specificDriftAxes: z.array(z.string().min(1).max(400)).max(8),
})
type PaintJobJudgement = z.infer<typeof PaintJobJudgementSchema>

const FLAG_THRESHOLD = 0.85
const MAX_ATTEMPTS = 3

const here = dirname(fileURLToPath(import.meta.url))
const CONCEPT_INTAKE_TEMPLATE = readFileSync(
  resolve(here, '../src/llm/prompts/prep/concept-intake.txt'),
  'utf8',
)
const JUDGE_TEMPLATE = readFileSync(
  resolve(here, '../src/llm/prompts/prep/paint-job-validator.txt'),
  'utf8',
)

function buildBasePrompt(concept: string): string {
  return CONCEPT_INTAKE_TEMPLATE.replace('{{concept}}', concept).replace(
    '{{intent}}',
    '(none — freeform mode)',
  )
}

function buildRetryPrompt(basePrompt: string, lastJudgement: PaintJobJudgement | null): string {
  const driftAxes = lastJudgement?.specificDriftAxes.join(', ') ?? ''
  const mirroredWork = lastJudgement?.mirroredWork ?? 'a recognizable copyrighted work'
  return (
    basePrompt +
    '\n\n---\n\n' +
    `IMPORTANT (retry pass): an earlier draft of this world mirrored ${mirroredWork} along these axes: ${driftAxes}. ` +
    `Do NOT iterate on that direction. Explore a fundamentally different aesthetic register, ` +
    `different faction archetype, different plot shape. The output must read as a fresh original world, ` +
    `not a corrected version of the prior attempt.`
  )
}

function summarize(s: string, max = 240): string {
  const flat = s.replace(/\s+/g, ' ').trim()
  return flat.length > max ? flat.slice(0, max - 1) + '…' : flat
}

function bar(): void {
  console.log('━'.repeat(80))
}

async function runGenerator(
  prompt: string,
  temperature: number,
): Promise<
  | { ok: true; draft: WorldConcept; usage: LanguageModelUsage }
  | { ok: false; error: Error; rawText: string | undefined }
> {
  try {
    const result = await generateText({
      model: SONNET,
      output: Output.object<WorldConcept>({ schema: WorldConceptSchema }),
      prompt,
      temperature,
      maxRetries: 3,
    })
    return { ok: true, draft: result.output, usage: result.usage }
  } catch (err) {
    const cause = (err as { cause?: { text?: string } } | undefined)?.cause
    const rawText = cause?.text
    return {
      ok: false,
      error: err instanceof Error ? err : new Error(String(err)),
      rawText,
    }
  }
}

async function runJudge(
  draft: WorldConcept,
): Promise<{ judgement: PaintJobJudgement; usage: LanguageModelUsage }> {
  const result = await generateText({
    model: SONNET,
    output: Output.object<PaintJobJudgement>({ schema: PaintJobJudgementSchema }),
    prompt: JUDGE_TEMPLATE.replace('{{draft}}', JSON.stringify(draft, null, 2)),
    temperature: 0.1,
    maxRetries: 3,
  })
  return { judgement: result.output, usage: result.usage }
}

async function main(): Promise<void> {
  bar()
  console.log('CONCEPT:')
  console.log(HARRY_POTTER_CONCEPT)
  bar()

  const basePrompt = buildBasePrompt(HARRY_POTTER_CONCEPT)
  let lastJudgement: PaintJobJudgement | null = null
  let totalIn = 0
  let totalOut = 0

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    bar()
    console.log(`ATTEMPT ${attempt}/${MAX_ATTEMPTS}`)
    bar()

    const promptForThisAttempt =
      attempt === 1 ? basePrompt : buildRetryPrompt(basePrompt, lastJudgement)
    const temperature = attempt === 1 ? 0.9 : 1.0

    if (attempt > 1) {
      console.log('Retry-prompt amendment (appended to base):')
      console.log(
        promptForThisAttempt
          .slice(basePrompt.length)
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n'),
      )
      console.log()
    }

    console.log(`generator: temperature=${temperature}, maxRetries=3 (SDK internal)`)
    const startGen = Date.now()
    const genResult = await runGenerator(promptForThisAttempt, temperature)
    const genDur = Date.now() - startGen

    if (!genResult.ok) {
      console.log(`generator FAILED after ${genDur}ms`)
      console.log(`  error class: ${genResult.error.constructor.name}`)
      console.log(`  error message: ${genResult.error.message}`)
      const llmErr =
        genResult.error instanceof LlmStructuredOutputError ? 'YES' : 'NO'
      console.log(`  is LlmStructuredOutputError: ${llmErr}`)
      if (genResult.rawText !== undefined) {
        console.log(`  raw model output (length=${genResult.rawText.length}):`)
        console.log(
          genResult.rawText
            .split('\n')
            .slice(0, 30)
            .map((l) => '    ' + l)
            .join('\n'),
        )
      } else {
        console.log('  raw model output: <not present on error.cause>')
      }
      console.log(`\nLOOP TERMINATES at attempt ${attempt} due to generator failure.`)
      console.log(`Final outcome: stage fails with LlmStructuredOutputError.`)
      bar()
      console.log(`Total usage so far: in=${totalIn}, out=${totalOut}`)
      return
    }

    totalIn += genResult.usage.inputTokens ?? 0
    totalOut += genResult.usage.outputTokens ?? 0

    console.log(`generator OK in ${genDur}ms (in=${genResult.usage.inputTokens}, out=${genResult.usage.outputTokens})`)
    console.log('draft:')
    console.log(`  name: ${genResult.draft.name}`)
    console.log(`  tone: ${summarize(genResult.draft.tone, 160)}`)
    console.log(`  themes: ${summarize(genResult.draft.themes, 160)}`)
    console.log(`  era: ${summarize(genResult.draft.era, 160)}`)
    console.log(`  geography_summary: ${summarize(genResult.draft.geography_summary, 240)}`)
    console.log(`  political_summary: ${summarize(genResult.draft.political_summary, 240)}`)
    console.log(`  key_tensions: ${summarize(genResult.draft.key_tensions, 240)}`)
    console.log(`  follow_up_questions: ${summarize(genResult.draft.follow_up_questions, 200)}`)
    console.log()

    console.log('judge: temperature=0.1, maxRetries=3')
    const startJudge = Date.now()
    const judgeResult = await runJudge(genResult.draft)
    const judgeDur = Date.now() - startJudge
    totalIn += judgeResult.usage.inputTokens ?? 0
    totalOut += judgeResult.usage.outputTokens ?? 0

    console.log(`judge OK in ${judgeDur}ms (in=${judgeResult.usage.inputTokens}, out=${judgeResult.usage.outputTokens})`)
    console.log(`  flagged: ${judgeResult.judgement.flagged}`)
    console.log(`  confidence: ${judgeResult.judgement.confidence}`)
    console.log(`  mirroredWork: ${JSON.stringify(judgeResult.judgement.mirroredWork)}`)
    console.log(`  specificDriftAxes: ${JSON.stringify(judgeResult.judgement.specificDriftAxes)}`)
    console.log()

    lastJudgement = judgeResult.judgement

    if (!judgeResult.judgement.flagged || judgeResult.judgement.confidence <= FLAG_THRESHOLD) {
      console.log(
        `judge PASSES (flagged=${judgeResult.judgement.flagged}, confidence=${judgeResult.judgement.confidence} ${
          judgeResult.judgement.confidence <= FLAG_THRESHOLD ? '≤' : '>'
        } ${FLAG_THRESHOLD}). LOOP TERMINATES — stage succeeds.`,
      )
      console.log(`Final draft: ${genResult.draft.name}`)
      bar()
      console.log(`Total usage: in=${totalIn}, out=${totalOut}, attempts=${attempt}`)
      return
    }

    console.log(
      `judge REJECTS (flagged=true, confidence=${judgeResult.judgement.confidence} > ${FLAG_THRESHOLD}). Retrying with amendment...`,
    )
  }

  bar()
  console.log(`LOOP EXHAUSTED after ${MAX_ATTEMPTS} attempts.`)
  console.log(`Final outcome: stage fails with PaintJobLoopExhaustedError.`)
  console.log(`Last judgement: ${JSON.stringify(lastJudgement)}`)
  bar()
  console.log(`Total usage: in=${totalIn}, out=${totalOut}, attempts=${MAX_ATTEMPTS}`)
}

main().catch((err) => {
  console.error('fatal:', err)
  process.exit(1)
})
