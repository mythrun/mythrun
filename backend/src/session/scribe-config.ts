// backend/src/session/scribe-config.ts
//
// MYT-73 T10 — the Scribe-tier tunables, gathered in one place (mirrors
// st-config.ts). The post-turn Scribe job runs OFF the hot path: it embeds the
// turn's proposed facts into the working set, runs the per-turn secret tripwire
// (Haiku) over the FT's player-facing prose, and — on a core-secret breach —
// authors (Opus) + delivers a secret-preserving retcon `Z`.
//
// NOTE: T3 (secret-tripwire.ts) and T4 (retcon-author.ts) currently hardcode
// their timeouts/token caps with a "T10 moves to scribe-config" comment. They
// are left untouched on purpose — re-importing these constants there is a no-op
// behavioural change and would churn their committed tests. These exports are
// the worker's source of truth; the two LLM wrappers' values match by hand.

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

/** After this many turns without an ST evaluation the policy forces one. Carried
 *  here for the Scribe tier's future use (parity with ST_EVAL_FLOOR_TURNS). */
export const RETCON_FORCE_AFTER_TURNS = 3

/** A `breached:true` verdict UNDER this confidence (or any ambiguous verdict)
 *  still escalates to the retcon-author. The tripwire is recall-biased — a
 *  low-confidence breach is treated as a breach, not waved through. */
export const TRIPWIRE_ESCALATE_CONFIDENCE_FLOOR = 0.5
