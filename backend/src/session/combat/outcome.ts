// backend/src/session/combat/outcome.ts
//
// MYT-75 §4 — the combat resolver (Principle #5: a whole fight resolves as one
// big skill check). Mirrors the validated skill-check resolver: Haiku pre-
// generates a DC + four tiered outcome descriptions, deterministic code rolls a
// d20 + a derived party-capability modifier, and the matched tier — with its
// hard `CombatEnvelope` — becomes the FT's combat constraint. The LLM never
// rolls (Principle #4); it only frames the tiers. The fetch is fail-soft: on
// ANY Haiku failure (incl. abort) the resolver falls back to a tier-neutral
// table, so the deterministic roll + tier match still execute.

import { rollD20WithType, type Rng } from '../dice/engine.js'
import { generateObject } from '../../llm/ai.js'
import { loadPrompt } from '../../llm/prompts.js'
import { SKILL_CHECK_MODEL, SKILL_CHECK_TIMEOUT_MS } from '../ft-config.js'
import { CombatOutcomeTableSchema, type CombatOutcomeTable } from '../../llm/schemas/combat-outcome.js'
import type { CombatTier, CombatOutcome, CombatEnvelope } from '../../redis/session-state.js'

export interface PartyMember {
  readonly level: number
  readonly hp: number
  readonly maxHp: number
}

export interface CombatEnemy {
  readonly name: string
  readonly description: string
  readonly count: number
}

/** §4 fail-soft: the resolver's fallback table when Haiku fails/aborts. A
 *  mid-band DC plus four generic-but-distinct tier descriptions — the one place
 *  code picks values Principle #5 normally delegates. */
const FALLBACK_COMBAT_DC = 15
const FALLBACK_COMBAT_OUTCOMES = {
  routed: 'The party is overwhelmed and forced to flee or fall, but survives to recover.',
  pyrrhic: 'The party wins, but at least one member is downed and the cost is severe.',
  costly: 'The party wins the fight, but takes real injuries and spends hard-won resources.',
  decisive: 'The party wins cleanly, controlling the field with little lasting harm.',
} as const

/** The hard constraints each tier imposes on the FT's combat prose. routed is
 *  the only tier that permits PC-death narration, and even there it is rare. */
const ENVELOPES: Record<CombatTier, CombatEnvelope> = {
  decisive: { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0, allowPcDeathNarration: false },
  costly: { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0.30, allowPcDeathNarration: false },
  pyrrhic: { partyWins: true, minDownedPcs: 1, minAggregateHpLossFraction: 0.30, allowPcDeathNarration: false },
  routed: { partyWins: false, minDownedPcs: 0, minAggregateHpLossFraction: 0.20, allowPcDeathNarration: true },
}

/** Derive a 0..12 party-capability modifier (the combat analogue of a skill
 *  check's ability + proficiency modifier). Average level, a small bonus for a
 *  larger party, and a malus when the party is already badly wounded. */
export function partyCapability(party: readonly PartyMember[]): number {
  if (party.length === 0) return 0
  const avgLevel = Math.round(party.reduce((s, p) => s + p.level, 0) / party.length)
  const sizeBonus = party.length >= 5 ? 2 : party.length >= 3 ? 1 : 0
  const totalHp = party.reduce((s, p) => s + p.hp, 0)
  const totalMax = party.reduce((s, p) => s + p.maxHp, 0)
  const woundedMalus = totalMax > 0 && totalHp / totalMax < 0.5 ? -2 : 0
  return Math.max(0, Math.min(12, avgLevel + sizeBonus + woundedMalus))
}

/** Map a roll total against the DC to one of the four combat tiers. The bands
 *  mirror the skill-check great-success/success split, widened to four tiers:
 *  decisive at DC+7, costly at the DC, pyrrhic within 7 below, routed beyond. */
export function selectTier(total: number, dc: number): CombatTier {
  if (total >= dc + 7) return 'decisive'
  if (total >= dc) return 'costly'
  if (total >= dc - 7) return 'pyrrhic'
  return 'routed'
}

export interface ResolveCombatDeps {
  readonly worldTone: string
  /** Cost-harness scope id (cost wave 1 §1.0) — rides providerOptions.mythrun
   *  only, NEVER the prompt. */
  readonly sessionId: string
  readonly rng?: Rng
  readonly abortSignal?: AbortSignal
  readonly logger?: { warn: (o: unknown, m: string) => void }
}

export async function resolveCombat(
  deps: ResolveCombatDeps,
  enemies: readonly CombatEnemy[],
  party: readonly PartyMember[],
): Promise<CombatOutcome> {
  const table = await fetchOutcomeTable(deps, enemies, party)
  const d20 = rollD20WithType('normal', deps.rng)
  const total = partyCapability(party) + d20.keptRoll
  const tier = selectTier(total, table.dc)
  return {
    tier,
    dc: table.dc,
    roll: d20.keptRoll,
    total,
    tierProse: table.outcomes[tier],
    envelope: ENVELOPES[tier],
  }
}

/** Render the enemy roster for the Haiku prompt (public mechanical shape). */
function renderEnemies(enemies: readonly CombatEnemy[]): string {
  if (enemies.length === 0) return 'no enemies'
  return enemies
    .map((e) => `${String(e.count)}× ${e.name} (${e.description})`)
    .join('; ')
}

/** Public projection of the party for the Haiku prompt — ONLY level + HP per
 *  member (§6). No secret/plot fields ever reach this call. */
function renderPartyPublic(party: readonly PartyMember[]): string {
  if (party.length === 0) return 'no party members'
  return party
    .map((p) => `Level ${String(p.level)}, ${String(p.hp)}/${String(p.maxHp)} HP`)
    .join('; ')
}

/** Haiku combat-outcome table with the §4 fail-soft fallback: on ANY failure
 *  (incl. abort) return the tier-neutral table — the deterministic roll + tier
 *  match still execute, so Principle #5's "roll then match" holds. */
async function fetchOutcomeTable(
  deps: ResolveCombatDeps,
  enemies: readonly CombatEnemy[],
  party: readonly PartyMember[],
): Promise<CombatOutcomeTable> {
  try {
    const result = await generateObject({
      model: SKILL_CHECK_MODEL,
      schema: CombatOutcomeTableSchema,
      schemaName: 'CombatOutcomeTableSchema',
      prompt: loadPrompt('session', 'combat-outcome', {
        enemies: renderEnemies(enemies),
        party: renderPartyPublic(party),
        world_tone: deps.worldTone,
      }),
      callSite: 'ft-combat-outcome',
      providerOptions: { mythrun: { stage: 'ft_combat_outcome', sessionId: deps.sessionId } },
      repairStrategy: 'haiku-then-sonnet',
      timeoutMs: SKILL_CHECK_TIMEOUT_MS,
      ...(deps.abortSignal !== undefined ? { abortSignal: deps.abortSignal } : {}),
    })
    return result.output
  } catch (err) {
    deps.logger?.warn({ err }, 'combat-outcome: DC table failed; using fallback')
    return { dc: FALLBACK_COMBAT_DC, outcomes: { ...FALLBACK_COMBAT_OUTCOMES } }
  }
}
