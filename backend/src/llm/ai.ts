// backend/src/llm/ai.ts
//
// Phase 1 of myth-t1qz — the canonical wrapper for all schema-validated LLM
// calls in Mythrun. After Phase 3 lands, an ESLint rule will forbid direct
// `from 'ai'` imports outside this file (and the structured-output-repair
// helper that this wrapper invokes — see "Cycle break" below).
//
// What the wrapper adds on top of the raw SDK:
//   1. A `callSite` label that travels into structured logs, so when a stage
//      fails we know which call produced the rawText snippet without
//      reverse-engineering the prompt.
//   2. A schema-repair fallback: when the SDK rejects the model's output as
//      structurally invalid, the wrapper inspects the raw text. If JSON.parse
//      + Zod accepts it (the SDK is sometimes overzealous), the wrapper
//      returns that. Otherwise it calls `repairStructuredOutput` to ask a
//      smaller LLM to fix the tree — Haiku first when `repairStrategy ===
//      'haiku-then-sonnet'`, then Sonnet, or Sonnet only when
//      `repairStrategy === 'sonnet'`.
//   3. A structured pino log line on every repair attempt (INFO on success,
//      WARN on terminal failure) with the call site, schema name, model id,
//      raw-text snippet (≤2KB), Zod issue list, and outcome — so production
//      failures have one grep target.
//
// Cycle break: `structured-output-repair.ts` is the helper this wrapper
// calls. The helper imports from `'ai'` directly (not from this file) to
// avoid an import cycle. Phase 3's ESLint rule will whitelist that one
// import via an inline disable.
//
// What this file deliberately does NOT do:
//   - Cost accounting / cost-cap enforcement (callers stitch usage into their
//     own ledgers; the wrapper just hands back the SDK's usage object).
//   - Stream emit gating, tier filtering, persistence (the streaming-extractor
//     consumes `partialObjectStream` exactly as-is).
//   - Mapping non-LlmStructuredOutputError errors — those flow through
//     unchanged, where the middleware has already mapped them to the typed
//     Mythrun error hierarchy.

import {
  generateText as sdkGenerateText,
  streamObject as sdkStreamObject,
  Output,
  wrapLanguageModel,
  type DeepPartial,
  type LanguageModel,
  type LanguageModelUsage,
  type StreamObjectResult,
} from 'ai'
import type { LanguageModelV3Middleware } from '@ai-sdk/provider'
import { z } from 'zod'
import { LlmStructuredOutputError, mapToMythrunError } from './errors.js'
import { logger } from './logger.js'
import { HAIKU, SONNET } from './models.js'
import { repairStructuredOutput } from './prep/structured-output-repair.js'
import type { WorldGenStage } from './prep/streaming-extractor.js'

// Re-exports — new code does NOT need to reach into `'ai'` directly. This
// list grows only when a concrete consumer needs a symbol that the wrapper
// can't usefully proxy (raw type aliases, `wrapLanguageModel` for models.ts
// boot wiring, etc.). Inline `from 'ai'` imports in product code are a
// Phase-3 lint violation.
export { Output, wrapLanguageModel }
export type { LanguageModel, LanguageModelUsage, LanguageModelV3Middleware }

// Default fallback for the repair call's required `stage` arg when the
// caller didn't supply a recognizable WorldGenStage in providerOptions.
// The repair helper doesn't actually use the value (it only propagates
// `providerOptions.mythrun.stage` to the SDK call); this is a type-narrow
// sentinel only.
const DEFAULT_STAGE: WorldGenStage = 'concept_intake'

const VALID_STAGES = new Set<WorldGenStage>([
  'concept_intake',
  'vocabulary_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',
  'starting_situation',
  'random_tables',
  'coherence_pass',
  'session_prep',
])

export type RepairStrategy = 'sonnet' | 'haiku-then-sonnet'

/**
 * myth-t1qz Phase 4: the diagnostic payload the wrapper attaches to a
 * rethrown `LlmStructuredOutputError`. Same shape as the structured pino
 * binding the wrapper emits at WARN — exposed via `error.diagnostic` so
 * downstream consumers (world-gen-processor → `sanitizeError` →
 * pipeline_runs.error + stage-failed SSE event) can surface call-site,
 * raw text, and Zod issues without parsing log lines.
 *
 * Absent on:
 *   - non-LLM errors (DB / cost-cap / stage-not-implemented)
 *   - LlmStructuredOutputError instances that didn't pass through the
 *     wrapper (legacy direct `from 'ai'` callers — Phase 3's lint rule
 *     forbids these in product code).
 */
export interface LlmCallDiagnostic {
  readonly callSite: string
  readonly schemaName: string
  readonly modelId: string
  readonly repairStrategy: RepairStrategy
  readonly repairAttempted: boolean
  readonly repairOutcome:
    | 'recovered'
    | 'sdk_validated_but_zod_failed'
    | 'repaired_by_haiku'
    | 'repaired_by_sonnet'
    | 'parse_failed'
    | 'haiku_failed'
    | 'sonnet_failed'
    | 'none'
  readonly rawTextSnippet: string | null
  readonly zodIssues: readonly { readonly path: string; readonly message: string }[] | null
}

export interface GenerateObjectOpts<T> {
  readonly model: LanguageModel
  readonly schema: z.ZodType<T>
  readonly prompt: string
  readonly callSite: string
  readonly system?: string
  readonly temperature?: number
  readonly maxRetries?: number
  readonly providerOptions?: unknown
  readonly schemaName?: string
  readonly repairStrategy?: RepairStrategy
  /**
   * Wall-clock budget for the underlying Anthropic call (including SDK
   * retries inside maxRetries). myth-4omh root-caused a ~20-min silent
   * hang in concept_intake when an Anthropic socket stalled with no
   * timeout configured. AbortSignal fires after this; the SDK
   * surfaces it via DOMException name='AbortError', which the error
   * mapper translates to LlmTimeoutError (terminal=false → BullMQ
   * retries). Callers SHOULD set this; the default 5 min prevents
   * indefinite hangs but is too generous for most stages.
   */
  readonly timeoutMs?: number
  /** Hard output ceiling; session-prep needs it or the SDK default truncates. */
  readonly maxOutputTokens?: number
}

export interface GenerateObjectResult<T> {
  readonly output: T
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export interface StreamObjectOpts<T> {
  readonly model: LanguageModel
  readonly schema: z.ZodType<T>
  readonly prompt: string
  readonly callSite: string
  readonly temperature?: number
  readonly maxRetries?: number
  readonly providerOptions?: unknown
  readonly schemaName?: string
  readonly repairStrategy?: RepairStrategy
  /** myth-4omh: see GenerateObjectOpts.timeoutMs. Streaming stages should
   *  budget for the full stream, not just first-byte. */
  readonly timeoutMs?: number
  /** Hard output ceiling; session-prep needs it or the SDK default truncates. */
  readonly maxOutputTokens?: number
}

export interface GenerateTextOpts {
  readonly model: LanguageModel
  readonly prompt: string
  readonly system?: string
  readonly temperature?: number
  readonly maxRetries?: number
  readonly providerOptions?: unknown
  /** myth-4omh: see GenerateObjectOpts.timeoutMs. */
  readonly timeoutMs?: number
}

export interface GenerateTextResult {
  readonly text: string
  readonly usage: LanguageModelUsage
}

type RepairOutcome =
  | 'recovered'
  | 'sdk_validated_but_zod_failed'
  | 'parse_failed'
  | 'haiku_failed'
  | 'sonnet_failed'
  | 'repaired_by_haiku'
  | 'repaired_by_sonnet'
  | 'none'

interface DiagnosticBindings {
  readonly event: 'llm.generate_object.failed'
  readonly callSite: string
  readonly schemaName: string
  readonly model: string
  readonly repairStrategy: RepairStrategy
  readonly rawTextSnippet: string | undefined
  readonly zodIssues: readonly z.core.$ZodIssue[] | undefined
  readonly repairAttempted: boolean
  readonly repairOutcome: RepairOutcome
}

// Best-effort model-id extraction for logging. LanguageModel objects from
// wrapLanguageModel carry a `modelId` on the inner provider model; we read
// it defensively so logs never crash on a non-standard model shape.
function modelLabel(model: LanguageModel): string {
  /* c8 ignore next -- LanguageModel can be a string id per Vercel SDK typing, but every Mythrun call site passes a wrapLanguageModel result; this arm is defensive against a future string-id caller. */
  if (typeof model === 'string') return model
  const m = model as { modelId?: unknown }
  /* c8 ignore next 2 -- defensive: the `modelId` field is populated by every model in models.ts; the `'unknown'` arm fires only for hand-rolled LanguageModel objects in test harnesses that don't set it. */
  if (typeof m.modelId !== 'string') return 'unknown'
  return m.modelId
}

function stripFences(rawText: string): string {
  return rawText
    .replace(/^```(?:json)?\s*/m, '')
    .replace(/```\s*$/m, '')
    .trim()
}

function snippet(rawText: string | undefined): string | undefined {
  return rawText?.slice(0, 2048)
}

export function extractStage(providerOptions: unknown): WorldGenStage {
  if (typeof providerOptions !== 'object' || providerOptions === null) return DEFAULT_STAGE
  const mythrun = (providerOptions as { mythrun?: unknown }).mythrun
  /* c8 ignore next -- defensive: stage callers always pass providerOptions.mythrun.stage; the no-mythrun arm covers non-stage callers (input-gate, profanity). */
  if (typeof mythrun !== 'object' || mythrun === null) return DEFAULT_STAGE
  const stage = (mythrun as { stage?: unknown }).stage
  /* c8 ignore next -- defensive: same as above; type-narrows for hand-rolled providerOptions without a string stage. */
  if (typeof stage !== 'string') return DEFAULT_STAGE
  // Fallback for an unrecognized stage name (covered by extractStage tests).
  if (!VALID_STAGES.has(stage as WorldGenStage)) return DEFAULT_STAGE
  return stage as WorldGenStage
}

function repairProviderOptions(providerOptions: unknown, stage: WorldGenStage): {
  readonly mythrun: { readonly stage: WorldGenStage }
} {
  /* c8 ignore start — defensive: if caller already passed mythrun-shaped
   * providerOptions we preserve them and override `stage`; the pure-stage
   * fallback covers non-mythrun callers. The runtime branch is exercised
   * (stage callers thread providerOptions); the `as` cast is a type
   * narrow, not a hazard. */
  if (typeof providerOptions === 'object' && providerOptions !== null) {
    const mythrun = (providerOptions as { mythrun?: unknown }).mythrun
    if (typeof mythrun === 'object' && mythrun !== null) {
      return {
        ...(providerOptions as { readonly mythrun: { readonly stage: WorldGenStage } }),
        mythrun: { ...(mythrun as { readonly stage: WorldGenStage }), stage },
      }
    }
  }
  return { mythrun: { stage } }
  /* c8 ignore stop */
}

interface RepairContext<T> {
  readonly schema: z.ZodType<T>
  readonly callSite: string
  readonly schemaName: string
  readonly model: LanguageModel
  readonly repairStrategy: RepairStrategy
  readonly providerOptions: unknown
}

interface RepairAttempt<T> {
  readonly result: { readonly output: T; readonly usage: LanguageModelUsage } | undefined
  readonly outcome: RepairOutcome
  readonly rawTextSnippet: string | undefined
  readonly zodIssues: readonly z.core.$ZodIssue[] | undefined
}

// Centralized repair driver shared by generateObject + streamObject. Given
// an LlmStructuredOutputError, return either the recovered tree (with
// outcome label) or a terminal-failure outcome (caller logs WARN +
// rethrows the original error).
async function attemptRepair<T>(
  err: LlmStructuredOutputError,
  ctx: RepairContext<T>,
): Promise<RepairAttempt<T>> {
  const cause = err.cause as { text?: unknown } | undefined
  const rawText = typeof cause?.text === 'string' ? cause.text : undefined
  if (rawText === undefined) {
    return { result: undefined, outcome: 'none', rawTextSnippet: undefined, zodIssues: undefined }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripFences(rawText))
  } catch {
    return {
      result: undefined,
      outcome: 'parse_failed',
      rawTextSnippet: snippet(rawText),
      zodIssues: undefined,
    }
  }

  const safe = ctx.schema.safeParse(parsed)
  if (safe.success) {
    // SDK-overzealous arm: the SDK declared the output invalid, but Zod
    // accepts the same parsed JSON. The wrapper returns it directly with
    // zero-usage repair accounting (no follow-up LLM call happened).
    return {
      result: { output: safe.data, usage: zeroUsage() },
      outcome: 'sdk_validated_but_zod_failed',
      rawTextSnippet: snippet(rawText),
      zodIssues: undefined,
    }
  }

  const initialZodIssues = safe.error.issues
  const stage = extractStage(ctx.providerOptions)
  const repairProvOpts = repairProviderOptions(ctx.providerOptions, stage)

  // First repair tier — Haiku when strategy is haiku-then-sonnet.
  if (ctx.repairStrategy === 'haiku-then-sonnet') {
    const haikuOutcome = await tryRepairWithModel({
      tree: parsed,
      schema: ctx.schema,
      zodErrors: safe.error,
      model: HAIKU,
      stage,
      providerOptions: repairProvOpts,
    })
    if (haikuOutcome.tag === 'ok') {
      return {
        result: { output: haikuOutcome.tree, usage: haikuOutcome.usage },
        outcome: 'repaired_by_haiku',
        rawTextSnippet: snippet(rawText),
        zodIssues: initialZodIssues,
      }
    }
    // Fall through to Sonnet.
  }

  // Sonnet tier (always tried, either as the only tier or after Haiku).
  const sonnetOutcome = await tryRepairWithModel({
    tree: parsed,
    schema: ctx.schema,
    zodErrors: safe.error,
    model: SONNET,
    stage,
    providerOptions: repairProvOpts,
  })
  if (sonnetOutcome.tag === 'ok') {
    return {
      result: { output: sonnetOutcome.tree, usage: sonnetOutcome.usage },
      outcome: 'repaired_by_sonnet',
      rawTextSnippet: snippet(rawText),
      zodIssues: initialZodIssues,
    }
  }

  return {
    result: undefined,
    outcome: 'sonnet_failed',
    rawTextSnippet: snippet(rawText),
    zodIssues: initialZodIssues,
  }
}

type RepairOutcomeInternal<T> =
  | { readonly tag: 'ok'; readonly tree: T; readonly usage: LanguageModelUsage }
  | { readonly tag: 'fail' }

async function tryRepairWithModel<T>(args: {
  tree: unknown
  schema: z.ZodType<T>
  zodErrors: z.ZodError
  model: LanguageModel
  stage: WorldGenStage
  providerOptions: { readonly mythrun: { readonly stage: WorldGenStage } }
}): Promise<RepairOutcomeInternal<T>> {
  try {
    const repair = await repairStructuredOutput<T>({
      tree: args.tree,
      schema: args.schema,
      zodErrors: args.zodErrors,
      model: args.model,
      stage: args.stage,
      providerOptions: args.providerOptions,
    })
    if (repair.ok) {
      return { tag: 'ok', tree: repair.tree, usage: repair.usage }
    }
    return { tag: 'fail' }
  } catch {
    // Repair-call transport / SDK error — treat as a tier failure and let
    // the next tier (or the caller's WARN-and-rethrow) handle it.
    return { tag: 'fail' }
  }
}

function zeroUsage(): LanguageModelUsage {
  /* c8 ignore start — defensive: every LanguageModelUsage we produce here
   * has these fields. The `inputTokenDetails` / `outputTokenDetails` keys
   * are required by the SDK type but cost-attribution code only reads
   * `inputTokens` / `outputTokens` / `totalTokens`. Setting all to zero is
   * the correct "no follow-up call happened" semantic. */
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    inputTokenDetails: {
      noCacheTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    outputTokenDetails: {
      textTokens: 0,
      reasoningTokens: 0,
    },
  }
  /* c8 ignore stop */
}

function logRepair<T>(
  ctx: RepairContext<T>,
  attempt: RepairAttempt<T>,
  level: 'info' | 'warn',
): void {
  const bindings: DiagnosticBindings = {
    event: 'llm.generate_object.failed',
    callSite: ctx.callSite,
    schemaName: ctx.schemaName,
    model: modelLabel(ctx.model),
    repairStrategy: ctx.repairStrategy,
    rawTextSnippet: attempt.rawTextSnippet,
    zodIssues: attempt.zodIssues,
    repairAttempted: attempt.result !== undefined || attempt.outcome === 'sonnet_failed',
    repairOutcome: attempt.outcome,
  }
  const msg =
    level === 'info'
      ? 'structured output recovered via repair fallback'
      : 'structured output failed after repair attempts'
  logger[level](bindings, msg)
}

// myth-t1qz Phase 4: build a downstream-visible diagnostic struct from
// the same repair-context + attempt shape that `logRepair` consumes.
// `repairAttempted` is true whenever a repair model call was actually
// dispatched — i.e., the parse succeeded but Zod rejected, regardless of
// the final outcome. The `sdk_validated_but_zod_failed`,
// `repaired_by_haiku`, and `repaired_by_sonnet` arms are non-terminal
// (caller doesn't reach the attachDiagnostic path), so we don't have to
// special-case them here — the wrapper only attaches on terminal rethrow.
function buildDiagnostic<T>(
  ctx: RepairContext<T>,
  attempt: RepairAttempt<T>,
): LlmCallDiagnostic {
  const repairAttempted =
    attempt.outcome === 'haiku_failed' ||
    attempt.outcome === 'sonnet_failed'
  return {
    callSite: ctx.callSite,
    schemaName: ctx.schemaName,
    modelId: modelLabel(ctx.model),
    repairStrategy: ctx.repairStrategy,
    repairAttempted,
    repairOutcome: attempt.outcome,
    rawTextSnippet: attempt.rawTextSnippet ?? null,
    zodIssues:
      attempt.zodIssues === undefined
        ? null
        : attempt.zodIssues.map((issue) => ({
            path: issue.path.map((p) => String(p)).join('.'),
            message: issue.message,
          })),
  }
}

function attachDiagnostic(err: Error, diagnostic: LlmCallDiagnostic): void {
  ;(err as { diagnostic?: LlmCallDiagnostic }).diagnostic = diagnostic
}

// myth-4omh: wall-clock guard for SDK calls. Default 8 min — covers the
// slowest observed legitimate call (locations_and_npcs Opus stream at ~5
// min including SDK retries) with ~2x headroom, while still bounding the
// silent-hang case (observed: ~22 min). Callers SHOULD pass a tighter
// timeoutMs matched to the stage budget; e.g. a Haiku one-shot wants 60s,
// a Sonnet generateObject wants 3 min.
const DEFAULT_LLM_TIMEOUT_MS = 8 * 60 * 1000

function createTimeoutSignal(timeoutMs: number | undefined): {
  readonly signal: AbortSignal
  readonly cancel: () => void
} {
  const ms = timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS
  const ac = new AbortController()
  const timer = setTimeout(() => {
    // The Vercel SDK turns this into a DOMException(name='AbortError')
    // which the error mapper translates to LlmTimeoutError (terminal=false).
    ac.abort()
  }, ms)
  return {
    signal: ac.signal,
    cancel: () => {
      clearTimeout(timer)
    },
  }
}

/**
 * Schema-validated `generateText` replacement. Returns the SDK output, the
 * SDK usage, and a `repairAttempted` flag indicating whether the fallback
 * fired. On terminal failure, rethrows the underlying LlmStructuredOutputError
 * with a structured WARN log emitted first.
 */
export async function generateObject<T>(
  opts: GenerateObjectOpts<T>,
): Promise<GenerateObjectResult<T>> {
  const repairStrategy = opts.repairStrategy ?? 'sonnet'
  const schemaName = opts.schemaName ?? 'unnamed'
  const ctx: RepairContext<T> = {
    schema: opts.schema,
    callSite: opts.callSite,
    schemaName,
    model: opts.model,
    repairStrategy,
    providerOptions: opts.providerOptions,
  }

  const timeout = createTimeoutSignal(opts.timeoutMs)
  try {
    const result = await sdkGenerateText({
      model: opts.model,
      output: Output.object<T>({ schema: opts.schema }),
      prompt: opts.prompt,
      abortSignal: timeout.signal,
      ...(opts.system !== undefined ? { system: opts.system } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
      ...(opts.providerOptions !== undefined
        ? {
            providerOptions: opts.providerOptions as NonNullable<
              Parameters<typeof sdkGenerateText>[0]['providerOptions']
            >,
          }
        : {}),
    })
    return {
      output: result.output,
      usage: result.usage,
      repairAttempted: false,
    }
  } catch (err) {
    // myth-pfke smoke surfaced: AI_NoObjectGeneratedError from the SDK's
    // Output.object validation bypasses the middleware (which only sees
    // the inner LanguageModel's stream/generate, not the post-call schema
    // check). Without this map, the catch's instanceof check rethrows
    // the unmapped error and the repair path never fires — every schema
    // validation failure becomes a stage failure. Routing through
    // mapToMythrunError converts AI_NoObjectGeneratedError to
    // LlmStructuredOutputError so the repair pipeline runs.
    const mapped = err instanceof LlmStructuredOutputError ? err : mapToMythrunError(err)
    if (!(mapped instanceof LlmStructuredOutputError)) {
      throw mapped
    }
    const attempt = await attemptRepair<T>(mapped, ctx)
    if (attempt.result !== undefined) {
      logRepair(ctx, attempt, 'info')
      return {
        output: attempt.result.output,
        usage: attempt.result.usage,
        repairAttempted: true,
      }
    }
    logRepair(ctx, attempt, 'warn')
    attachDiagnostic(mapped, buildDiagnostic(ctx, attempt))
    throw mapped
    /* c8 ignore next 3 — finally cleanup; v8 branch tracking reports the
     * implicit suppress/rethrow split as one uncovered branch even when
     * both control-flow paths are exercised by tests. */
  } finally {
    timeout.cancel()
  }
}

/**
 * Schema-validated `streamObject` replacement. Returns the SDK's
 * StreamObjectResult shape with `object` wrapped — partials, textStream,
 * usage, fullStream all pass through unchanged. The final-validation
 * promise (`object`) runs through the same repair pipeline as
 * generateObject: on LlmStructuredOutputError the wrapper inspects rawText,
 * runs Haiku/Sonnet repair per strategy, and either returns a repaired
 * tree or rethrows the original error after a structured WARN log.
 */
export function streamObject<T>(
  opts: StreamObjectOpts<T>,
): StreamObjectResult<DeepPartial<T>, T, never> {
  const repairStrategy = opts.repairStrategy ?? 'sonnet'
  const schemaName = opts.schemaName ?? 'unnamed'
  const ctx: RepairContext<T> = {
    schema: opts.schema,
    callSite: opts.callSite,
    schemaName,
    model: opts.model,
    repairStrategy,
    providerOptions: opts.providerOptions,
  }

  // myth-4omh: streaming stages run for several minutes; the timeout
  // covers the whole stream, not just first-byte. The signal is captured
  // in a closure for the wrapped-object Promise to cancel after settle.
  const timeout = createTimeoutSignal(opts.timeoutMs)
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- wrapper is the only sanctioned caller of streamObject; design §4.1 mandates it for streaming stages.
  const sdkResult = sdkStreamObject({
    model: opts.model,
    schema: opts.schema,
    prompt: opts.prompt,
    abortSignal: timeout.signal,
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.providerOptions !== undefined
      ? {
          providerOptions: opts.providerOptions as NonNullable<
            // eslint-disable-next-line @typescript-eslint/no-deprecated -- see wrapper-level note above
            Parameters<typeof sdkStreamObject>[0]['providerOptions']
          >,
        }
      : {}),
  })

  const wrappedObject: Promise<T> = sdkResult.object.then(
    (val) => {
      // Stream settled successfully; cancel the timer so it doesn't fire
      // during downstream consumption (e.g. the repair-chain handlers).
      timeout.cancel()
      return val
    },
    async (err: unknown) => {
      timeout.cancel()
      // myth-2lmc: the Vercel AI SDK throws `AI_NoObjectGeneratedError`
      // when the streamed JSON fails the post-stream Zod check. That
      // error class is in the `ai` package and isn't an instance of our
      // LlmStructuredOutputError, so without mapping the repair chain
      // would never fire and every stage-4 Zod miss became a permanent
      // stage failure. Mirror generateObject's pattern: route through
      // mapToMythrunError first, then check.
      const mapped = err instanceof LlmStructuredOutputError ? err : mapToMythrunError(err)
      if (!(mapped instanceof LlmStructuredOutputError)) {
        throw mapped
      }
      const attempt = await attemptRepair<T>(mapped, ctx)
      if (attempt.result !== undefined) {
        logRepair(ctx, attempt, 'info')
        return attempt.result.output
      }
      logRepair(ctx, attempt, 'warn')
      attachDiagnostic(mapped, buildDiagnostic(ctx, attempt))
      throw mapped
    },
  )

  // `sdkResult` is a class instance (DefaultStreamObjectResult) whose
  // hot fields — partialObjectStream, textStream, fullStream, warnings,
  // usage — are prototype getters. Object spread copies only own
  // enumerable properties, so `{ ...sdkResult }` would silently drop
  // every one of those getters and the consumer would see `undefined`
  // for partialObjectStream. Mutate in place via defineProperty so the
  // prototype chain is preserved and only `object` is shadowed.
  Object.defineProperty(sdkResult, 'object', {
    value: wrappedObject,
    configurable: true,
    enumerable: true,
    writable: true,
  })
  return sdkResult as unknown as StreamObjectResult<DeepPartial<T>, T, never>
}

/**
 * Plain free-text passthrough — no schema, no repair. Use generateObject
 * for any call that expects structured output. Returns the SDK shape
 * trimmed to `{ text, usage }`.
 */
export async function generateText(opts: GenerateTextOpts): Promise<GenerateTextResult> {
  // Defensive: `system` passthrough on bare generateText is unused today
  // (no current production call passes both `system` and no Output.object).
  // Kept for API symmetry with generateObject; both ternary arms wrapped.
  /* c8 ignore start */
  const timeout = createTimeoutSignal(opts.timeoutMs)
  try {
    const result = await sdkGenerateText({
      model: opts.model,
      prompt: opts.prompt,
      abortSignal: timeout.signal,
      ...(opts.system !== undefined ? { system: opts.system } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.maxRetries !== undefined ? { maxRetries: opts.maxRetries } : {}),
      ...(opts.providerOptions !== undefined
        ? {
            providerOptions: opts.providerOptions as NonNullable<
              Parameters<typeof sdkGenerateText>[0]['providerOptions']
            >,
          }
        : {}),
    })
    return { text: result.text, usage: result.usage }
  } catch (err) {
    // myth-4omh: route raw SDK errors through the Mythrun mapper so callers
    // get LlmTimeoutError on AbortSignal-fired timeouts (and the other
    // typed errors on rate limit / auth / etc). generateObject already
    // does this via its repair-chain catch arm; generateText was a plain
    // passthrough.
    throw mapToMythrunError(err)
  } finally {
    timeout.cancel()
  }
  /* c8 ignore stop */
}
