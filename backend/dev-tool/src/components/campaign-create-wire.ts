// MYT-51 T13 — campaign-create wire-format readers.
//
// Pure, best-effort narrowing helpers for the campaign-create panel. The
// dev tool's apiCall / SSE stream hand us JSON-parsed bodies as `unknown`;
// we never trust the shape, just probe the fields we care about per the
// discriminator. No `as` casts (lint ban).
//
// Split out of campaign-create-panel.ts (myth-qtw77) so the wire-format
// contract surface lives apart from the DOM/controller wiring. The unit
// test (campaign-create-panel.test.ts) still imports readStageFailed /
// StageFailedEvent via the panel's re-export.

interface ConceptRejectedBodyFields {
  readonly code: 'concept_rejected'
  readonly reason: 'srd_incompat' | 'clone_intent' | 'inappropriate'
  readonly rejectionMessage: string | null
  readonly synthesizedConcept?: string
}

export type ConceptRejectedBody = ConceptRejectedBodyFields

export interface CreateSuccess {
  readonly campaignId: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function readCode(body: unknown): string | null {
  if (!isObject(body)) return null
  const code = body.code
  return typeof code === 'string' ? code : null
}

export function readConceptRejected(body: unknown): ConceptRejectedBody | null {
  if (!isObject(body)) return null
  if (body.code !== 'concept_rejected') return null
  const reason = body.reason
  if (reason !== 'srd_incompat' && reason !== 'clone_intent' && reason !== 'inappropriate') {
    return null
  }
  const msg = body.rejectionMessage
  const synth = body.synthesizedConcept
  const result: ConceptRejectedBody = {
    code: 'concept_rejected',
    reason,
    rejectionMessage: typeof msg === 'string' ? msg : null,
    ...(typeof synth === 'string' ? { synthesizedConcept: synth } : {}),
  }
  return result
}

export function readCreateSuccess(body: unknown): CreateSuccess | null {
  if (!isObject(body)) return null
  const id = body.campaignId
  return typeof id === 'string' && id.length > 0 ? { campaignId: id } : null
}

// MYT-89 A5: the 201 body from POST /api/campaigns/synthesize-preview carries
// the opaque `previewId` the guided flow then commits.
export function readPreviewId(body: unknown): string | null {
  if (!isObject(body)) return null
  const id = body.previewId
  return typeof id === 'string' && id.length > 0 ? id : null
}

export function readRetryAfterSeconds(body: unknown): number | null {
  if (!isObject(body)) return null
  const v = body.retryAfterSeconds
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : null
}

// Mirror of PipelineStageDiagnostic from
// backend/src/contract/pipeline-events.ts — kept structural to avoid
// pulling backend types into the dev-tool bundle (the dev-tool ships as
// its own Vite app per AUTHORING.md). Wire-format-only.
export interface StageDiagnostic {
  readonly callSite: string
  readonly schemaName: string
  readonly modelId: string
  readonly repairStrategy: string
  readonly repairAttempted: boolean
  readonly repairOutcome: string
  readonly rawTextSnippet: string | null
  readonly zodIssues: readonly { readonly path: string; readonly message: string }[] | null
}

export interface StageFailedEvent {
  readonly type: 'stage-failed'
  readonly stage: string
  readonly errorCode: string
  readonly willRetry: boolean
  readonly diagnostic: StageDiagnostic | null
}

interface StageStartedEvent {
  readonly type: 'stage-started'
  readonly stage: string
}

interface StageCompletedEvent {
  readonly type: 'stage-completed'
  readonly stage: string
}

function readZodIssues(
  value: unknown,
): readonly { readonly path: string; readonly message: string }[] | null {
  if (!Array.isArray(value)) return null
  const out: { path: string; message: string }[] = []
  for (const entry of value) {
    if (!isObject(entry)) continue
    const path = entry.path
    const message = entry.message
    if (typeof path === 'string' && typeof message === 'string') {
      out.push({ path, message })
    }
  }
  return out.length > 0 ? out : null
}

function readDiagnostic(value: unknown): StageDiagnostic | null {
  if (!isObject(value)) return null
  const callSite = value.callSite
  const schemaName = value.schemaName
  const modelId = value.modelId
  const repairStrategy = value.repairStrategy
  const repairAttempted = value.repairAttempted
  const repairOutcome = value.repairOutcome
  const rawTextSnippet = value.rawTextSnippet
  if (
    typeof callSite !== 'string' ||
    typeof schemaName !== 'string' ||
    typeof modelId !== 'string' ||
    typeof repairStrategy !== 'string' ||
    typeof repairAttempted !== 'boolean' ||
    typeof repairOutcome !== 'string'
  ) {
    return null
  }
  return {
    callSite,
    schemaName,
    modelId,
    repairStrategy,
    repairAttempted,
    repairOutcome,
    rawTextSnippet: typeof rawTextSnippet === 'string' ? rawTextSnippet : null,
    zodIssues: readZodIssues(value.zodIssues),
  }
}

export function readStageFailed(value: unknown): StageFailedEvent | null {
  if (!isObject(value)) return null
  if (value.type !== 'stage-failed') return null
  const stage = value.stage
  const errorCode = value.errorCode
  const willRetry = value.willRetry
  if (typeof stage !== 'string' || typeof errorCode !== 'string' || typeof willRetry !== 'boolean') {
    return null
  }
  return {
    type: 'stage-failed',
    stage,
    errorCode,
    willRetry,
    diagnostic: readDiagnostic(value.diagnostic),
  }
}

export function readStageStarted(value: unknown): StageStartedEvent | null {
  if (!isObject(value)) return null
  if (value.type !== 'stage-started') return null
  const stage = value.stage
  return typeof stage === 'string' ? { type: 'stage-started', stage } : null
}

export function readStageCompleted(value: unknown): StageCompletedEvent | null {
  if (!isObject(value)) return null
  if (value.type !== 'stage-completed') return null
  const stage = value.stage
  return typeof stage === 'string' ? { type: 'stage-completed', stage } : null
}

// Best-effort parse of the paint-job rawTextSnippet (the last judgement
// payload). Returns the parsed object only if it has the expected
// shape, null otherwise. Never throws.
export interface PaintJobJudgement {
  readonly mirroredWork?: unknown
  readonly specificDriftAxes?: unknown
}

export function tryParseJudgement(snippet: string): PaintJobJudgement | null {
  try {
    const parsed: unknown = JSON.parse(snippet)
    if (!isObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}
