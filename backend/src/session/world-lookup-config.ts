// backend/src/session/world-lookup-config.ts
//
// MYT-72 T3 — tuning constants for the contextual world-lookup skill-gate.
// Never hardcode model names or budgets at call sites.

import { HAIKU } from '../llm/models.js'

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
