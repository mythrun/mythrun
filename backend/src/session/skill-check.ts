// backend/src/session/skill-check.ts
//
// MYT-68 §3.5 — the roll_skill_check resolver (Principle #5: Haiku pre-
// generates the DC outcome table; code rolls deterministically; the matched
// tier is the FT's constraint). TOTAL: every failure arm returns a structured
// error-constraint — an uncaught throw would surface as a tool-error part the
// loop CONTINUES past, letting the model narrate an outcome with no roll
// (a Principle #4/#5 violation). The injected `mech` dep is a SCOPED
// mechanical projection, not the whole Repo (§8 tool-result channel bound).

import { generateObject } from '../llm/ai.js'
import { loadPrompt } from '../llm/prompts.js'
import { SkillCheckResultSchema, type SkillCheckResult } from '../llm/schemas/skill-check.js'
import {
  FALLBACK_DC, FALLBACK_OUTCOMES, SKILL_CHECK_MODEL, SKILL_CHECK_TIMEOUT_MS,
} from './ft-config.js'
import {
  calculateModifier, resolveRollType, rollD20WithType, type Rng,
} from './dice/engine.js'
import type { Character } from '../repo/types.js'
import type { SkillCheckFramePayload } from './tiers/types.js'

type AbilityKey = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha'

/** Canonical 5e skill list, keyed by normalized (lower/trimmed) name. */
const SKILL_ABILITIES = new Map<string, { canonical: string; ability: AbilityKey }>(
  (
    [
      ['Athletics', 'str'], ['Acrobatics', 'dex'], ['Sleight of Hand', 'dex'],
      ['Stealth', 'dex'], ['Arcana', 'int'], ['History', 'int'],
      ['Investigation', 'int'], ['Nature', 'int'], ['Religion', 'int'],
      ['Animal Handling', 'wis'], ['Insight', 'wis'], ['Medicine', 'wis'],
      ['Perception', 'wis'], ['Survival', 'wis'], ['Deception', 'cha'],
      ['Intimidation', 'cha'], ['Performance', 'cha'], ['Persuasion', 'cha'],
    ] as const
  ).map(([canonical, ability]) => [canonical.toLowerCase(), { canonical, ability }]),
)

const norm = (s: string): string => s.trim().toLowerCase()

export interface MechanicalReads {
  findSessionParticipantCharacterByName(
    sessionId: string,
    characterName: string,
  ): Promise<
    | { outcome: 'found'; character: Character; skills: readonly { skill_name: string; proficiency_level: string }[] }
    | { outcome: 'not_found' }
    | { outcome: 'ambiguous' }
  >
}

export interface SkillCheckDeps {
  readonly mech: MechanicalReads
  readonly sessionId: string
  readonly worldTone: string
  readonly rng?: Rng
  readonly abortSignal?: AbortSignal
  readonly logger?: { warn: (o: Record<string, unknown>, m: string) => void }
}

export interface SkillCheckInput {
  readonly character_name: string
  readonly skill: string
  readonly context: string
  readonly advantage?: boolean
  readonly disadvantage?: boolean
}

export type SkillCheckResolution =
  | { readonly ok: true; readonly payload: SkillCheckFramePayload }
  | { readonly ok: false; readonly errorConstraint: string }

const UNRESOLVED =
  'This check could not be resolved. Do not narrate a definite success or failure for this attempt.'

export async function resolveSkillCheck(
  deps: SkillCheckDeps,
  input: SkillCheckInput,
): Promise<SkillCheckResolution> {
  const skillEntry = SKILL_ABILITIES.get(norm(input.skill))
  if (skillEntry === undefined) {
    deps.logger?.warn({ skill: input.skill }, 'skill-check: unknown skill')
    return { ok: false, errorConstraint: `Unknown skill "${input.skill}". ${UNRESOLVED}` }
  }

  const resolved = await deps.mech.findSessionParticipantCharacterByName(
    deps.sessionId, input.character_name,
  )
  if (resolved.outcome !== 'found') {
    deps.logger?.warn(
      { characterName: input.character_name, outcome: resolved.outcome },
      'skill-check: roller resolution failed',
    )
    return {
      ok: false,
      errorConstraint: `Could not identify the character "${input.character_name}". ${UNRESOLVED}`,
    }
  }

  const { character, skills } = resolved
  // §3.5 step 2 — normalize BOTH sides of the skill join (character_skills.
  // skill_name is itself LLM output); absent row → none. Expertise = 2×PB
  // (DIVERGES FROM THE PROTOTYPE, which flattened to a boolean).
  const skillRow = skills.find((s) => norm(s.skill_name) === norm(input.skill))
  const level = skillRow?.proficiency_level ?? 'none'
  const profBonus =
    level === 'expertise' ? 2 * character.proficiencyBonus
    : level === 'proficient' ? character.proficiencyBonus
    : 0
  const abilityScore = character[skillEntry.ability]
  const modifier = calculateModifier(abilityScore) + profBonus

  const table = await fetchDcTable(deps, input, character, skills)

  const rollType = resolveRollType(input.advantage === true, input.disadvantage === true)
  const d20 = rollD20WithType(rollType, deps.rng)
  const total = d20.keptRoll + modifier
  const outcomeTier: 'fail' | 'success' | 'great_success' =
    total >= table.dc + 5 ? 'great_success' : total >= table.dc ? 'success' : 'fail'

  return {
    ok: true,
    payload: {
      characterName: character.name,
      skill: skillEntry.canonical,
      context: input.context,
      roll: d20.roll,
      roll2: d20.roll2,
      rollType,
      modifier,
      total,
      dc: table.dc,
      outcomeTier,
      constraint: table.outcomes[outcomeTier],
    },
  }
}

/** Haiku DC table with the §5(a) fail-soft fallback: on ANY failure (incl.
 *  abort) return the tier-neutral table — the deterministic roll + tier match
 *  still execute, so Principle #5's "roll then match" holds. */
async function fetchDcTable(
  deps: SkillCheckDeps,
  input: SkillCheckInput,
  character: Character,
  skills: readonly { skill_name: string; proficiency_level: string }[],
): Promise<SkillCheckResult> {
  const characterSummary =
    `${character.name} (Level ${String(character.level)} ${character.class}) — ` +
    `STR ${String(character.str)}, DEX ${String(character.dex)}, CON ${String(character.con)}, ` +
    `INT ${String(character.int)}, WIS ${String(character.wis)}, CHA ${String(character.cha)} — ` +
    `Proficiency Bonus: +${String(character.proficiencyBonus)} — ` +
    `Proficient skills: ${skills.filter((s) => s.proficiency_level !== 'none').map((s) => s.skill_name).join(', ') || 'none'}`
  try {
    const result = await generateObject({
      model: SKILL_CHECK_MODEL,
      schema: SkillCheckResultSchema,
      schemaName: 'SkillCheckResultSchema',
      prompt: loadPrompt('session', 'skill-check', {
        character_summary: characterSummary,
        world_tone: deps.worldTone,
        skill: input.skill,
        context: input.context,
      }),
      callSite: 'ft-skill-check',
      providerOptions: { mythrun: { stage: 'skill_check_dc', sessionId: deps.sessionId } },
      repairStrategy: 'haiku-then-sonnet',
      timeoutMs: SKILL_CHECK_TIMEOUT_MS,
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    })
    return result.output
  } catch (err) {
    deps.logger?.warn({ err, skill: input.skill }, 'skill-check: DC table failed; using fallback')
    return { dc: FALLBACK_DC, outcomes: { ...FALLBACK_OUTCOMES } }
  }
}
