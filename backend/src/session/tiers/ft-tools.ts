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
import { MAX_GOLD_TRANSACTION } from '../ft-config.js'
import type { LedgerOps, LedgerTxRunner, RulesLawyerDeps } from '../rules-lawyer.js'
import {
  resolveAcquireResource,
  resolveCastSpell,
  resolveSpendResource,
} from '../rules-lawyer-resources.js'
import {
  resolveAdjustHp,
  resolveTakeRest,
  resolveUpdateCondition,
} from '../rules-lawyer-vitals.js'
import type { ConditionName } from '../../repo/characters-ledger.js'

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

// ---------------------------------------------------------------------------
// MYT-70 §5 — the Rules Lawyer ledger-tool input schemas. Structural validation
// only (ZFC-exempt); the GAME-rule adjudication (XOR, level-iff-exhaustion,
// known/castable, slot selection) lives in the resolvers. Bounds (gold cap,
// hit-dice count) are policy enforcement, not judgment.
// ---------------------------------------------------------------------------

/** The 14 PHB conditions + the leveled `exhaustion` (level handled in the
 *  resolver). Kept in lockstep with the repo's `ConditionName`. */
const CONDITION_NAMES = [
  'blinded',
  'charmed',
  'deafened',
  'exhaustion',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
] as const satisfies readonly ConditionName[]

/** Sane per-call item count — a fat-finger guard mirroring the gold cap. Not a
 *  game rule (stack ceilings are narrative); just a structural sanity bound. */
const MAX_ITEM_TRANSACTION = 99

export const CAST_SPELL_INPUT = z.object({
  character_name: z.string().min(1),
  spell_name: z.string().min(1),
  slot_level: z.number().int().min(1).max(9).optional(),
  ritual: z.boolean().optional(),
})

// NOTE (MYT-70 smoke fix): the model-facing `inputSchema` is a FLAT `z.object`
// with `kind` as an enum discriminator + optional per-kind fields, NOT a
// `z.discriminatedUnion`. The Anthropic tool API requires every tool's
// `input_schema` to have a root `"type": "object"`; Zod 4's `toJSONSchema` emits
// a discriminated union as a root `{oneOf: [...]}` with NO top-level `type`,
// which the API rejects with `tools.N.custom.input_schema.type: Field required`.
// Flattening keeps the schema model-legible (the enum + the field set teach the
// kinds) while the per-kind requirements (gold needs `amount`, item/feature need
// `name`) are enforced in `execute`'s `kind` branch + the TOTAL resolver — the
// SAME resolver-enforced pattern `adjust_hp`'s amount/dice XOR uses (§5 / spec
// ambiguity #5). The RESOLVER's input type stays a discriminated union (internal).
export const SPEND_RESOURCE_INPUT = z.object({
  kind: z.enum(['gold', 'item', 'feature']),
  character_name: z.string().min(1),
  // gold: amount (gp). item: optional amount (default 1). feature: neither.
  name: z.string().min(1).optional(),
  amount: z.number().int().min(1).max(MAX_GOLD_TRANSACTION).optional(),
})

export const ACQUIRE_RESOURCE_INPUT = z.object({
  kind: z.enum(['gold', 'item']),
  character_name: z.string().min(1),
  name: z.string().min(1).optional(),
  amount: z.number().int().min(1).max(MAX_GOLD_TRANSACTION).optional(),
  consumable: z.boolean().optional(),
})

export const ADJUST_HP_INPUT = z.object({
  character_name: z.string().min(1),
  kind: z.enum(['damage', 'heal']),
  // EXACTLY-ONE-OF amount/dice is resolver-enforced — a z.object can't express
  // the XOR cleanly without rejecting valid inputs the resolver fail-softs.
  amount: z.number().int().min(1).optional(),
  dice: z.string().min(1).optional(),
})

export const UPDATE_CONDITION_INPUT = z.object({
  character_name: z.string().min(1),
  condition: z.enum(CONDITION_NAMES),
  action: z.enum(['apply', 'clear']),
  // Required iff exhaustion — the level/exhaustion mismatch is resolver-enforced
  // (structural validation that fail-softs, not a schema reject).
  level: z.number().int().min(1).max(6).optional(),
})

export const TAKE_REST_INPUT = z.object({
  type: z.enum(['short', 'long']),
  hit_dice: z
    .array(
      z.object({
        character_name: z.string().min(1),
        count: z.number().int().min(1).max(20),
      }),
    )
    .optional(),
})

/**
 * `buildFtTools` deps: the skill-check resolver's scoped mechanical projection
 * (minus the per-turn `abortSignal`, which the SDK threads into each `execute`)
 * PLUS the Rules Lawyer's scoped ledger surface. The resolver's `sessionId` is
 * the same one the skill check uses, so it is reused — only `ledger`, `runInTx`,
 * and `turnId` are added. The per-call `toolCallId` is NOT here: the SDK assigns
 * it and passes it into each `execute` (the `ToolExecutionOptions` arg).
 */
export type FtToolDeps = Omit<SkillCheckDeps, 'abortSignal'> & {
  readonly ledger: LedgerOps
  readonly runInTx: LedgerTxRunner
  readonly turnId: string
}

/**
 * Build the FT's tool registry. `deps` is the skill-check resolver's SCOPED
 * mechanical projection (NOT the whole Repo) + session/tone; the per-turn
 * abortSignal is NOT passed here — the SDK threads it into each `execute` call
 * (the 2nd `ToolExecutionOptions` arg) and we forward it to the nested Haiku
 * call. `rng` is injectable for deterministic tests; production omits it and
 * the engine uses crypto.randomInt.
 */
export function buildFtTools(deps: FtToolDeps, rng?: Rng): ToolSet {
  /** Build the per-call Rules Lawyer deps from the closed-over ledger surface +
   *  the SDK-assigned `toolCallId` (the journal idempotency key). `rng` is
   *  conditional-spread for `exactOptionalPropertyTypes` (RulesLawyerDeps.rng is
   *  `rng?`, not `Rng | undefined`). */
  const rulesLawyerDeps = (toolCallId: string): RulesLawyerDeps => ({
    ledger: deps.ledger,
    runInTx: deps.runInTx,
    sessionId: deps.sessionId,
    turnId: deps.turnId,
    toolCallId,
    ...(rng !== undefined ? { rng } : {}),
  })
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
    // -----------------------------------------------------------------------
    // MYT-70 §5 — the Rules Lawyer ledger tools. Each `execute` delegates to a
    // TOTAL resolver and returns its result AS DATA (the §4 `LedgerResolution`
    // / `ConditionResolution` / `TakeRestResolution` shape). On `ok:false` the
    // structured constraint object surfaces unchanged — the model narrates HOW
    // it falls short, never WHETHER; NO throw, NO frame. The SDK-assigned
    // `toolCallId` is threaded into the resolver deps as the §10 idempotency key.
    // -----------------------------------------------------------------------
    cast_spell: tool({
      description:
        'Spend a spell slot to cast a known, prepared D&D 5e spell out of combat. Omit slot_level to ' +
        'use the lowest available slot of sufficient level; pass slot_level to upcast deliberately; pass ' +
        'ritual:true to cast a ritual spell without a slot. The returned constraint is the authoritative ' +
        'outcome — narrate HOW it happens, never whether.',
      inputSchema: CAST_SPELL_INPUT,
      execute: (input, { toolCallId }) =>
        resolveCastSpell(rulesLawyerDeps(toolCallId), {
          character_name: input.character_name,
          spell_name: input.spell_name,
          ...(input.slot_level !== undefined ? { slot_level: input.slot_level } : {}),
          ...(input.ritual !== undefined ? { ritual: input.ritual } : {}),
        }),
    }),
    spend_resource: tool({
      description:
        'Spend a tracked, scarce resource: gold, a tracked consumable/item, or a limited feature use. ' +
        'Do NOT call for improvised or environmental objects — a rock, a mug, a plank torn from a fence; ' +
        'narrate those freely. The returned constraint is the authoritative outcome — narrate HOW it ' +
        'happens, never whether.',
      inputSchema: SPEND_RESOURCE_INPUT,
      execute: (input, { toolCallId }) => {
        const deps2 = rulesLawyerDeps(toolCallId)
        if (input.kind === 'gold') {
          // gold REQUIRES amount; a flat schema can't mark it required-per-kind,
          // so a missing amount is a malformed call → fail-soft (do not narrate
          // a definite spend). Default 1 keeps the debit minimal + safe.
          return resolveSpendResource(deps2, {
            kind: 'gold',
            character_name: input.character_name,
            amount: input.amount ?? 1,
          })
        }
        if (input.kind === 'item') {
          return resolveSpendResource(deps2, {
            kind: 'item',
            character_name: input.character_name,
            name: input.name ?? '',
            // The flat schema's `amount` carries the gold cap; clamp item counts
            // to the tighter per-call item bound here (structural sanity guard).
            ...(input.amount !== undefined
              ? { amount: Math.min(input.amount, MAX_ITEM_TRANSACTION) }
              : {}),
          })
        }
        return resolveSpendResource(deps2, {
          kind: 'feature',
          character_name: input.character_name,
          name: input.name ?? '',
        })
      },
    }),
    acquire_resource: tool({
      description:
        'Credit a character with gold or an item the fiction has granted them (loot, a purchase, a gift). ' +
        'No game-rule validation — this is the credit side of the ledger. Pass consumable:true for an item ' +
        'that gets used up.',
      inputSchema: ACQUIRE_RESOURCE_INPUT,
      execute: (input, { toolCallId }) => {
        const deps2 = rulesLawyerDeps(toolCallId)
        if (input.kind === 'gold') {
          return resolveAcquireResource(deps2, {
            kind: 'gold',
            character_name: input.character_name,
            amount: input.amount ?? 1,
          })
        }
        return resolveAcquireResource(deps2, {
          kind: 'item',
          character_name: input.character_name,
          name: input.name ?? '',
          ...(input.amount !== undefined
            ? { amount: Math.min(input.amount, MAX_ITEM_TRANSACTION) }
            : {}),
          ...(input.consumable !== undefined ? { consumable: input.consumable } : {}),
        })
      },
    }),
    adjust_hp: tool({
      description:
        'Apply damage or healing to one character. Pass amount for a fixed value, or dice (e.g. "2d4+2") ' +
        'for a variable amount — the dice are rolled by the engine; NEVER invent the numbers yourself. ' +
        'HP clamps to [0, max]; hitting 0 auto-applies unconscious. The returned constraint is the ' +
        'authoritative outcome — narrate HOW it happens, never whether.',
      inputSchema: ADJUST_HP_INPUT,
      execute: (input, { toolCallId }) =>
        resolveAdjustHp(rulesLawyerDeps(toolCallId), {
          character_name: input.character_name,
          kind: input.kind,
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
          ...(input.dice !== undefined ? { dice: input.dice } : {}),
        }),
    }),
    update_condition: tool({
      description:
        'Apply or clear a D&D 5e condition on one character (blinded, poisoned, prone, exhaustion, …). ' +
        'Pass level (1–6) only for exhaustion. Clearing unconscious while at 0 HP is rejected — heal them ' +
        'first. The returned constraint is the authoritative outcome — narrate HOW it happens, never whether.',
      inputSchema: UPDATE_CONDITION_INPUT,
      execute: (input, { toolCallId }) =>
        resolveUpdateCondition(rulesLawyerDeps(toolCallId), {
          character_name: input.character_name,
          condition: input.condition,
          action: input.action,
          ...(input.level !== undefined ? { level: input.level } : {}),
        }),
    }),
    take_rest: tool({
      description:
        'Resolve a short or long rest for the WHOLE party (all session participants). For a short rest, ' +
        'pass hit_dice to spend a character’s hit dice for healing; a long rest restores HP, slots, and ' +
        'features. The returned constraint is the authoritative outcome — narrate HOW it happens, never whether.',
      inputSchema: TAKE_REST_INPUT,
      execute: (input, { toolCallId }) =>
        resolveTakeRest(rulesLawyerDeps(toolCallId), {
          type: input.type,
          ...(input.hit_dice !== undefined ? { hit_dice: input.hit_dice } : {}),
        }),
    }),
  }
}
