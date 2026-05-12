// backend/src/llm/prep/stages/stage-not-implemented.ts
//
// Per MYT-51 D7: stages 2 + 3 (world_and_factions, locations_and_npcs)
// are placeholders that fail visibly with a typed error in the
// non-streaming launch. When the streaming-stages ticket ships, real
// handlers swap in.

export class StageNotImplementedError extends Error {
  readonly code = 'stage_not_implemented'
  constructor(readonly stage: string) {
    super(`stage_not_implemented: ${stage}`)
    this.name = 'StageNotImplementedError'
  }
}

export function stageNotImplementedHandler(stage: string): () => Promise<never> {
  // The handler returns a rejected promise. We use `Promise.reject` directly
  // rather than `async () => { throw ... }` so ESLint's
  // `@typescript-eslint/require-await` rule doesn't fire on an async function
  // that has no await — the handler is intentionally synchronous-throws-wrapped.
  return (): Promise<never> => Promise.reject(new StageNotImplementedError(stage))
}
