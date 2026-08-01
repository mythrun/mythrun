// backend/src/session/world-lookup-gate.ts
//
// MYT-72 T3 — the contextual world-lookup skill-gate. Decides WHETHER and how
// hard it is for an asker (a PC via the DM channel, or an NPC) to RECALL world
// knowledge BEFORE the resolver pays the lookup cost — a failed gate skips it.
//
// The DC is CONTEXTUAL: Haiku judges topic obscurity RELATIVE to the asker's
// PUBLIC standing (Principle #2 ZFC — the "would they even know?" judgment is a
// model call, the established skill-check pre-roll pattern), with a no-roll
// AUTO-SUCCESS when knowledge is a foregone conclusion and a very-high DC when
// implausible. The roll itself is deterministic code (Principle #4). This gate
// sees PUBLIC standing ONLY — secret-aware overrides (a covert-membership
// foregone conclusion) are downstream (the ST-vet), never here.
//
// Fail-soft TOTAL: a blown Haiku call returns a moderate fallback DC (NOT
// auto-success) and the deterministic roll still runs, so "roll then match"
// (Principle #5) holds even on a model outage.

import { createHash } from 'node:crypto'
import { generateObject } from '../llm/ai.js'
import { loadPrompt } from '../llm/prompts.js'
import {
  WorldLookupGateResultSchema,
  type WorldLookupGateResult,
} from '../llm/schemas/world-lookup-gate.js'
import {
  GATE_FALLBACK_DC,
  GATE_FALLBACK_OUTCOMES,
  NPC_FAB_MOD_MAX,
  NPC_FAB_MOD_MIN,
  WORLD_LOOKUP_GATE_MODEL,
  WORLD_LOOKUP_GATE_TIMEOUT_MS,
  type KnowledgeSkill,
} from './world-lookup-config.js'
import {
  calculateModifier, resolveRollType, rollD20WithType, type Rng,
} from './dice/engine.js'
import type { Character } from '../repo/types.js'
import type { SkillCheckFramePayload } from './tiers/types.js'

type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

/** LOCAL enum → canonical-5e-skill + ability map. The gate's KnowledgeSkill is
 *  a closed set, so the canonical name + ability are a deterministic lookup —
 *  NO second Haiku call (Principle #3: cheapest path that does the job). */
const KNOWLEDGE_SKILL_MAP: Record<KnowledgeSkill, { canonical: string; ability: AbilityKey }> = {
  history: { canonical: 'History', ability: 'int' },
  arcana: { canonical: 'Arcana', ability: 'int' },
  religion: { canonical: 'Religion', ability: 'int' },
  nature: { canonical: 'Nature', ability: 'int' },
  investigation: { canonical: 'Investigation', ability: 'int' },
  medicine: { canonical: 'Medicine', ability: 'wis' },
  survival: { canonical: 'Survival', ability: 'wis' },
  insight: { canonical: 'Insight', ability: 'wis' },
}

const norm = (s: string): string => s.trim().toLowerCase()

interface WorldLookupGateBase {
  readonly topic: string
  readonly worldTone: string
  /** PUBLIC standing summary — the only asker view the gate sees. */
  readonly askerSummary: string
}

/** Discriminated on `channel` so exactly one asker (`dm` for a PC, `npc` for an
 *  NPC) is present and TS narrows it — no optional-field ambiguity. */
export type WorldLookupGateInput =
  | (WorldLookupGateBase & { readonly channel: 'dm'; readonly dm: WorldLookupGateDmAsker })
  | (WorldLookupGateBase & { readonly channel: 'npc'; readonly npc: WorldLookupGateNpcAsker })

export interface WorldLookupGateDmAsker {
  readonly character: Character
  readonly skill: KnowledgeSkill
  readonly skills: readonly { skill_name: string; proficiency_level: string }[]
}

export interface WorldLookupGateNpcAsker {
  readonly entityId: string
  readonly npcName: string
}

interface AskerProjection {
  readonly modifier: number
  readonly characterName: string
  readonly skillLabel: string
  readonly rollHidden: boolean
}

export type WorldLookupGateResolution =
  | { readonly outcome: 'auto_success' }
  | { readonly outcome: 'pass'; readonly frame: SkillCheckFramePayload; readonly rollHidden: boolean }
  | {
      readonly outcome: 'fail'
      readonly frame: SkillCheckFramePayload
      readonly rollHidden: boolean
      readonly failConstraint: string
    }

export interface WorldLookupGateDeps {
  readonly worldTone: string
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. */
  readonly sessionId: string
  readonly rng?: Rng
  readonly abortSignal?: AbortSignal
  readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
}

export async function resolveWorldLookupGate(
  deps: WorldLookupGateDeps,
  input: WorldLookupGateInput,
): Promise<WorldLookupGateResolution> {
  const table = await fetchGateTable(deps, input)

  if (table.auto_success) {
    return { outcome: 'auto_success' }
  }

  const { modifier, characterName, skillLabel, rollHidden } = askerProjection(input)

  const rollType = resolveRollType(false, false)
  const d20 = rollD20WithType(rollType, deps.rng)
  const total = d20.keptRoll + modifier
  const outcomeTier: 'fail' | 'success' | 'great_success' =
    total >= table.dc + 5 ? 'great_success' : total >= table.dc ? 'success' : 'fail'

  const frame: SkillCheckFramePayload = {
    characterName,
    skill: skillLabel,
    context: input.topic,
    roll: d20.roll,
    roll2: d20.roll2,
    rollType,
    modifier,
    total,
    dc: table.dc,
    outcomeTier,
    constraint: table.outcomes[outcomeTier],
  }

  if (outcomeTier === 'fail') {
    return { outcome: 'fail', frame, rollHidden, failConstraint: table.outcomes.fail }
  }
  return { outcome: 'pass', frame, rollHidden }
}

/** Resolve the asker's recall modifier + display fields. DM → real skill-check
 *  modifier math off the PC sheet (visible roll). NPC → a deterministic
 *  per-entity fabricated modifier (hidden roll — players never see an NPC's
 *  numbers). Exactly one of `dm`/`npc` is set per the channel contract; the
 *  defensive throw documents the otherwise-unreachable both-absent state. */
function askerProjection(input: WorldLookupGateInput): AskerProjection {
  return input.channel === 'dm' ? dmProjection(input.dm) : npcProjection(input.npc)
}

function dmProjection(dm: WorldLookupGateDmAsker): AskerProjection {
  const { character, skill, skills } = dm
  const entry = KNOWLEDGE_SKILL_MAP[skill]
  const skillRow = skills.find((s) => norm(s.skill_name) === norm(entry.canonical))
  const level = skillRow?.proficiency_level ?? 'none'
  const profBonus =
    level === 'expertise' ? 2 * character.proficiencyBonus
    : level === 'proficient' ? character.proficiencyBonus
    : 0
  const modifier = calculateModifier(character[entry.ability]) + profBonus
  return { modifier, characterName: character.name, skillLabel: entry.canonical, rollHidden: false }
}

function npcProjection(npc: WorldLookupGateNpcAsker): AskerProjection {
  return {
    modifier: fabricatedModifier(npc.entityId),
    characterName: npc.npcName,
    skillLabel: 'Recall',
    rollHidden: true,
  }
}

/** A DETERMINISTIC per-NPC recall modifier in [NPC_FAB_MOD_MIN, NPC_FAB_MOD_MAX]
 *  — sha256(entityId)-seeded so the SAME NPC always gets the SAME modifier
 *  (a stable "how learned is this NPC" fabrication; an NPC has no sheet). */
function fabricatedModifier(entityId: string): number {
  const h = createHash('sha256').update(entityId).digest()
  const span = NPC_FAB_MOD_MAX - NPC_FAB_MOD_MIN + 1
  return NPC_FAB_MOD_MIN + (h.readUInt32BE(0) % span)
}

/** Haiku gate-table call with the §5 fail-soft fallback: on ANY failure (incl.
 *  abort) return a moderate DC table with auto_success FALSE — the
 *  deterministic roll + tier match still run (Principle #5 holds). */
async function fetchGateTable(
  deps: WorldLookupGateDeps,
  input: WorldLookupGateInput,
): Promise<WorldLookupGateResult> {
  try {
    const result = await generateObject({
      model: WORLD_LOOKUP_GATE_MODEL,
      schema: WorldLookupGateResultSchema,
      schemaName: 'WorldLookupGateResultSchema',
      prompt: loadPrompt('session', 'world-lookup-gate', {
        asker_summary: input.askerSummary,
        channel: input.channel,
        world_tone: deps.worldTone,
        topic: input.topic,
      }),
      callSite: 'world-lookup-gate',
      providerOptions: { mythrun: { stage: 'world_lookup_gate', sessionId: deps.sessionId } },
      repairStrategy: 'haiku-then-sonnet',
      timeoutMs: WORLD_LOOKUP_GATE_TIMEOUT_MS,
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    })
    return result.output
  } catch (err) {
    deps.logger?.warn(
      { err, topic: input.topic },
      'world-lookup-gate: gate table failed; using fallback (roll still runs)',
    )
    return {
      auto_success: false,
      dc: GATE_FALLBACK_DC,
      outcomes: { ...GATE_FALLBACK_OUTCOMES },
    }
  }
}
