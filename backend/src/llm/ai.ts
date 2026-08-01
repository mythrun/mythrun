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
  streamText as sdkStreamText,
  Output,
  tool,
  stepCountIs,
  type DeepPartial,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type StopCondition,
  type StreamObjectResult,
  type TextStreamPart,
  type ToolSet,
} from 'ai'
import { z } from 'zod'
import { classifyLlmError, type LlmFailureClass, type LlmFailureVerdict } from './classify-llm-error.js'
import { LlmStructuredOutputError, mapToMythrunError } from './errors.js'
import {
  registerAttemptObservation,
  takeAttemptObservation,
  type FetchObservation,
} from './llm-fetch.js'
import { logger } from './logger.js'
import { HAIKU, SONNET } from './models.js'
import { repairStructuredOutput } from './prep/structured-output-repair.js'
import type { WorldGenStage } from './prep/streaming-extractor.js'

// Re-exports — new code does NOT need to reach into `'ai'` directly. This
// list grows only when a concrete consumer needs a symbol that the wrapper
// can't usefully proxy (the FT tool-loop primitives `tool` / `stepCountIs`,
// raw type aliases, etc.). Inline `from 'ai'` imports in product code are a
// Phase-3 lint violation.
export { tool, stepCountIs }
export type { LanguageModel, LanguageModelUsage }
// MYT-68 — FT tool-loop surface. Re-exported so product code (the FT runner)
// never reaches into `'ai'` directly; the Phase-3 lint rule forbids that.
export type { ModelMessage, ToolSet }

// Default fallback for the repair call's required `stage` arg when the
// caller didn't supply a recognizable WorldGenStage in providerOptions.
// The repair helper doesn't actually use the value (it only propagates
// `providerOptions.mythrun.stage` to the SDK call); this is a type-narrow
// sentinel only.
const DEFAULT_STAGE: WorldGenStage = 'concept_intake'

const VALID_STAGES = new Set<WorldGenStage>([
  'concept_intake',
  'world_color',
  'vocabulary_intake',
  'world_and_factions',
  'locations_and_npcs',
  'entity_relationships',
  'entity_consolidation',
  'starting_situation',
  'random_tables',
  'coherence_pass',
  'embed_world',
  'session_prep',
])

type RepairStrategy = 'sonnet' | 'haiku-then-sonnet'

// --- outage-resilience §1.4: the boot-injected failure-reporting hook -------
//
// ai.ts stays dependency-free: the API server + workers inject a Redis-backed
// sink (llm-health tracker) at boot via setLlmHealthSink; the default is a
// no-op. Only connectivity-class failures (outageSignal === true per §1.2)
// ever reach the sink, and the call is fire-and-forget — a sink failure must
// never fail the calling turn/stage.

export interface LlmConnectivityReport {
  readonly callsite: string
  /** Job id or session id — extracted from providerOptions.mythrun
   *  (jobId ?? sessionId ?? worldId ?? campaignId), 'unknown' when absent. */
  readonly jobId: string
  readonly modelId: string
  readonly mode: 'streaming' | 'non-streaming' | null
  readonly failureClass: 'connectivity'
}

// The sink may be async (the boot integration injects a Redis-backed one);
// emitConnectivityReport routes a rejected sink promise into the same
// drop-and-log guard as a synchronous throw.
export type LlmHealthSink = (report: LlmConnectivityReport) => void | Promise<void>

let healthSink: LlmHealthSink | null = null

export function setLlmHealthSink(sink: LlmHealthSink | null): void {
  healthSink = sink
}

// §1.3 loop constants. Every loop-scoped call makes at most 3 attempts with
// jittered backoff ≤2s between them; a RETRY starts only when the remaining
// budget still fits an expected healthy run (default 60s — fast calls; slow
// stages pass their observed healthy duration).
const DEFAULT_EXPECTED_HEALTHY_DURATION_MS = 60_000
const MAX_LOOP_ATTEMPTS = 3
const MAX_RETRY_JITTER_MS = 2_000
// §1.2 requires an EXPLICIT timeout on repair calls — but NOT the fast-call
// 60s: the repair prompt regenerates the ENTIRE corrected tree with no
// maxOutputTokens cap, so on the big streamObject stages a legitimate repair
// can run for minutes, and a 60s bound would convert a stage that used to
// self-heal into a terminal LlmStructuredOutputError. Loop-scoped calls bound
// repair by the attempt's REMAINING stage budget instead; this generous
// constant is the legacy single-shot bound — explicit per the spec, sized
// for unbounded repair output.
const REPAIR_CALL_TIMEOUT_MS = 5 * 60_000

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

// --- cost-wave1 §2: the blocks seam ----------------------------------------
//
// PromptBlocks is the cacheControl-capable input shape for the three entry
// points. Blocks compile INSIDE this file to the SDK messages form with the
// per-MESSAGE `providerOptions.anthropic.cacheControl` breakpoint — the FT's
// proven mechanism (fast-thinker.ts §3.9). Call-level providerOptions.
// anthropic.cacheControl is NOT a shortcut: on the installed provider it is
// not inert — it maps to top-level auto-caching of the LAST cacheable block,
// which for a volatile-suffixed flat prompt is WRONG placement (buys the
// write premium with near-zero reads). Breakpoints ride the messages.

/** Ordered prompt blocks — each compiles to one SDK ModelMessage;
 *  `cacheBreakpoint: true` pins a per-message anthropic cacheControl
 *  breakpoint on that block. Mutually exclusive with `prompt`/`system`
 *  (runtime-asserted at the entry points); at most 4 breakpoints. */
export type PromptBlocks = readonly {
  readonly role: 'system' | 'user'
  readonly text: string
  readonly cacheBreakpoint?: boolean
}[]

/** The FT's proven per-message breakpoint shape (fast-thinker.ts §3.9). */
const ANTHROPIC_CACHE_BREAKPOINT = {
  anthropic: { cacheControl: { type: 'ephemeral' } },
} as const

/** Anthropic's per-request cache-breakpoint limit. On excess the provider
 *  keeps the first 4 and drops+warns on the 5th and later — an ignored
 *  breakpoint is a silent cost bug, so the compiler throws instead. */
const MAX_CACHE_BREAKPOINTS = 4

type CompiledPrompt =
  | { readonly kind: 'prompt'; readonly prompt: string }
  | { readonly kind: 'blocks'; readonly messages: ModelMessage[] }

/** Validates the prompt-input contract and compiles blocks to messages.
 *  Called ONCE per public entry point, BEFORE any transport/loop machinery,
 *  so contract violations surface as plain synchronous throws — never as
 *  classified/retried attempt failures inside the §1.3 loop. */
function compilePromptShape(
  opts: {
    readonly prompt?: string
    readonly system?: string
    readonly blocks?: PromptBlocks
  },
  callSite: string,
): CompiledPrompt {
  if (opts.blocks === undefined) {
    if (opts.prompt === undefined) {
      throw new Error(`llm blocks contract (${callSite}): exactly one of blocks or prompt is required`)
    }
    return { kind: 'prompt', prompt: opts.prompt }
  }
  if (opts.prompt !== undefined || opts.system !== undefined) {
    throw new Error(`llm blocks contract (${callSite}): blocks and prompt/system are mutually exclusive`)
  }
  if (opts.blocks.length === 0) {
    throw new Error(`llm blocks contract (${callSite}): blocks must be non-empty`)
  }
  // Composition guards: the provider hoists LEADING system blocks into the
  // top-level system param, so an all-system list compiles to messages: []
  // (guaranteed runtime rejection), and a system block AFTER a user block
  // becomes a mid-conversation system message — the provider silently adds
  // the model-gated mid-conversation-system beta header (400s on
  // Haiku/Sonnet). Both must throw here, at entry, not surface as classified
  // attempt failures inside the §1.3 loop.
  const firstUserIdx = opts.blocks.findIndex((b) => b.role === 'user')
  if (firstUserIdx === -1) {
    throw new Error(`llm blocks contract (${callSite}): at least one user block is required`)
  }
  if (opts.blocks.slice(firstUserIdx).some((b) => b.role === 'system')) {
    throw new Error(
      `llm blocks contract (${callSite}): system blocks must precede the first user block`,
    )
  }
  const breakpoints = opts.blocks.filter((b) => b.cacheBreakpoint === true).length
  if (breakpoints > MAX_CACHE_BREAKPOINTS) {
    throw new Error(
      `llm blocks contract (${callSite}): ${String(breakpoints)} cache breakpoints exceeds the provider limit of ${String(MAX_CACHE_BREAKPOINTS)}`,
    )
  }
  return {
    kind: 'blocks',
    messages: opts.blocks.map((b): ModelMessage => {
      const base =
        b.role === 'system'
          ? { role: 'system' as const, content: b.text }
          : { role: 'user' as const, content: b.text }
      return b.cacheBreakpoint === true
        ? { ...base, providerOptions: ANTHROPIC_CACHE_BREAKPOINT }
        : base
    }),
  }
}

/** Spread-ready SDK prompt args. The `system` opt is NOT folded in here — it
 *  stays at its original position in each call's arg literal so the legacy
 *  flat-prompt request shape is byte-identical (pinned by ai-blocks tests). */
function promptShapeArgs(
  shape: CompiledPrompt,
): { readonly prompt: string } | { readonly messages: ModelMessage[] } {
  return shape.kind === 'prompt' ? { prompt: shape.prompt } : { messages: shape.messages }
}

export interface GenerateObjectOpts<T> {
  readonly model: LanguageModel
  readonly schema: z.ZodType<T>
  /** Flat prompt (the legacy shape). Exactly one of `prompt` / `blocks` is
   *  required — runtime-asserted at the entry point. */
  readonly prompt?: string
  readonly callSite: string
  readonly system?: string
  /** Cost-wave1 §2: the cacheControl-capable input shape — see PromptBlocks.
   *  Mutually exclusive with `prompt` and `system`. */
  readonly blocks?: PromptBlocks
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
  /** Optional EXTERNAL abort (e.g. the FT turn's signal threaded into the
   *  nested skill-check DC call). Combined with the internal timeout via
   *  AbortSignal.any — whichever fires first aborts. */
  readonly abortSignal?: AbortSignal
  /**
   * MYT-72: when true, the raw model output is treated as secret-bearing and
   * is NOT captured into the repair WARN log or the rethrown error's
   * `.diagnostic`. Both `rawTextSnippet` (set to null) AND `zodIssues`
   * (set to null — a future `.refine` message could echo input) are redacted.
   * Set this for any call whose RAW OUTPUT reasons over secrets — e.g. the
   * Slow-Thinker ST-vet, which sees the `sd_playbook`. Default false keeps the
   * snippet capture path byte-for-byte unchanged for every existing caller.
   */
  readonly redactRawText?: boolean
  /**
   * Outage-resilience §1.3: arms the wrapper-owned attempt loop AND switches
   * the call to streaming transport internally (§1.0 — streamText +
   * Output.object; external contract unchanged). While armed: the loop's
   * per-attempt controller is the ONE timing authority (each attempt gets the
   * FULL remaining budget; `timeoutMs` is subsumed and ignored), SDK
   * maxRetries is forced to 0, and every failed attempt classifies (§1.2)
   * and reports (§1.4). Absent = legacy single-shot behavior, byte-identical.
   */
  readonly stageBudgetMs?: number
  /**
   * §1.3 retry gate: a RETRY starts only if the remaining budget (minus any
   * 429 wait) is at least this. Per-call-site: fast calls default 60s; slow
   * stages pass their observed healthy duration. First attempt always runs.
   */
  readonly expectedHealthyDurationMs?: number
  /** §1.4: opt this call out of health reporting (the recovery probe sets it
   *  so probe traffic never re-arms the outage window). */
  readonly skipHealthReport?: boolean
}

export interface GenerateObjectResult<T> {
  readonly output: T
  readonly usage: LanguageModelUsage
  readonly repairAttempted: boolean
}

export interface StreamObjectOpts<T> {
  readonly model: LanguageModel
  readonly schema: z.ZodType<T>
  /** See GenerateObjectOpts.prompt — exactly one of `prompt` / `blocks`. */
  readonly prompt?: string
  /** Cost-wave1 §2: see GenerateObjectOpts.blocks. */
  readonly blocks?: PromptBlocks
  readonly callSite: string
  readonly maxRetries?: number
  readonly providerOptions?: unknown
  readonly schemaName?: string
  readonly repairStrategy?: RepairStrategy
  /** myth-4omh: see GenerateObjectOpts.timeoutMs. Streaming stages should
   *  budget for the full stream, not just first-byte. */
  readonly timeoutMs?: number
  /** Hard output ceiling; session-prep needs it or the SDK default truncates. */
  readonly maxOutputTokens?: number
  /** Optional EXTERNAL abort (myth-umggn: the synthesize-preview stream
   *  threads the SSE client-disconnect signal so a closed tab stops the
   *  Sonnet burn). Combined with the internal timeout via AbortSignal.any —
   *  whichever fires first aborts. Mirrors GenerateObjectOpts.abortSignal. */
  readonly abortSignal?: AbortSignal
  /** §1.4: see GenerateObjectOpts.skipHealthReport. Externally-consumed
   *  streams are never loop-scoped (§1.3) — they get boundary classification
   *  + reporting only; their retry unit is the stage (§3 parking). */
  readonly skipHealthReport?: boolean
}

export interface GenerateTextOpts {
  readonly model: LanguageModel
  /** See GenerateObjectOpts.prompt — exactly one of `prompt` / `blocks`. */
  readonly prompt?: string
  readonly system?: string
  /** Cost-wave1 §2: see GenerateObjectOpts.blocks. */
  readonly blocks?: PromptBlocks
  readonly maxRetries?: number
  readonly providerOptions?: unknown
  /** myth-4omh: see GenerateObjectOpts.timeoutMs. */
  readonly timeoutMs?: number
  /** §1.2 boundary classification label; defaults to 'generate-text'. */
  readonly callSite?: string
  /** §1.4: see GenerateObjectOpts.skipHealthReport. */
  readonly skipHealthReport?: boolean
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
  // MYT-72: when true, redact the raw-text snippet + Zod issues from the WARN
  // log and the attached diagnostic (the raw output reasons over secrets).
  readonly redactRawText: boolean
  // Outage-resilience §1.2: loop-scoped calls rethrow connectivity-classed
  // repair-call failures to the attempt loop instead of converting them to
  // terminal tier failures (a transport outage during repair is retryable);
  // legacy single-shot callers keep the tier-failure conversion.
  readonly surfaceConnectivityFailures: boolean
  // Loop-scoped path only: the attempt's abort signal + stage-budget
  // deadline. Repair calls merge the signal and are bounded by the REMAINING
  // budget — repair spend must never outlive the budget or continue past an
  // external abort. Both undefined on the legacy single-shot path, which
  // bounds repair with REPAIR_CALL_TIMEOUT_MS.
  readonly attemptSignal: AbortSignal | undefined
  readonly attemptDeadline: number | undefined
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
      surfaceConnectivity: ctx.surfaceConnectivityFailures,
      attemptSignal: ctx.attemptSignal,
      attemptDeadline: ctx.attemptDeadline,
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
    surfaceConnectivity: ctx.surfaceConnectivityFailures,
    attemptSignal: ctx.attemptSignal,
    attemptDeadline: ctx.attemptDeadline,
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
  surfaceConnectivity: boolean
  attemptSignal: AbortSignal | undefined
  attemptDeadline: number | undefined
}): Promise<RepairOutcomeInternal<T>> {
  // Outage-resilience §1.2: repair calls get an explicit timeout so a hung
  // repair connection can't silently eat the stage budget. Loop-scoped: the
  // attempt's REMAINING budget, recomputed per tier so a Sonnet tier after a
  // failed Haiku tier gets only what is actually left. Legacy single-shot:
  // the generous constant (repair output is unbounded — see
  // REPAIR_CALL_TIMEOUT_MS).
  const timeoutMs =
    args.attemptDeadline !== undefined
      ? Math.max(args.attemptDeadline - Date.now(), 1)
      : REPAIR_CALL_TIMEOUT_MS
  try {
    const repair = await repairStructuredOutput<T>({
      tree: args.tree,
      schema: args.schema,
      zodErrors: args.zodErrors,
      model: args.model,
      stage: args.stage,
      providerOptions: args.providerOptions,
      timeoutMs,
      // Loop-scoped: the attempt's signal is merged into the repair call so
      // an external abort (or the stage-budget timer) stops repair spend
      // immediately instead of letting it run to its own timeout.
      ...(args.attemptSignal !== undefined ? { abortSignal: args.attemptSignal } : {}),
    })
    if (repair.ok) {
      return { tag: 'ok', tree: repair.tree, usage: repair.usage }
    }
    return { tag: 'fail' }
  } catch (err) {
    // Outage-resilience §1.2: a connectivity-classed repair failure means the
    // transport is down — converting it to a tier failure would end in a
    // TERMINAL schema error the worker never retries. Loop-scoped callers
    // rethrow it to the attempt loop; legacy single-shot callers keep the
    // tier-failure conversion (next tier, then WARN-and-rethrow).
    if (
      args.surfaceConnectivity &&
      classifyLlmError(err, { mode: null, headersArrived: null }).failureClass === 'connectivity'
    ) {
      throw err
    }
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
    // MYT-72: under redaction, the raw output reasons over secrets — keep both
    // the snippet and the Zod issue messages out of the log line.
    rawTextSnippet: ctx.redactRawText ? undefined : attempt.rawTextSnippet,
    zodIssues: ctx.redactRawText ? undefined : attempt.zodIssues,
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
    // MYT-72: under redaction, surface null for both fields rather than the
    // secret-bearing raw snippet / Zod issue messages.
    rawTextSnippet: ctx.redactRawText ? null : attempt.rawTextSnippet ?? null,
    zodIssues:
      ctx.redactRawText || attempt.zodIssues === undefined
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

// --- outage-resilience §1.2/§1.3: boundary classification + attempt loop ---

/** The call-site fields boundary classification and reporting need; every
 *  opts shape in this file satisfies it structurally. */
interface BoundaryCallMeta {
  readonly callSite: string
  readonly model: LanguageModel
  readonly providerOptions?: unknown
  readonly skipHealthReport?: boolean | undefined
}

/** §1.4 report identity: job id or session id from providerOptions.mythrun.
 *  Task 8/9 call sites thread an explicit `jobId`; the session-id fallbacks
 *  cover live-play surfaces that already carry MythrunContext. */
function extractJobId(providerOptions: unknown): string {
  if (typeof providerOptions !== 'object' || providerOptions === null) return 'unknown'
  const mythrun = (providerOptions as { mythrun?: unknown }).mythrun
  if (typeof mythrun !== 'object' || mythrun === null) return 'unknown'
  const fields = mythrun as Record<string, unknown>
  for (const key of ['jobId', 'sessionId', 'worldId', 'campaignId']) {
    const value = fields[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return 'unknown'
}

/** Task 8 contract: surfaced errors carry their §1.2 class as a property the
 *  park predicate reads without re-classifying. Note this mutates an object
 *  the caller already holds — on the streamTextWithTools path that is the
 *  error inside an in-band stream part yielded onward to the FT consumer,
 *  which therefore sees `llmFailureClass` on it (intended: that is how the
 *  parking task reads the class downstream). */
function attachFailureClass(err: unknown, failureClass: LlmFailureClass): void {
  if (typeof err !== 'object' || err === null) return
  ;(err as { llmFailureClass?: LlmFailureClass }).llmFailureClass = failureClass
}

/** §1.4 fire-and-forget: a sink failure must never fail the calling stage.
 *  Guards BOTH failure shapes — a synchronous throw (try/catch) and an async
 *  sink's rejected promise (Promise.resolve().catch): left floating, that
 *  rejection would kill the worker (this file's documented historical
 *  failure mode). */
function emitConnectivityReport(
  meta: BoundaryCallMeta,
  mode: 'streaming' | 'non-streaming' | null,
): void {
  if (healthSink === null) return
  const logSinkFailure = (err: unknown): void => {
    logger.warn(
      { event: 'llm.health_sink.threw', callSite: meta.callSite, err },
      'llm health sink threw; report dropped',
    )
  }
  try {
    void Promise.resolve(
      healthSink({
        callsite: meta.callSite,
        jobId: extractJobId(meta.providerOptions),
        modelId: modelLabel(meta.model),
        mode,
        failureClass: 'connectivity',
      }),
    ).catch(logSinkFailure)
  } catch (err) {
    logSinkFailure(err)
  }
}

/**
 * §1.2: classify a failure at the ai.ts boundary, attach its class to the
 * surfaced error, and report connectivity-class failures (single-attempt
 * sites report their one attempt). Loop-scoped calls do NOT use this — the
 * loop separates classification from reporting so the external-abort bail
 * can suppress the report.
 */
function classifyAttachAndReport(
  err: unknown,
  meta: BoundaryCallMeta,
  observation: FetchObservation | null,
): LlmFailureVerdict {
  const verdict = classifyLlmError(err, {
    // Every single-attempt call site threads a literal null observation
    // (no observed transport off the loop path); the non-null arms below
    // are dead until a site threads a real one.
    /* c8 ignore next 2 */
    mode: observation?.mode ?? null,
    headersArrived: observation?.headersArrived ?? null,
  })
  attachFailureClass(err, verdict.failureClass)
  if (verdict.outageSignal && meta.skipHealthReport !== true) {
    /* c8 ignore next — same: observation is null at every current call site. */
    emitConnectivityReport(meta, observation?.mode ?? null)
  }
  return verdict
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/** AbortSignal.aborted flips at runtime; the function boundary keeps TS from
 *  narrowing it to a constant across the loop's awaits. */
function externallyAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

/** §1.3 (429 row): retry-after seconds from the failure's responseHeaders,
 *  walked through causes (bounded like the §1.2 walk). Non-numeric or absent
 *  values yield null and the jittered backoff stands alone. */
function extractRetryAfterMs(err: unknown): number | null {
  let current: unknown = err
  for (let depth = 0; depth <= 5 && typeof current === 'object' && current !== null; depth++) {
    const headers = (current as { responseHeaders?: unknown }).responseHeaders
    if (typeof headers === 'object' && headers !== null) {
      const raw = (headers as Record<string, unknown>)['retry-after']
      if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw) * 1000
    }
    current = (current as { cause?: unknown }).cause
  }
  return null
}

/**
 * §1.0: one loop attempt's transport — drive the SDK streaming path
 * (streamText + Output.object, the non-deprecated pair) and assemble the
 * final validated object. Identical output semantics to the generate path:
 * schema failures surface as AI_NoObjectGeneratedError carrying the raw
 * text, so the existing repair chain applies unchanged. In-band stream
 * errors never reach `.output` directly (a zero-step stream rejects with the
 * SDK's NoOutputGeneratedError shell), so the FIRST in-band error — captured
 * via onError — is rethrown as the attempt's real failure.
 */
async function driveStreamingObjectAttempt<T>(
  opts: GenerateObjectOpts<T>,
  promptShape: CompiledPrompt,
  attemptSignal: AbortSignal,
): Promise<{ readonly output: T; readonly usage: LanguageModelUsage }> {
  let inBandError: unknown
  const result = sdkStreamText({
    model: opts.model,
    ...promptShapeArgs(promptShape),
    output: Output.object<T>({ schema: opts.schema }),
    abortSignal: attemptSignal,
    // §1.3: the loop owns attempts — SDK-internal retries are disabled.
    maxRetries: 0,
    onError: ({ error }) => {
      if (inBandError === undefined) inBandError = error
    },
    ...(opts.system !== undefined ? { system: opts.system } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.providerOptions !== undefined
      ? {
          providerOptions: opts.providerOptions as NonNullable<
            Parameters<typeof sdkStreamText>[0]['providerOptions']
          >,
        }
      : {}),
  })
  try {
    // Accessing .output consumes the stream internally; totalUsage is read
    // only on success (the SDK's DelayedPromise pattern means the unaccessed
    // rejection on the failure path never detaches).
    const output = await result.output
    const usage = await result.totalUsage
    return { output, usage }
  } catch (err) {
    throw inBandError !== undefined ? inBandError : err
  }
}

type LoopAttemptOutcome<T> =
  | { readonly tag: 'ok'; readonly result: GenerateObjectResult<T> }
  | {
      readonly tag: 'failed'
      readonly error: Error
      readonly verdict: LlmFailureVerdict
      readonly observation: FetchObservation | null
    }

/**
 * One §1.3 attempt: fresh AbortController armed with the FULL remaining
 * budget (the ONE timing authority for loop-scoped calls — createTimeoutSignal
 * is not armed), per-attempt observation registered by signal identity, and
 * the repair chain applied in-attempt on schema failures exactly as the
 * legacy path does. Never throws for retry-worthy failures — the loop decides.
 */
async function runLoopAttempt<T>(
  opts: GenerateObjectOpts<T>,
  promptShape: CompiledPrompt,
  ctx: RepairContext<T>,
  deadline: number,
): Promise<LoopAttemptOutcome<T>> {
  const remainingMs = Math.max(deadline - Date.now(), 1)
  const attemptController = new AbortController()
  const budgetTimer = setTimeout(() => {
    attemptController.abort()
  }, remainingMs)
  const attemptSignal =
    opts.abortSignal !== undefined
      ? AbortSignal.any([attemptController.signal, opts.abortSignal])
      : attemptController.signal
  registerAttemptObservation(attemptSignal)
  try {
    const { output, usage } = await driveStreamingObjectAttempt(opts, promptShape, attemptSignal)
    return { tag: 'ok', result: { output, usage, repairAttempted: false } }
  } catch (err) {
    const observation = takeAttemptObservation(attemptSignal)
    const failureCtx = {
      mode: observation?.mode ?? null,
      headersArrived: observation?.headersArrived ?? null,
    }
    const mapped = err instanceof LlmStructuredOutputError ? err : mapToMythrunError(err)
    if (!(mapped instanceof LlmStructuredOutputError)) {
      const verdict = classifyLlmError(mapped, failureCtx)
      attachFailureClass(mapped, verdict.failureClass)
      return { tag: 'failed', error: mapped, verdict, observation }
    }
    // Schema failure → the same repair chain as the legacy path, in-attempt.
    // ctx.surfaceConnectivityFailures is true here, so a connectivity-classed
    // repair-call failure THROWS out of attemptRepair and becomes this
    // attempt's (retry-worthy) failure instead of a terminal tier failure.
    // The attempt's signal + deadline ride along: the budget timer is still
    // armed here (the finally hasn't run), so repair aborts with the attempt
    // and is bounded by the remaining budget.
    try {
      const attempt = await attemptRepair<T>(mapped, {
        ...ctx,
        attemptSignal,
        attemptDeadline: deadline,
      })
      if (attempt.result !== undefined) {
        logRepair(ctx, attempt, 'info')
        return {
          tag: 'ok',
          result: {
            output: attempt.result.output,
            usage: attempt.result.usage,
            repairAttempted: true,
          },
        }
      }
      logRepair(ctx, attempt, 'warn')
      attachDiagnostic(mapped, buildDiagnostic(ctx, attempt))
      const verdict = classifyLlmError(mapped, failureCtx)
      attachFailureClass(mapped, verdict.failureClass)
      return { tag: 'failed', error: mapped, verdict, observation }
    } catch (repairErr) {
      const repairError =
        repairErr instanceof Error ? repairErr : new Error(String(repairErr))
      // The repair call ran outside the attempt's observed fetch — classify
      // with a null transport context (code-based connectivity still lands).
      const verdict = classifyLlmError(repairError, { mode: null, headersArrived: null })
      attachFailureClass(repairError, verdict.failureClass)
      return { tag: 'failed', error: repairError, verdict, observation: null }
    }
    // Both arms of the inner try/catch return, so v8 reports the outer
    // catch's fall-through bytes at the finally boundary as an uncoverable
    // branch.
    /* c8 ignore next */
  } finally {
    clearTimeout(budgetTimer)
    // Success path cleanup; on the failure path the catch already took the
    // entry and this second take is a no-op.
    takeAttemptObservation(attemptSignal)
  }
}

/** §1.3: the wrapper-owned attempt loop. See GenerateObjectOpts.stageBudgetMs. */
async function generateObjectWithBudget<T>(
  opts: GenerateObjectOpts<T>,
  promptShape: CompiledPrompt,
  stageBudgetMs: number,
  ctx: RepairContext<T>,
): Promise<GenerateObjectResult<T>> {
  const deadline = Date.now() + stageBudgetMs
  const expectedHealthyMs =
    opts.expectedHealthyDurationMs ?? DEFAULT_EXPECTED_HEALTHY_DURATION_MS
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await runLoopAttempt(opts, promptShape, ctx, deadline)
    if (outcome.tag === 'ok') return outcome.result
    const { error, verdict, observation } = outcome
    // §1.3: external aborts win — bail, no retry, no report.
    if (externallyAborted(opts.abortSignal)) throw error
    if (verdict.outageSignal && opts.skipHealthReport !== true) {
      emitConnectivityReport(opts, observation?.mode ?? null)
    }
    if (!verdict.retryWorthy || attempt >= MAX_LOOP_ATTEMPTS) throw error
    // §1.3 backoff: jitter ≤2s; a 429 waits max(jitter, retry-after).
    const jitterMs = Math.random() * MAX_RETRY_JITTER_MS
    const waitMs =
      verdict.failureClass === 'rate-limit'
        ? Math.max(jitterMs, extractRetryAfterMs(error) ?? 0)
        : jitterMs
    // §1.3 retry gate: a retry starts only when, after the wait, an expected
    // healthy run still fits the remaining budget — otherwise the retry burns
    // spend and dies as a misclassified abort.
    if (deadline - Date.now() - waitMs < expectedHealthyMs) throw error
    await sleep(waitMs)
    if (externallyAborted(opts.abortSignal)) throw error
    // Unreachable: the for(;;) exits only via return or throw, so v8
    // reports the loop's fall-through bytes as uncovered.
    /* c8 ignore next 2 */
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
  // §2: contract-asserts + compiles blocks BEFORE any transport/loop
  // machinery — a violation is a plain throw, never a retried attempt.
  const promptShape = compilePromptShape(opts, opts.callSite)
  const repairStrategy = opts.repairStrategy ?? 'sonnet'
  const schemaName = opts.schemaName ?? 'unnamed'
  const ctx: RepairContext<T> = {
    schema: opts.schema,
    callSite: opts.callSite,
    schemaName,
    model: opts.model,
    repairStrategy,
    providerOptions: opts.providerOptions,
    redactRawText: opts.redactRawText ?? false,
    surfaceConnectivityFailures: opts.stageBudgetMs !== undefined,
    // The loop path overlays the per-attempt signal + deadline in
    // runLoopAttempt; the legacy path below never has them.
    attemptSignal: undefined,
    attemptDeadline: undefined,
  }

  // Outage-resilience §1.3: stageBudgetMs arms the wrapper-owned attempt
  // loop (streaming transport, full-remaining-budget attempts, classify +
  // report per attempt). Absent, the legacy single-shot path below is
  // byte-identical to the pre-loop behavior.
  if (opts.stageBudgetMs !== undefined) {
    return generateObjectWithBudget(opts, promptShape, opts.stageBudgetMs, ctx)
  }

  const timeout = createTimeoutSignal(opts.timeoutMs)
  try {
    const result = await sdkGenerateText({
      model: opts.model,
      output: Output.object<T>({ schema: opts.schema }),
      ...promptShapeArgs(promptShape),
      abortSignal:
        opts.abortSignal !== undefined
          ? AbortSignal.any([timeout.signal, opts.abortSignal])
          : timeout.signal,
      ...(opts.system !== undefined ? { system: opts.system } : {}),
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
      // §1.2: single-attempt sites classify + report their one attempt (no
      // transport observation is threaded on the legacy path — nulls).
      classifyAttachAndReport(mapped, opts, null)
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
    classifyAttachAndReport(mapped, opts, null)
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
  // §2: contract-asserts + compiles blocks first — a violation throws
  // synchronously, before the timeout timer or the SDK stream exist.
  const promptShape = compilePromptShape(opts, opts.callSite)
  const repairStrategy = opts.repairStrategy ?? 'sonnet'
  const schemaName = opts.schemaName ?? 'unnamed'
  const ctx: RepairContext<T> = {
    schema: opts.schema,
    callSite: opts.callSite,
    schemaName,
    model: opts.model,
    repairStrategy,
    providerOptions: opts.providerOptions,
    // streamObject has no redactRawText opt; default false keeps streaming
    // diagnostics unchanged.
    redactRawText: false,
    // §1.3: externally-consumed streams are never loop-scoped — a consumed
    // stream cannot be transparently re-driven — so repair keeps the legacy
    // tier-failure conversion; the retry unit is the stage (§3 parking).
    surfaceConnectivityFailures: false,
    attemptSignal: undefined,
    attemptDeadline: undefined,
  }

  // myth-4omh: streaming stages run for several minutes; the timeout
  // covers the whole stream, not just first-byte. The signal is captured
  // in a closure for the wrapped-object Promise to cancel after settle.
  const timeout = createTimeoutSignal(opts.timeoutMs)
  // eslint-disable-next-line @typescript-eslint/no-deprecated -- wrapper is the only sanctioned caller of streamObject; design §4.1 mandates it for streaming stages.
  const sdkResult = sdkStreamObject({
    model: opts.model,
    schema: opts.schema,
    ...promptShapeArgs(promptShape),
    abortSignal:
      opts.abortSignal !== undefined
        ? AbortSignal.any([timeout.signal, opts.abortSignal])
        : timeout.signal,
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
        // §1.2: externally-consumed streams get boundary classification +
        // reporting only (no loop) — their retry unit is the stage (§3).
        classifyAttachAndReport(mapped, opts, null)
        throw mapped
      }
      const attempt = await attemptRepair<T>(mapped, ctx)
      if (attempt.result !== undefined) {
        logRepair(ctx, attempt, 'info')
        return attempt.result.output
      }
      logRepair(ctx, attempt, 'warn')
      attachDiagnostic(mapped, buildDiagnostic(ctx, attempt))
      classifyAttachAndReport(mapped, opts, null)
      throw mapped
    },
  )

  // wrappedObject is created EAGERLY, but consumers typically read
  // partialObjectStream first and only later (or, on a stream error path,
  // never) await `.object`. If the repair chain rejects before any awaiter
  // attaches, the rejection is detached and Node's unhandled-rejection
  // policy kills the whole worker process — every queue, not just the bad
  // job (live incident: an output-token overflow in session-prep took down
  // all nine queues). Attach a no-op handler so the rejection is always
  // "handled" at birth; real awaiters of `.object` still observe it.
  wrappedObject.catch(() => undefined)

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
  // §2: see generateObject — contract-assert + compile before the timer.
  const promptShape = compilePromptShape(opts, opts.callSite ?? 'generate-text')
  // Defensive: `system` passthrough on bare generateText is unused today
  // (no current production call passes both `system` and no Output.object).
  // Kept for API symmetry with generateObject; both ternary arms wrapped.
  /* c8 ignore start */
  const timeout = createTimeoutSignal(opts.timeoutMs)
  try {
    const result = await sdkGenerateText({
      model: opts.model,
      ...promptShapeArgs(promptShape),
      abortSignal: timeout.signal,
      ...(opts.system !== undefined ? { system: opts.system } : {}),
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
    const mapped = mapToMythrunError(err)
    // §1.2: every failed call at the ai.ts boundary classifies + reports.
    classifyAttachAndReport(
      mapped,
      {
        callSite: opts.callSite ?? 'generate-text',
        model: opts.model,
        providerOptions: opts.providerOptions,
        skipHealthReport: opts.skipHealthReport,
      },
      null,
    )
    throw mapped
  } finally {
    timeout.cancel()
  }
  /* c8 ignore stop */
}

export interface StreamTextWithToolsOpts {
  readonly model: LanguageModel
  /** Full message array INCLUDING the system-role message — passed as a
   *  message (not the `system:` param) so it can carry the per-message
   *  anthropic cacheControl breakpoint. Call-level providerOptions.anthropic.
   *  cacheControl is NOT inert on this provider (cost-wave1 §2): it maps to
   *  top-level auto-caching of the LAST cacheable block — wrong placement
   *  for a volatile-suffixed prompt (write premium, near-zero reads) — so
   *  breakpoints must ride the messages. */
  readonly messages: ModelMessage[]
  readonly tools: ToolSet
  readonly stopWhen: StopCondition<ToolSet> | StopCondition<ToolSet>[]
  /** Typed against the SDK's own `prepareStep` parameter rather than a bare
   *  `PrepareStepFunction<ToolSet>` alias: under our `exactOptionalPropertyTypes`
   *  tsconfig, `ToolSet` (whose tool values allow `outputSchema?: undefined`)
   *  does not satisfy `PrepareStepFunction`'s `Record<string, Tool>` constraint,
   *  so referencing the alias directly fails to compile. The SDK's parameter
   *  type is the authoritative shape callers must produce anyway. */
  readonly prepareStep?: NonNullable<Parameters<typeof sdkStreamText>[0]['prepareStep']>
  readonly callSite: string
  /** Per-TURN budget (whole loop). Surfaces as an in-band `abort` part —
   *  the CONSUMER throws LlmTimeoutError on it; nothing here throws. */
  readonly timeoutMs?: number
  /** mythrun log bindings ONLY — never cacheControl: at call level it buys
   *  wrong-placement top-level auto-caching (see the messages note). */
  readonly providerOptions?: unknown
  readonly maxOutputTokens?: number
  /** §1.4: see GenerateObjectOpts.skipHealthReport. */
  readonly skipHealthReport?: boolean
}

export interface StreamTextWithToolsResult {
  readonly fullStream: AsyncIterable<TextStreamPart<ToolSet>>
  /** FINAL step's usage — its inputTokens is the context-fill signal. */
  readonly stepUsage: Promise<LanguageModelUsage>
  /** Cumulative usage across ALL steps — the spend-attribution number. A
   *  5-step turn billed off stepUsage would under-count ~4 Sonnet passes. */
  readonly totalUsage: Promise<LanguageModelUsage>
}

/**
 * MYT-68 — the FT tool-loop wrapper. Deliberately NO repair chain (prose, not
 * structured output; malformed tool inputs surface as tool-error parts the
 * model recovers from). Error/abort surface as IN-BAND fullStream parts (the
 * for-await never throws — verified against the ai@6 dist); the consumer owns
 * converting them to thrown Mythrun errors. The usage promises are
 * pre-handled: on a zero-step failure both REJECT, and an FT that threw out
 * of its consume loop must not leave an unhandled rejection to kill the
 * worker.
 */
export function streamTextWithTools(opts: StreamTextWithToolsOpts): StreamTextWithToolsResult {
  const timeout = createTimeoutSignal(opts.timeoutMs)
  const result = sdkStreamText({
    model: opts.model,
    messages: opts.messages,
    tools: opts.tools,
    stopWhen: opts.stopWhen,
    abortSignal: timeout.signal,
    ...(opts.prepareStep !== undefined ? { prepareStep: opts.prepareStep } : {}),
    ...(opts.maxOutputTokens !== undefined ? { maxOutputTokens: opts.maxOutputTokens } : {}),
    ...(opts.providerOptions !== undefined
      ? {
          providerOptions: opts.providerOptions as NonNullable<
            Parameters<typeof sdkStreamText>[0]['providerOptions']
          >,
        }
      : {}),
  })
  // The SDK exposes usage / totalUsage as PromiseLike; normalize to Promise so
  // the result type is a plain Promise and `.catch` is available.
  const stepUsage = Promise.resolve(result.usage)
  const totalUsage = Promise.resolve(result.totalUsage)
  // Pre-attach handlers (guarded promises): the originals still reject for
  // consumers who await them; these no-op catches only mark them handled.
  // Cancel the timeout timer once the final step settles either way.
  void stepUsage.then(
    () => {
      timeout.cancel()
    },
    () => {
      timeout.cancel()
    },
  )
  void totalUsage.catch(() => undefined)
  return {
    fullStream: observeToolStreamParts(result.fullStream, {
      callSite: opts.callSite,
      model: opts.model,
      providerOptions: opts.providerOptions,
      skipHealthReport: opts.skipHealthReport,
    }),
    stepUsage,
    totalUsage,
  }
}

/**
 * Outage-resilience §1.2: streamTextWithTools never throws — errors surface
 * as in-band stream parts — so this observer classifies each error part and
 * reports connectivity-class failures BEFORE yielding the part through,
 * unchanged. Abort parts carry no transport context here (no per-attempt
 * observed fetch on FT turns), and the §1.2 abort rule with a null context
 * is always no-retry/no-signal — classified by definition, never reported.
 */
async function* observeToolStreamParts(
  stream: AsyncIterable<TextStreamPart<ToolSet>>,
  meta: BoundaryCallMeta,
): AsyncIterable<TextStreamPart<ToolSet>> {
  for await (const part of stream) {
    if (part.type === 'error') {
      classifyAttachAndReport((part as { error?: unknown }).error, meta, null)
    }
    yield part
  }
}
