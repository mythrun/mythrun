// backend/scripts/smoke/myt-75-combat-outcome-smoke.ts
//
// MYT-75 T9 — Smoke A: gated real-Haiku smoke for the combat resolver
// (`resolveCombat`). Proves the `combat-outcome.txt` prompt template + the
// `CombatOutcomeTableSchema` actually work against LIVE Haiku — a mock can't
// catch a prompt/schema mismatch (a renamed field, an out-of-band DC, a tier
// key the prompt forgot to emit), only a real call can. The deterministic roll
// + tier match + envelope are pure code; this smoke validates the ONE LLM seam
// in the combat resolver (the Haiku DC-table fetch).
//
// This is a SMOKE, not an EVAL (feedback_smoke_vs_eval): the assertions are
// deterministic structural checks — DC in [8,22], all four tier prose strings
// present + non-trivial, tier ∈ the four tiers, the envelope matches the tier,
// `total === partyCapability + roll`. We LOG (not assert) the prose QUALITY of
// the four tiers — that's eval territory. We run a small loop so a one-off Haiku
// variance (an empty tier, an off-band DC) is caught rather than slipping
// through on a lucky single sample.
//
// Gated on ANTHROPIC_API_KEY: skips cleanly (exit 0) when absent. Makes NO
// Postgres / Redis / Voyage calls — it is a pure resolver-against-Haiku smoke.
//
// Run:  pnpm smoke:combat-outcome

import { resolveCombat, partyCapability, selectTier, type CombatEnemy, type PartyMember } from '../../src/session/combat/outcome.js'
import { generateObject } from '../../src/llm/ai.js'
import { loadPrompt } from '../../src/llm/prompts.js'
import { SKILL_CHECK_MODEL, SKILL_CHECK_TIMEOUT_MS } from '../../src/session/ft-config.js'
import { CombatOutcomeTableSchema } from '../../src/llm/schemas/combat-outcome.js'
import type { CombatTier, CombatEnvelope, CombatOutcome } from '../../src/redis/session-state.js'

function log(msg: string, extra: Record<string, unknown> = {}): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), msg, ...extra })}\n`)
}

const WORLD_TONE = 'grim and rain-soaked, weathered and terse'
const TIERS: readonly CombatTier[] = ['routed', 'pyrrhic', 'costly', 'decisive']

// The deterministic envelope each tier imposes (mirrors outcome.ts's ENVELOPES —
// duplicated here as the independent oracle the smoke checks the resolver against,
// so a future drift in outcome.ts's table is caught by this smoke).
const EXPECTED_ENVELOPES: Record<CombatTier, CombatEnvelope> = {
  decisive: { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0, allowPcDeathNarration: false },
  costly: { partyWins: true, minDownedPcs: 0, minAggregateHpLossFraction: 0.3, allowPcDeathNarration: false },
  pyrrhic: { partyWins: true, minDownedPcs: 1, minAggregateHpLossFraction: 0.3, allowPcDeathNarration: false },
  routed: { partyWins: false, minDownedPcs: 0, minAggregateHpLossFraction: 0.2, allowPcDeathNarration: true },
}

// A couple of enemies + a small party — public mechanical shapes only (the
// resolver renders ONLY level + HP per member into the prompt; §6).
const ENEMIES: readonly CombatEnemy[] = [
  { name: 'Bandit Captain', description: 'a scarred mercenary in studded leather, scimitar drawn', count: 1 },
  { name: 'Bandit', description: 'a road-worn cutthroat with a shortbow', count: 3 },
]
const PARTY: readonly PartyMember[] = [
  { level: 4, hp: 31, maxHp: 31 },
  { level: 4, hp: 27, maxHp: 30 },
  { level: 3, hp: 22, maxHp: 24 },
]

const LOOPS = 4

function envelopesMatch(a: CombatEnvelope, b: CombatEnvelope): boolean {
  return (
    a.partyWins === b.partyWins &&
    a.minDownedPcs === b.minDownedPcs &&
    a.minAggregateHpLossFraction === b.minAggregateHpLossFraction &&
    a.allowPcDeathNarration === b.allowPcDeathNarration
  )
}

/** Validate ONE real CombatOutcome against the structural envelope. Throws on the
 *  first violation (the run fails loud). Returns nothing — the LOG happens at the
 *  call site so a human can eyeball the prose. */
function assertOutcome(o: CombatOutcome, capability: number): void {
  // DC band — the structural envelope the prompt requests + the schema enforces.
  if (!Number.isInteger(o.dc) || o.dc < 8 || o.dc > 22) {
    throw new Error(`DC out of band: ${String(o.dc)} (expected integer 8..22)`)
  }
  // tier ∈ the four tiers.
  if (!TIERS.includes(o.tier)) {
    throw new Error(`tier not in the four tiers: ${o.tier}`)
  }
  // total === partyCapability + roll (pure-code identity — the dice are
  // authoritative, the LLM never rolls).
  if (o.total !== capability + o.roll) {
    throw new Error(
      `total identity broken: total=${String(o.total)} != capability(${String(capability)}) + roll(${String(o.roll)})`,
    )
  }
  // roll is a single d20 (no advantage in the resolver).
  if (!Number.isInteger(o.roll) || o.roll < 1 || o.roll > 20) {
    throw new Error(`roll out of d20 range: ${String(o.roll)}`)
  }
  // The selected tier matches the deterministic band math against the DC.
  const expectedTier = selectTier(o.total, o.dc)
  if (o.tier !== expectedTier) {
    throw new Error(
      `tier mismatch: resolver returned ${o.tier} but total=${String(o.total)} vs dc=${String(o.dc)} bands to ${expectedTier}`,
    )
  }
  // tierProse present + non-trivial (the schema floors at .min(20); re-check the
  // matched tier's prose is real, not whitespace).
  if (typeof o.tierProse !== 'string' || o.tierProse.trim().length < 20) {
    throw new Error(`tierProse for ${o.tier} is empty/too-short: ${JSON.stringify(o.tierProse)}`)
  }
  // The envelope matches the matched tier (the resolver picked ENVELOPES[tier]).
  if (!envelopesMatch(o.envelope, EXPECTED_ENVELOPES[o.tier])) {
    throw new Error(
      `envelope mismatch for tier ${o.tier}: got ${JSON.stringify(o.envelope)}, expected ${JSON.stringify(EXPECTED_ENVELOPES[o.tier])}`,
    )
  }
}

async function main(): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log('skipped: ANTHROPIC_API_KEY absent (gated real-Haiku combat-outcome smoke)')
    return
  }

  const capability = partyCapability(PARTY)
  log('Smoke A — resolveCombat against REAL Haiku', {
    worldTone: WORLD_TONE,
    enemies: ENEMIES.map((e) => `${String(e.count)}x ${e.name}`),
    party: PARTY.map((p) => `L${String(p.level)} ${String(p.hp)}/${String(p.maxHp)}`),
    partyCapability: capability,
    loops: LOOPS,
  })

  for (let i = 0; i < LOOPS; i += 1) {
    // (1) The FULL raw Haiku table via the SAME prompt + schema the resolver uses
    //     (combat-outcome.txt + CombatOutcomeTableSchema). This is the seam a mock
    //     can't validate: the prompt must emit `dc` + all four tier keys, and the
    //     schema must accept them. We validate + LOG ALL FOUR tier strings (the
    //     resolver only surfaces the matched one). This call is NOT fail-soft (no
    //     try/catch fallback) — a prompt/schema mismatch THROWS here, which is the
    //     point: the smoke fails loud rather than silently using the canned table.
    const { output: table, usage } = await generateObject({
      model: SKILL_CHECK_MODEL,
      schema: CombatOutcomeTableSchema,
      schemaName: 'CombatOutcomeTableSchema',
      prompt: loadPrompt('session', 'combat-outcome', {
        enemies: ENEMIES.map((e) => `${String(e.count)}× ${e.name} (${e.description})`).join('; '),
        party: PARTY.map((p) => `Level ${String(p.level)}, ${String(p.hp)}/${String(p.maxHp)} HP`).join('; '),
        world_tone: WORLD_TONE,
      }),
      callSite: 'smoke-combat-outcome',
      repairStrategy: 'haiku-then-sonnet',
      timeoutMs: SKILL_CHECK_TIMEOUT_MS,
    })
    if (!Number.isInteger(table.dc) || table.dc < 8 || table.dc > 22) {
      throw new Error(`raw table DC out of band: ${String(table.dc)}`)
    }
    for (const tier of TIERS) {
      const prose = table.outcomes[tier]
      if (typeof prose !== 'string' || prose.trim().length < 20) {
        throw new Error(`raw table tier "${tier}" prose empty/too-short: ${JSON.stringify(prose)}`)
      }
    }
    log(`loop ${String(i + 1)}/${String(LOOPS)} — REAL Haiku full outcome table (all four tiers)`, {
      dc: table.dc,
      routed: table.outcomes.routed,
      pyrrhic: table.outcomes.pyrrhic,
      costly: table.outcomes.costly,
      decisive: table.outcomes.decisive,
      totalTokens: (usage as { totalTokens?: number }).totalTokens,
    })

    // (2) The full resolver: real d20 + real Haiku table → matched tier + envelope.
    //     No rng/abortSignal → the REAL engine roll. assertOutcome checks every
    //     identity (DC band, tier ∈ four, total === capability + roll, tier↔band
    //     match, envelope↔tier match, matched prose non-trivial).
    const outcome = await resolveCombat({ worldTone: WORLD_TONE }, ENEMIES, PARTY)
    assertOutcome(outcome, capability)
    log(`loop ${String(i + 1)}/${String(LOOPS)} — resolver: real d20 + real Haiku → matched tier`, {
      dc: outcome.dc,
      roll: outcome.roll,
      partyCapability: capability,
      total: outcome.total,
      matchedTier: outcome.tier,
      envelope: outcome.envelope,
      matchedTierProse: outcome.tierProse,
    })
  }

  log('Smoke A PASS — real Haiku produced a valid combat-outcome table every loop (DC in band, all four tiers present + non-trivial, tier/envelope/total identities hold)')
}

main().catch((err: unknown) => {
  log('Smoke A FAIL — real-Haiku combat-outcome smoke errored', {
    err: err instanceof Error ? err.message : String(err),
  })
  process.exitCode = 1
})
