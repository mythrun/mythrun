// backend/src/llm/prep/stages/stage-not-implemented.ts
//
// Originally a placeholder for stages 2 + 3 per MYT-51 D7. MYT-52 wired the
// real handlers; the dispatcher no longer falls back here, but the typed
// error class survives — it's still raised by the world-gen-processor test
// suite's streamObject mock to drive the existing "halt at first
// non-implemented stage" tests, and handleStageError still discriminates
// on instanceof StageNotImplementedError to flip world.status to 'failed'
// without re-enqueueing the job.

export class StageNotImplementedError extends Error {
  readonly code = 'stage_not_implemented'
  constructor(readonly stage: string) {
    super(`stage_not_implemented: ${stage}`)
    this.name = 'StageNotImplementedError'
  }
}
