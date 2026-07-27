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
/** Output-token cap for the retcon-author (a short open correction `Z`).
 *  Raised 1_200 -> 6_000 for the Opus 5 bump: on the 5 line an omitted
 *  `thinking` parameter runs ADAPTIVE thinking, and `maxOutputTokens` caps
 *  thinking + visible output together. A ceiling sized for the correction alone
 *  would now truncate mid-thought. Raising a ceiling is close to free — we are
 *  billed for tokens actually produced, and adaptive thinking spends only what
 *  the task needs — whereas truncation is a terminal turn failure. Wall-clock
 *  stays bounded by SCRIBE_RETCON_TIMEOUT_MS, which is the real runaway guard. */
export const SCRIBE_RETCON_MAX_OUTPUT_TOKENS = 6_000

/** Hard cap on the in-session working set (FT deltas + ST injections + retcons).
 *  The Scribe job calls `evictIfOver(campaignId, WORKING_SET_CAP)` after every
 *  append — oldest public (`ft_delta`) items drop first; non-public never. */
export const WORKING_SET_CAP = 200

// myth-retprop — the tripwire routes on the SEVERITY verdict, not a numeric
// confidence floor. There is deliberately NO escalate-confidence knob:
//   - "hard_reveal"      → the open, player-facing retcon (recall-biased: ANY
//                          hard_reveal fires it, regardless of confidence — a
//                          suspected live leak is corrected, not waved through).
//   - "soft_consistency" → a SILENT ST steer (enqueue an st-evaluation so the
//                          secret-aware Opus director can adjust FUTURE turns via
//                          its standing directive). NO player-facing correction.
//   - "none"             → clean.
// `confidence` survives as observability only; severity is the gate. This
// replaces the old TRIPWIRE_ESCALATE_CONFIDENCE_FLOOR: a low-confidence breach
// no longer routes to the disruptive open correction by virtue of the boolean —
// the severity split is what makes the remedy proportionate.
