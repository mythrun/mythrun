// backend/src/llm/prep/structured-output-repair.ts
//
// Per design §4.2 + §D3. The repair helper takes a structurally-invalid
// tree + Zod errors and asks a smaller LLM (Haiku or Sonnet) to fix it.
//
// The helper preserves array length/ordering (the prompt enforces this);
// if a min-floor or max-ceiling violation would require adding/dropping
// entries, the prompt instructs the LLM to return the best it can fix
// without dropping. Caller decides what to do with persistent failures
// (escalate to Sonnet, then to BullMQ retry).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
// This file is one of three whitelisted in eslint.config.js for direct
// 'ai' imports (the others are llm/ai.ts and llm/models.ts). Routing
// through the wrapper here would create a cycle: wrapper's repair path
// calls this helper, which would call the wrapper, which calls back here.
import { generateText, Output, type LanguageModel, type LanguageModelUsage } from 'ai'
import { z } from 'zod'
import type { WorldGenStage } from './streaming-extractor.js'

const PROMPT_TEMPLATE = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), '../prompts/prep/repair.txt'),
  'utf8',
)

export interface RepairArgs<T> {
  readonly tree: unknown
  readonly schema: z.ZodType<T>
  readonly zodErrors: z.ZodError
  readonly model: LanguageModel
  readonly stage: WorldGenStage
  readonly providerOptions: { readonly mythrun: { readonly stage: WorldGenStage } }
  /** Outage-resilience §1.2: repair calls get an explicit timeout so a hung
   *  repair connection can't silently eat the stage budget. Expires as a
   *  TimeoutError abort, which classifies as abort-class (tier failure), not
   *  connectivity. */
  readonly timeoutMs?: number
  /** Loop-scoped callers merge their attempt signal in: an external abort or
   *  the stage-budget timer must stop repair spend immediately — a repair
   *  call never outlives its caller. Merged with the timeout via
   *  AbortSignal.any; whichever fires first aborts. */
  readonly abortSignal?: AbortSignal
}

export type RepairResult<T> =
  | { readonly ok: true; readonly tree: T; readonly usage: LanguageModelUsage }
  | { readonly ok: false; readonly errors: z.ZodError; readonly usage: LanguageModelUsage }

// Minimal placeholder — replaced by a real zod→JSON-Schema lib in a
// follow-up if needed. For repair the LLM only needs the error strings
// + the tree; the schema text is supplementary. Kept as a constant
// rather than a function-of-schema to avoid an unused-arg lint error;
// when a real zod→JSON-Schema integration lands, the constant becomes
// a function again.
const SCHEMA_DESCRIPTION = '(schema described by validation errors below)'

export async function repairStructuredOutput<T>(args: RepairArgs<T>): Promise<RepairResult<T>> {
  // Function replacers for the dynamic blocks: the current tree is LLM output
  // (JSON.stringify does not escape `$`) and the Zod messages can echo input
  // values, so a `$&`/`$'` sequence in either must splice in literally.
  // `{{schemaJson}}` is a static constant, so a plain string replace is safe.
  const prompt = PROMPT_TEMPLATE
    .replace('{{schemaJson}}', SCHEMA_DESCRIPTION)
    .replace('{{currentTree}}', () => JSON.stringify(args.tree, null, 2))
    .replace(
      '{{zodErrors}}',
      () => args.zodErrors.issues.map((i) => `- ${i.path.join('.')}: ${i.message}`).join('\n'),
    )

  const signals: AbortSignal[] = []
  if (args.timeoutMs !== undefined) signals.push(AbortSignal.timeout(args.timeoutMs))
  if (args.abortSignal !== undefined) signals.push(args.abortSignal)

  const result = await generateText({
    model: args.model,
    output: Output.object({ schema: args.schema }),
    prompt,
    maxRetries: 1,
    ...(signals.length > 0 ? { abortSignal: AbortSignal.any(signals) } : {}),
    providerOptions: args.providerOptions as unknown as NonNullable<
      Parameters<typeof generateText>[0]['providerOptions']
    >,
  })

  const parsed = args.schema.safeParse(result.output)
  if (parsed.success) {
    return { ok: true, tree: parsed.data, usage: result.usage }
  }
  return { ok: false, errors: parsed.error, usage: result.usage }
}
