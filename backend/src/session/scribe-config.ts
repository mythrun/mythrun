// backend/src/session/scribe-config.ts
//
// MYT-73 T10 — the Scribe-tier tunables, gathered in one place (mirrors
// st-config.ts). The post-turn Scribe job runs OFF the hot path: it embeds the
// turn's proposed facts into the working set, runs the per-turn secret tripwire
// (Haiku) over the FT's player-facing prose, and — on a core-secret breach —
// authors (Opus) + delivers a secret-preserving retcon `Z`.
//
// The two LLM wrappers (llm/secret-tripwire.ts, llm/retcon-author.ts) import
// their model/timeout/token tunables from here — this file is the single
// source of truth for the Scribe tier (same pattern as st-config.ts).

import { HAIKU, OPUS } from '../llm/models.js'

/** The cheap per-turn tripwire runs on Haiku (recall-biased breach detector). */
export const SCRIBE_TRIPWIRE_MODEL = HAIKU
/** The retcon-author reasons over the secret to write a secret-free correction
 *  — Opus, the same tier as the Slow Thinker. */
export const SCRIBE_RETCON_MODEL = OPUS

/** Wall-clock budget for the Haiku tripwire call. */
export const SCRIBE_TRIPWIRE_TIMEOUT_MS = 30_000
/** Wall-clock budget for the Opus retcon-author call. */
export const SCRIBE_RETCON_TIMEOUT_MS = 45_000
/** Output-token cap for the retcon-author (a short open correction `Z`). */
export const SCRIBE_RETCON_MAX_OUTPUT_TOKENS = 1_200

/** Hard cap on the in-session working set (FT deltas + ST injections + retcons).
 *  The Scribe job calls `evictIfOver(campaignId, WORKING_SET_CAP)` after every
 *  append — oldest public (`ft_delta`) items drop first; non-public never. */
export const WORKING_SET_CAP = 200


/** A `breached:true` verdict UNDER this confidence (or any ambiguous verdict)
 *  still escalates to the retcon-author. The tripwire is recall-biased — a
 *  low-confidence breach is treated as a breach, not waved through. */
export const TRIPWIRE_ESCALATE_CONFIDENCE_FLOOR = 0.5
