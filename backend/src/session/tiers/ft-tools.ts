// backend/src/session/tiers/ft-tools.ts
//
// MYT-68 §3.2/§3.3 — the FastThinker tool registry. The two launch tools
// (roll_dice, roll_skill_check) plus the extension point for MYT-70/72/75.
//
// DESIGN RULES (load-bearing — do not relax):
//   - Tools are PURE RESOLVERS. `execute` returns DATA ONLY; it NEVER emits a
//     player-visible frame. The SDK executes tools at internal pipeline pace,
//     ahead of the consumer, so an execute-side publish would race earlier
//     prose. ALL frame emission happens in the FT's consume loop, in
//     stream-part order (§3.2 step 5). There is therefore no TurnEmitter on
//     this seam by construction.
//   - This registry is the EXTENSION POINT: MYT-70/72/75 register their tools
//     by adding entries to the returned ToolSet here.
//   - Parallel tool calls within one step are allowed (multi-character group
//     checks). Part-order emission in the consume loop — not tool ordering —
//     is what keeps player-visible order deterministic.
//
// The LLM never rolls (Principle #4): both tools delegate to the deterministic
// dice engine. roll_skill_check delegates the WHOLE Principle #5 resolution to
// the first-party skill-check resolver, which is TOTAL (never throws) — its
// error arm becomes a tool-result `{ error }` the model narrates around.

import { z } from 'zod'
import { tool, type ToolSet } from '../../llm/ai.js'
import { MAX_DICE_COUNT, rollDice, STANDARD_DICE, type Rng } from '../dice/engine.js'
import { resolveSkillCheck, type SkillCheckDeps } from '../skill-check.js'

export const ROLL_DICE_INPUT = z.object({
  count: z.number().int().min(1).max(MAX_DICE_COUNT),
  sides: z.union(
    // Cast WHY: .map() over the readonly STANDARD_DICE tuple yields
    // ZodLiteral<2|4|...>[] — an array type that can't narrow to z.union's
    // at-least-two tuple parameter, so we assert the tuple shape (runtime
    // length is fixed at 8 by the const tuple).
    STANDARD_DICE.map((s) => z.literal(s)) as unknown as [
      z.ZodLiteral<number>,
      z.ZodLiteral<number>,
      ...z.ZodLiteral<number>[],
    ],
  ),
})

export const ROLL_SKILL_CHECK_INPUT = z.object({
  character_name: z.string().min(1),
  skill: z.string().min(1),
  context: z.string().min(1),
  advantage: z.boolean().optional(),
  disadvantage: z.boolean().optional(),
})

/**
 * Build the FT's tool registry. `deps` is the skill-check resolver's SCOPED
 * mechanical projection (NOT the whole Repo) + session/tone; the per-turn
 * abortSignal is NOT passed here — the SDK threads it into each `execute` call
 * (the 2nd `ToolExecutionOptions` arg) and we forward it to the nested Haiku
 * call. `rng` is injectable for deterministic tests; production omits it and
 * the engine uses crypto.randomInt.
 */
export function buildFtTools(deps: Omit<SkillCheckDeps, 'abortSignal'>, rng?: Rng): ToolSet {
  return {
    roll_dice: tool({
      description:
        'Roll dice for anything except skill checks (damage, wild magic, random effects). Returns the authoritative results.',
      inputSchema: ROLL_DICE_INPUT,
      execute: (input) => {
        const { results, total } = rollDice(input.count, input.sides, rng)
        return Promise.resolve({ count: input.count, sides: input.sides, results, total })
      },
    }),
    roll_skill_check: tool({
      description:
        'Resolve a D&D 5e skill check for one character. Call BEFORE narrating any uncertain attempt. The returned constraint is the authoritative outcome — narrate HOW it happens, never whether.',
      inputSchema: ROLL_SKILL_CHECK_INPUT,
      execute: async (input, { abortSignal }) => {
        // exactOptionalPropertyTypes: the schema infers advantage/disadvantage
        // as `boolean | undefined`, but SkillCheckInput declares them as
        // `boolean?` (no explicit undefined). Conditional-spread the two
        // optionals so an absent flag is OMITTED, not set to `undefined`.
        const resolution = await resolveSkillCheck(
          {
            ...deps,
            ...(rng !== undefined ? { rng } : {}),
            ...(abortSignal !== undefined ? { abortSignal } : {}),
          },
          {
            character_name: input.character_name,
            skill: input.skill,
            context: input.context,
            ...(input.advantage !== undefined ? { advantage: input.advantage } : {}),
            ...(input.disadvantage !== undefined ? { disadvantage: input.disadvantage } : {}),
          },
        )
        if (!resolution.ok) return { error: resolution.errorConstraint }
        const p = resolution.payload
        return {
          character_name: p.characterName,
          skill: p.skill,
          outcome_tier: p.outcomeTier,
          constraint: p.constraint,
          roll: p.roll,
          roll2: p.roll2,
          roll_type: p.rollType,
          modifier: p.modifier,
          total: p.total,
          dc: p.dc,
          context: p.context,
        }
      },
    }),
  }
}
