// backend/src/session/world-lookup-config.ts
//
// MYT-72 T3 — tuning constants for the contextual world-lookup skill-gate.
// Never hardcode model names or budgets at call sites.

import { HAIKU, OPUS } from '../llm/models.js'

/** The gate's "would they even know?" judgment is a Haiku DC-table pre-roll
 *  (the established skill-check pattern) — cheap + fast (Principle #2/#3). */
export const WORLD_LOOKUP_GATE_MODEL = HAIKU

/** Haiku one-shot budget. A blown call fails soft to a moderate DC; the roll
 *  still runs (see GATE_FALLBACK_*). */
export const WORLD_LOOKUP_GATE_TIMEOUT_MS = 30_000

/** The knowledge (recall) skills the gate maps an asker's check against. Only
 *  these — recalling a fact is an INT/WIS knowledge check, not an action skill
 *  (Athletics, Stealth, etc. never gate world recall). */
export const KNOWLEDGE_SKILLS = [
  'history',
  'arcana',
  'religion',
  'nature',
  'investigation',
  'medicine',
  'survival',
  'insight',
] as const
export type KnowledgeSkill = (typeof KNOWLEDGE_SKILLS)[number]

/** An NPC asker has no character sheet; its recall modifier is a DETERMINISTIC
 *  sha256(entityId)-seeded value in this inclusive band — a stable per-NPC
 *  "how well-read is this NPC" fabrication (same NPC → same modifier always).
 *  Band chosen to span "a touch worse than a layperson" (-1) to "a learned
 *  specialist" (+4). */
export const NPC_FAB_MOD_MIN = -1
export const NPC_FAB_MOD_MAX = 4

/** §5 fail-soft: the gate's fallback DC when Haiku fails/aborts. NOT
 *  auto-success — the deterministic roll still runs against this moderate DC,
 *  so the "roll then match" discipline holds even on a model outage. */
export const GATE_FALLBACK_DC = 13
export const GATE_FALLBACK_OUTCOMES = {
  fail: "You can't quite bring it to mind.",
  success: 'You recall what you know of it.',
  great_success: 'You recall it in vivid detail.',
} as const

/** The ST-vet is a full-sd_playbook Opus call, mid-turn, per lookup (§17.4). */
export const ST_LOOKUP_VET_MODEL = OPUS
/** Pinned WELL UNDER the FT turn budget (FT_TURN_TIMEOUT_MS = 180_000) so the
 *  vet's own timeout → fail-soft fires BEFORE the FT-turn abort would
 *  terminal-fail the turn. 45s leaves the gate (~30s) + resolver + two Sonnet
 *  passes room. NOT the 120s async ST_EVAL_TIMEOUT_MS. */
export const ST_LOOKUP_VET_TIMEOUT_MS = 45_000
/** A relay/invention is 1–3 sentences. Raised 1_200 -> 6_000 for the Opus 5
 *  bump: thinking is on by default on the 5 line and shares this ceiling with
 *  the visible output, so a cap sized for the sentences alone would truncate.
 *  The runaway guard this comment used to lean on is wall-clock, not tokens —
 *  ST_LOOKUP_VET_TIMEOUT_MS still fires well inside the FT turn budget. */
export const ST_LOOKUP_VET_MAX_OUTPUT_TOKENS = 6_000
