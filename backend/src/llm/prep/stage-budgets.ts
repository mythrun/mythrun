// WORLD_GEN_STAGE_BUDGETS — the §1.3 per-stage budget table for world-gen
// LLM calls (llm-outage-resilience design; myth-9rccn's "one constants map +
// one spread per call site"). Passing `stageBudgetMs` arms the wrapper-owned
// attempt loop AND switches the call to streaming transport internally
// (ai.ts GenerateObjectOpts.stageBudgetMs): time-to-headers decouples from
// generation time, attempts are classified per §1.2, and surfaced failures
// carry `llmFailureClass` for the §3.1 park predicate.
//
// Only coherence_pass is wired so far — myth-5ei5j: Sonnet 5's adaptive
// thinking pushed its non-streaming generation (24-32k thinking tokens over
// the ~95k-token world dump) past the non-streaming dispatcher's 300s
// headers ceiling, failing every S-5-sized world at the second-to-last
// stage. Wiring the remaining stages is myth-9rccn.

import type { WorldGenStage } from './streaming-extractor.js'

export interface StageBudget {
  /** Arms the §1.3 loop; the loop's per-attempt controller is the ONE timing
   *  authority (each attempt gets the full remaining budget). */
  readonly stageBudgetMs: number
  /** §1.3 retry gate: a retry starts only while the remaining budget still
   *  fits one healthy run of this stage. */
  readonly expectedHealthyDurationMs: number
  /** Ceiling on thinking + visible output TOGETHER (Sonnet 5 thinks by
   *  default — see models.ts). A backstop, never a routine cap. */
  readonly maxOutputTokens: number
}

export const WORLD_GEN_STAGE_BUDGETS = {
  // myth-5ei5j sizing (2026-08-01 replays of a 50-entity world's exact call):
  // wall 4:18-5:28 with ±34% run-to-run thinking variance → 8 min healthy;
  // the budget fits two healthy attempts plus backoff. Output observed at
  // 26.5-35.4k tokens (thinking included); 64k backstops it — the previous
  // unset value fell through to the provider's 128k wire default.
  coherence_pass: {
    stageBudgetMs: 20 * 60_000,
    expectedHealthyDurationMs: 8 * 60_000,
    maxOutputTokens: 64_000,
  },
} satisfies Partial<Record<WorldGenStage, StageBudget>>
