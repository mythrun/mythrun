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
import {
  runWorldFactLookup,
  type SubstrateResolver,
  type WorldFactLookupVet,
  type WorldFactLookupResult,
} from '../world-fact-lookup.js'
import type {
  WorldLookupGateInput,
  WorldLookupGateDmAsker,
  WorldLookupGateNpcAsker,
  WorldLookupGateDeps,
} from '../world-lookup-gate.js'
import { KNOWLEDGE_SKILLS, type KnowledgeSkill } from '../world-lookup-config.js'
import type { WorkingSetProposal } from '../working-set/types.js'
import type { SearchResolvers } from '../../world/retrieval/search.js'
import { charactersKnownTo, factionTree, type GraphDeps } from '../../world/retrieval/graph.js'
import type { LoreHit, KnownCharacter, FactionNode } from '../../world/retrieval/types.js'
import type { SkillCheckFramePayload } from './types.js'

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
  // ── MYT-72 world-knowledge lookup surface ──
  /** The campaign's world; scopes every lore search + entity-name resolution. */
  readonly worldId: string
  /** searchLore / findSimilarEntities resolvers (the vector-search channel). */
  readonly search: SearchResolvers
  /** charactersKnownTo / factionTree graph-walk dep (the structural channel). */
  readonly graph: GraphDeps
  /** Resolve a colloquial entity name → its id, world-scoped, `null` on no match
   *  (a clean "no such NPC/character/faction" relay — never a throw). */
  readonly resolveEntityId: (name: string) => Promise<string | null>
  /** The recent player-visible narration the ST-vet reasons over (non-secret). */
  readonly recentNarrative: () => string
  /** OPAQUE: the ST-vet closure with the secret `sd_playbook` captured INSIDE.
   *  NEVER the raw playbook — enforced ignorance is structural, so `ft-tools.ts`
   *  has no `sdPlaybook` field and never references a playbook string. */
  readonly vet: WorldFactLookupVet
  /** Build the PUBLIC asker-standing summary the gate reads. Public-only by
   *  construction (the implementation never closes over secret state). */
  readonly askerSummary: (
    channel: 'dm' | 'npc',
    detail: { skill?: KnowledgeSkill; npcName?: string; topic: string },
  ) => Promise<string>
  /** Turn-scoped working-set sink (MYT-73). When a lookup's ST-vet RELAYS or
   *  INVENTS a fact, the tool records the VETTED relay text (already secret-free)
   *  + its tier + channel-derived provenance into the working set. DM channel →
   *  objective; NPC channel → attributed (an NPC's answer is a claim, not ground
   *  truth). NEVER a raw secret — only the orchestrator's vetted relay text. */
  readonly recordInjection: (p: WorkingSetProposal) => void
}

// ---------------------------------------------------------------------------
// MYT-72 §17 — the three Fast-Thinker world-knowledge lookup tools (search_lore,
// characters_known_to, faction_tree). Each tool's `execute` is a PURE RESOLVER
// and TOTAL: it returns DATA ONLY (the §T7 `{ result, skill_gate, roll_hidden }`
// reserved-keys shape), NEVER throws into the FT, NEVER emits a frame. Every
// failure arm degrades to a clean in-fiction relay.
//
// FLAT SCHEMA (same pattern as spend_resource — see the NOTE above): `channel`
// is a flat `z.enum` discriminator + optional per-channel fields, NOT a
// `z.discriminatedUnion` (the Anthropic tool API rejects a root `{oneOf}` with
// no top-level `type`). `execute` branches on `channel`.
//
// ENFORCED IGNORANCE is structural: the secret `sd_playbook` lives ONLY inside
// the opaque `deps.vet` closure. The tool builds the gate + a per-substrate
// resolver, hands them to `runWorldFactLookup`, and only ever receives back
// `{ relayText, skillGateFrame, rollHidden }` — never the over-pulled `results`
// block, never the playbook.
// ---------------------------------------------------------------------------

const CHANNEL = z.enum(['dm', 'npc'])
const DM_SKILL = z.enum(KNOWLEDGE_SKILLS)

// `asker_name` is the CHANNEL-NEUTRAL "who is recalling" field: the recalling
// player character's name on the DM channel, the speaking NPC's name on the NPC
// channel. (It is deliberately NOT `npc_name` — the FT model would never put a
// PC name into a field named for NPCs, so DM-channel recalls would silently
// fail-soft every time.) Required-per-channel, resolver-enforced fail-soft.
export const SEARCH_LORE_INPUT = z.object({
  channel: CHANNEL,
  topic: z.string().min(1),
  // dm channel: the recalling PC + the knowledge skill they use.
  skill: DM_SKILL.optional(),
  asker_name: z.string().min(1).optional(),
})

export const CHARACTERS_KNOWN_TO_INPUT = z.object({
  channel: CHANNEL,
  // The subject whose acquaintances we walk — resolved to an entity id.
  character: z.string().min(1),
  // Optional name post-filter on the walked acquaintances.
  name: z.string().min(1).optional(),
  skill: DM_SKILL.optional(),
  asker_name: z.string().min(1).optional(),
})

export const FACTION_TREE_INPUT = z.object({
  channel: CHANNEL,
  // The faction whose hierarchy we walk — resolved to an entity id.
  faction: z.string().min(1),
  skill: DM_SKILL.optional(),
  asker_name: z.string().min(1).optional(),
})

/** A TOTAL fail-soft tool result — the channel-appropriate in-fiction blank the
 *  model narrates from when the call is malformed or the asker can't be resolved
 *  (vet NOT called). DM and NPC voices differ so the blank reads in-fiction. */
function failSoftResult(channel: 'dm' | 'npc'): {
  result: string
  skill_gate: null
  roll_hidden: boolean
} {
  return {
    result: channel === 'npc' ? "They don't seem to know." : "You can't quite bring it to mind.",
    skill_gate: null,
    roll_hidden: false,
  }
}

/** Shape the orchestrator's result into the §T7 reserved-keys tool result. Only
 *  `result` (the relay) is narrated; `skill_gate`/`roll_hidden` are secret-free
 *  mechanical metadata (roll numbers + a public constraint, never `sd_playbook`). */
function toToolResult(out: WorldFactLookupResult): {
  result: string
  skill_gate: SkillCheckFramePayload | null
  roll_hidden: boolean
} {
  return { result: out.relayText, skill_gate: out.skillGateFrame ?? null, roll_hidden: out.rollHidden }
}

/** The reserved-keys tool result every lookup tool returns. */
interface LookupToolResult {
  readonly result: string
  readonly skill_gate: SkillCheckFramePayload | null
  readonly roll_hidden: boolean
}

/** The per-channel asker fields shared by all three lookup input schemas. */
interface LookupChannelInput {
  readonly channel: 'dm' | 'npc'
  readonly skill?: KnowledgeSkill
  readonly askerName?: string
}

/** A resolved asker, discriminated on `channel` so exactly one arm (the typed DM
 *  or NPC asker) is present and TS narrows it without an assertion. */
type ResolvedAsker =
  | { readonly channel: 'dm'; readonly dm: WorldLookupGateDmAsker; readonly skill: KnowledgeSkill }
  | { readonly channel: 'npc'; readonly npc: WorldLookupGateNpcAsker; readonly npcName: string }

/** Resolve the asker (the one RECALLING) for a lookup, branching on `channel`.
 *  Returns either the resolved asker pieces (success) or a TOTAL fail-soft result
 *  (vet NOT called: a malformed dm call without a skill, or an unresolvable
 *  PC/NPC name). The caller never throws on the fail-soft arm — it returns the
 *  in-fiction relay verbatim.
 *
 *  `askerName` is the CHANNEL-NEUTRAL "who is recalling" field: on the NPC
 *  channel it names the recalling NPC (resolved to an entity id); on the DM
 *  channel it names the recalling player character (resolved off the session
 *  roster via the skill-check `mech`). The flat schema (no root union) can't
 *  mark it required-per-channel, so each arm validates its own presence. */
async function resolveAsker(
  deps: FtToolDeps,
  input: LookupChannelInput,
): Promise<{ ok: true; asker: ResolvedAsker } | { ok: false; failSoft: LookupToolResult }> {
  if (input.channel === 'dm') {
    // dm REQUIRES a knowledge skill AND the recalling PC's name (`askerName`). A
    // missing skill or name is a malformed call → fail-soft (vet NOT run); a flat
    // schema can't enforce either as required-per-channel.
    if (input.skill === undefined || input.askerName === undefined) {
      return { ok: false, failSoft: failSoftResult('dm') }
    }
    const resolved = await deps.mech.findSessionParticipantCharacterByName(
      deps.sessionId,
      input.askerName,
    )
    if (resolved.outcome !== 'found') {
      deps.logger?.warn(
        { characterName: input.askerName, outcome: resolved.outcome },
        'world-lookup: dm asker resolution failed',
      )
      return { ok: false, failSoft: failSoftResult('dm') }
    }
    return {
      ok: true,
      asker: {
        channel: 'dm',
        dm: { character: resolved.character, skill: input.skill, skills: resolved.skills },
        skill: input.skill,
      },
    }
  }
  // npc REQUIRES askerName; resolve it to an entity id (null → no such NPC).
  if (input.askerName === undefined) return { ok: false, failSoft: failSoftResult('npc') }
  const entityId = await deps.resolveEntityId(input.askerName)
  if (entityId === null) {
    deps.logger?.warn({ npcName: input.askerName }, 'world-lookup: npc asker not found')
    return { ok: false, failSoft: failSoftResult('npc') }
  }
  return {
    ok: true,
    asker: { channel: 'npc', npc: { entityId, npcName: input.askerName }, npcName: input.askerName },
  }
}

/** Build the `WorldLookupGateInput` from a resolved asker + the gate's public
 *  asker summary, narrowing on which asker arm is present. Exactly one of
 *  `dm`/`npc` is set per `resolveAsker`'s contract. */
function buildGateInput(
  worldTone: string,
  topic: string,
  askerSummary: string,
  asker: ResolvedAsker,
): WorldLookupGateInput {
  if (asker.channel === 'dm') {
    return { channel: 'dm', topic, worldTone, askerSummary, dm: asker.dm }
  }
  return { channel: 'npc', topic, worldTone, askerSummary, npc: asker.npc }
}

/**
 * Drive one world-knowledge lookup end-to-end: resolve the asker, build the gate
 * + the public asker summary, and call the orchestrator with the per-substrate
 * `resolve` closure. TOTAL — every fail-soft arm returns a clean in-fiction
 * relay; the orchestrator itself never throws. The opaque `deps.vet` (with the
 * secret `sd_playbook` captured inside) is the only path the playbook reaches.
 */
async function runLookup(
  deps: FtToolDeps,
  rng: Rng | undefined,
  abortSignal: AbortSignal | undefined,
  args: {
    readonly channel: 'dm' | 'npc'
    readonly skill?: KnowledgeSkill
    readonly askerName?: string
    readonly topic: string
    readonly question: string
    readonly resolve: SubstrateResolver
  },
): Promise<LookupToolResult> {
  const resolvedAsker = await resolveAsker(deps, {
    channel: args.channel,
    ...(args.skill !== undefined ? { skill: args.skill } : {}),
    ...(args.askerName !== undefined ? { askerName: args.askerName } : {}),
  })
  if (!resolvedAsker.ok) return resolvedAsker.failSoft
  const { asker } = resolvedAsker

  const askerSummary = await deps.askerSummary(asker.channel, {
    topic: args.topic,
    ...(asker.channel === 'dm' ? { skill: asker.skill } : { npcName: asker.npcName }),
  })
  // npcFraming feeds the vet the NPC's public identity/knowledge bounds; empty
  // on the DM channel (objective world truth, no NPC voice to bound).
  const npcFraming = asker.channel === 'npc' ? askerSummary : ''

  const gate = buildGateInput(deps.worldTone, args.topic, askerSummary, asker)
  const gateDeps: WorldLookupGateDeps = {
    worldTone: deps.worldTone,
    ...(rng !== undefined ? { rng } : {}),
    ...(abortSignal !== undefined ? { abortSignal } : {}),
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
  }

  const out = await runWorldFactLookup(
    {
      gateDeps,
      vet: deps.vet,
      worldTone: deps.worldTone,
      ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    },
    {
      gate,
      question: args.question,
      recentNarrative: deps.recentNarrative(),
      npcFraming,
      resolve: args.resolve,
    },
  )

  // MYT-73 — when the ST-vet RELAYED or INVENTED a fact, record it into the
  // working set. We record the VETTED relay text (already secret-free, from the
  // ST-vet) + the ST's tier + channel-derived provenance — NEVER a raw secret.
  // `none`/fail-soft modes carry no fact → nothing recorded. DM channel is
  // objective world truth; an NPC's answer is an attributed claim (the resolved
  // NPC entity id/name come off the asker — the same resolution the gate used).
  if (out.vetMode === 'relay' || out.vetMode === 'invent') {
    deps.recordInjection({
      kind: 'fact',
      content: out.relayText,
      subjectName: args.topic,
      tier: out.vetTier ?? 'known',
      provenance:
        asker.channel === 'dm'
          ? { kind: 'objective' }
          : { kind: 'attributed', npcEntityId: asker.npc.entityId, npcName: asker.npcName },
      source: 'st_injection',
    })
  }
  return toToolResult(out)
}

/** Render a searchLore hit set as the tier-annotated block the ST-vet reads. */
function renderLoreHits(hits: readonly LoreHit[]): string {
  return hits.map((h) => `[tier=${h.accessLevel}] ${h.entityName}: ${h.content}`).join('\n')
}

/** Render a charactersKnownTo result as the tier-annotated block. */
function renderKnownCharacters(chars: readonly KnownCharacter[]): string {
  return chars.map((c) => `[tier=${c.accessLevel}] ${c.name} (depth ${String(c.depth)})`).join('\n')
}

/** Render a factionTree node set as the tier-annotated block, noting truncation. */
function renderFactionNodes(nodes: readonly FactionNode[], truncated: boolean): string {
  const lines = nodes.map(
    (n) =>
      `[tier=${n.accessLevel}] ${n.name} (parent ${n.parentId ?? 'root'}, depth ${String(n.depth)})`,
  )
  if (truncated) lines.push('[note] hierarchy truncated at the depth cap; deeper nodes omitted.')
  return lines.join('\n')
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
    // -----------------------------------------------------------------------
    // MYT-72 §17 — the three world-knowledge lookup tools. Each `execute` is a
    // TOTAL pure resolver: build the per-substrate `resolve` closure (rendering
    // the tier-annotated results block) and call `runLookup`, which drives the
    // gate → resolve → opaque-ST-vet → relay flow. The returned `{ result,
    // skill_gate, roll_hidden }` is DATA ONLY — `result` (the relay) is the only
    // field the FT narrates from; `skill_gate`/`roll_hidden` are secret-free
    // mechanical metadata the consume loop (T7) maps to a skill-check frame.
    // Pass `channel:'dm'` + `skill` + `asker_name`=the recalling PC when a player
    // character recalls; `channel:'npc'` + `asker_name`=the NPC when an NPC does.
    // -----------------------------------------------------------------------
    search_lore: tool({
      description:
        'Recall what is known about a topic, place, person, faction, event, or rumor in the world. ' +
        'Call this BEFORE narrating any world-knowledge an asker would have to RECALL (lore, history, ' +
        'who-someone-is). The returned text is what they know — narrate from it, never beyond it. ' +
        "Set channel='dm' and asker_name=<the recalling player character's name> plus a knowledge skill " +
        '(history, arcana, religion, nature, investigation, medicine, survival, insight) when a player ' +
        "character is recalling; set channel='npc' and asker_name=<the speaking NPC's name> when an NPC " +
        'is conveying what they know.',
      inputSchema: SEARCH_LORE_INPUT,
      execute: (input, { abortSignal }) => {
        const topic = input.topic
        // searchLore is TOTAL (swallows any embed/query throw to []), so it
        // CANNOT distinguish an infra-failure empty from a genuine empty: the
        // search-channel `degraded` is always false in v1 (the spec §7-named
        // gap). The GRAPH closures (below) carry the real degraded signal; the
        // ST-vet's `none` arbitration handles a benign empty result.
        const resolve: SubstrateResolver = async () => {
          const { hits } = await deps.search.searchLore(deps.worldId, topic, {})
          return { results: renderLoreHits(hits), degraded: false, empty: hits.length === 0 }
        }
        return runLookup(deps, rng, abortSignal, {
          channel: input.channel,
          ...(input.skill !== undefined ? { skill: input.skill } : {}),
          ...(input.asker_name !== undefined ? { askerName: input.asker_name } : {}),
          topic,
          question: topic,
          resolve,
        })
      },
    }),
    characters_known_to: tool({
      description:
        'Recall who a given character or NPC is connected to — their known associates, contacts, and ' +
        'relationships. The returned text is who the asker can recall they know — narrate from it, never ' +
        'beyond it. Pass character=the subject whose acquaintances to recall, and optionally name to ' +
        "filter for one specific person. Set channel='dm' and asker_name=<the recalling player " +
        "character's name> plus a knowledge skill when a player character is recalling; set channel='npc' " +
        "and asker_name=<the speaking NPC's name> when an NPC is conveying what they know.",
      inputSchema: CHARACTERS_KNOWN_TO_INPUT,
      execute: async (input, { abortSignal }) => {
        const topic = input.character
        // The subject of the walk is resolved to an entity id; null → no such
        // character (clean relay, vet not called).
        const entityId = await deps.resolveEntityId(input.character)
        if (entityId === null) {
          deps.logger?.warn({ character: input.character }, 'characters_known_to: subject not found')
          return failSoftResult(input.channel)
        }
        const nameFilter = input.name
        // The GRAPH closure catches its own throws → DEGRADED empty (the real
        // resolver_degraded signal §7 wires; searchLore can't set it).
        const resolve: SubstrateResolver = async () => {
          try {
            const chars = await charactersKnownTo(
              deps.graph,
              entityId,
              nameFilter !== undefined ? { nameFilter } : {},
            )
            return {
              results: renderKnownCharacters(chars),
              degraded: false,
              empty: chars.length === 0,
            }
          } catch (err) {
            deps.logger?.warn({ err, entityId }, 'characters_known_to: graph walk failed; degrading')
            return { results: '', degraded: true, empty: true }
          }
        }
        return runLookup(deps, rng, abortSignal, {
          channel: input.channel,
          ...(input.skill !== undefined ? { skill: input.skill } : {}),
          ...(input.asker_name !== undefined ? { askerName: input.asker_name } : {}),
          topic,
          question: `Who is known to ${input.character}?`,
          resolve,
        })
      },
    }),
    faction_tree: tool({
      description:
        'Recall the structure of a faction, organization, or household — its hierarchy, leadership, and ' +
        'membership. The returned text is the structure the asker can recall — narrate from it, never ' +
        "beyond it. Pass faction=the organization to recall. Set channel='dm' and asker_name=<the " +
        "recalling player character's name> plus a knowledge skill when a player character is recalling; " +
        "set channel='npc' and asker_name=<the speaking NPC's name> when an NPC is conveying what they know.",
      inputSchema: FACTION_TREE_INPUT,
      execute: async (input, { abortSignal }) => {
        const topic = input.faction
        const entityId = await deps.resolveEntityId(input.faction)
        if (entityId === null) {
          deps.logger?.warn({ faction: input.faction }, 'faction_tree: subject not found')
          return failSoftResult(input.channel)
        }
        // The GRAPH closure catches its own throws → DEGRADED empty.
        const resolve: SubstrateResolver = async () => {
          try {
            const { nodes, truncated } = await factionTree(deps.graph, entityId)
            return {
              results: renderFactionNodes(nodes, truncated),
              degraded: false,
              empty: nodes.length === 0,
            }
          } catch (err) {
            deps.logger?.warn({ err, entityId }, 'faction_tree: graph walk failed; degrading')
            return { results: '', degraded: true, empty: true }
          }
        }
        return runLookup(deps, rng, abortSignal, {
          channel: input.channel,
          ...(input.skill !== undefined ? { skill: input.skill } : {}),
          ...(input.asker_name !== undefined ? { askerName: input.asker_name } : {}),
          topic,
          question: `What is the structure of ${input.faction}?`,
          resolve,
        })
      },
    }),
  }
}
