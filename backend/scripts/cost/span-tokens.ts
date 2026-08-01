// backend/scripts/cost/span-tokens.ts
//
// Baseline-time helper (cost-wave1 spec §3): TOKEN-COUNT the gate and
// tripwire stable spans and print the numbers to record as `spanTokens` in
// expected-costs.json. Haiku 4.5's minimum cacheable prefix is 4096 tokens —
// below it the provider silently doesn't cache — so S-2's Haiku cache arms
// are CONDITIONAL on these measured values, never assumed.
//
// Span definitions (spec §3):
//   gate     = st-gate.txt instruction head + the FULL sd_playbook
//              (the template is already stable-first; T7 annotates after the
//              playbook span — zero byte changes)
//   tripwire = secret-tripwire.txt instruction head + secrets +
//              publicContext (ft_context) + consistencyContext — the
//              POST-REORDER stable set T7 will hoist above the breakpoint
//
// Content comes from the live dev DB's session_preps row for the fixture
// campaign (run after an S-1/S-4 baseline has produced session-1 prep), with
// secrets/consistency derived via the SAME splitPlaybook the scribe worker
// uses. Counting is the documented count-tokens endpoint against the model
// that actually runs these calls (token counts are model-specific).
//
// Usage: cd backend && pnpm exec tsx --env-file=.env.development scripts/cost/span-tokens.ts

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createPgPool } from '../../src/db/postgres.js'
import { splitPlaybook } from '../../src/session/playbook-split.js'
import { MODEL_PRICING } from '../../src/billing/model-pricing.js'
import { readFixture } from '../smoke/fixtures/load.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROMPTS = resolve(HERE, '../../src/llm/prompts/session')
const MIN_CACHEABLE_SPAN_TOKENS = 4_096

/** The model the gate/tripwire run on. models.ts exports only the wrapped
 *  LanguageModel (HAIKU_ID is module-private), so pin the id here with a
 *  compile-time check against the pricing table — a model bump that removes
 *  this key fails tsc rather than silently counting with a stale tokenizer. */
const HAIKU_MODEL_ID = 'claude-haiku-4-5-20251001' satisfies keyof typeof MODEL_PRICING

function requiredEnv(name: string): string {
  const v = process.env[name]
  if (v === undefined || v === '') throw new Error(`missing env ${name} (use --env-file=.env.development)`)
  return v
}

/** Count tokens via POST /v1/messages/count_tokens (model-specific counts;
 *  the gate/tripwire run on Haiku, so count against that model). */
async function countTokens(apiKey: string, text: string): Promise<number> {
  const res = await fetch('https://api.anthropic.com/v1/messages/count_tokens', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: HAIKU_MODEL_ID, messages: [{ role: 'user', content: text }] }),
  })
  const bodyText = await res.text()
  if (!res.ok) throw new Error(`count_tokens → ${String(res.status)}: ${bodyText}`)
  const { input_tokens } = JSON.parse(bodyText) as { input_tokens: number }
  return input_tokens
}

/** Template text up to (excluding) `marker` — the instruction head. */
function templateHead(file: string, marker: string): string {
  const template = readFileSync(resolve(PROMPTS, file), 'utf8')
  const i = template.indexOf(marker)
  if (i === -1) throw new Error(`${file}: marker ${JSON.stringify(marker)} not found — template drifted; re-derive the span boundary`)
  return template.slice(0, i)
}

async function main(): Promise<void> {
  const apiKey = requiredEnv('ANTHROPIC_API_KEY')
  const databaseUrl = requiredEnv('DATABASE_URL')
  const campaignId = readFixture('ready-to-play-campaign').rootCampaignId

  const pool = createPgPool(databaseUrl)
  let row: { ft_context: string; sd_playbook: string } | undefined
  try {
    // eslint-disable-next-line mythrun/no-raw-db-access -- read-only harness measurement, same tier as the smoke scripts
    const res = await pool.query<{ ft_context: string; sd_playbook: string }>(
      `SELECT ft_context, sd_playbook FROM session_preps
        WHERE campaign_id = $1 ORDER BY session_number DESC LIMIT 1`,
      [campaignId],
    )
    row = res.rows[0]
  } finally {
    await pool.end()
  }
  if (row === undefined) {
    throw new Error(`no session_preps row for fixture campaign ${campaignId} — run an S-1 or S-4 baseline first`)
  }

  const split = splitPlaybook(row.sd_playbook)
  const gateSpan = `${templateHead('st-gate.txt', '## Running summary')}${row.sd_playbook}`
  const tripwireSpan = [
    templateHead('secret-tripwire.txt', 'Player-facing prose this turn:'),
    split.secrets,
    row.ft_context,
    split.consistency,
  ].join('\n')

  const [gateTokens, tripwireTokens] = await Promise.all([
    countTokens(apiKey, gateSpan),
    countTokens(apiKey, tripwireSpan),
  ])

  const verdict = (n: number): string =>
    n >= MIN_CACHEABLE_SPAN_TOKENS ? 'cacheable (≥ 4096)' : 'BELOW the 4096 Haiku minimum — arm stays logged-not-failed'
  process.stdout.write(
    [
      `model ${HAIKU_MODEL_ID} · fixture campaign ${campaignId}`,
      `gate stable span:     ${String(gateTokens)} tokens — ${verdict(gateTokens)}`,
      `tripwire stable span: ${String(tripwireTokens)} tokens — ${verdict(tripwireTokens)}`,
      '',
      'Record these as spanTokens on s2.st_gate_cache / s2.secret_tripwire_cache when T7 flips the arms on.',
      '',
    ].join('\n'),
  )
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
