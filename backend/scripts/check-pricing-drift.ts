// backend/scripts/check-pricing-drift.ts
//
// Daily job: fetch Anthropic pricing docs, extract via Haiku with a Zod
// schema + sanity bounds, diff against MODEL_PRICING. Exit non-zero with
// a clear per-rate diff if anything differs.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md §5.2
// CI:   .github/workflows/llm-pricing-drift.yml (daily 14:00 UTC)
//
// Exit codes:
//   0 — all rates match
//   1 — fetch failed / page format unexpected / unhandled error
//   2 — extracted rate outside sanity bounds (Haiku hallucination guard)
//   3 — drift detected (rate(s) differ from MODEL_PRICING)

import { generateText, Output } from 'ai'
import { z } from 'zod'
import { HAIKU } from '../src/llm/models.js'
import { MODEL_DISPLAY_NAMES, MODEL_PRICING } from '../src/billing/model-pricing.js'
import { loadPrompt } from '../src/llm/prompts.js'

const PRICING_DOC_URL = 'https://platform.claude.com/docs/en/about-claude/pricing'
const PAGE_MARKER = 'MTok'
const USER_AGENT = 'Mythrun-Pricing-Drift/1.0 (ops@mythrun.com)'

// Per-rate sanity bounds. Multiplier-based bounds catch order-of-
// magnitude hallucinations AND wrong-cache-tier confusion (e.g., Haiku
// returning the 1-hour cache write rate, which is 2× input not 1.25×).
const ABSOLUTE_INPUT_RANGE: readonly [number, number] = [0.1, 50]
const ABSOLUTE_OUTPUT_RANGE: readonly [number, number] = [0.5, 250]
const CACHE_WRITE_MULT_RANGE: readonly [number, number] = [1.0, 2.5]
const CACHE_READ_MULT_RANGE: readonly [number, number] = [0.05, 0.2]

// 1e-6 USD/MTok = 1/1000 of a cent per million tokens. Below float
// roundtrip noise; well above our directional-only accuracy threshold.
const DRIFT_EPSILON = 1e-6

const PricingSchema = z.object({
  models: z.array(
    z.object({
      displayName: z.string(),
      inputPerMTok: z.number(),
      outputPerMTok: z.number(),
      cacheWritePerMTok: z.number(),
      cacheReadPerMTok: z.number(),
    }),
  ),
})

async function main(): Promise<void> {
  const pageResponse = await fetch(PRICING_DOC_URL, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'manual',
  })
  if (pageResponse.status >= 300 && pageResponse.status < 400) {
    console.error(
      `pricing-drift: docs URL redirected (status ${String(pageResponse.status)}); manual review required`,
    )
    process.exit(1)
  }
  if (!pageResponse.ok) {
    console.error(`pricing-drift: docs fetch failed ${String(pageResponse.status)}`)
    process.exit(1)
  }
  const pageText = await pageResponse.text()
  if (!pageText.includes(PAGE_MARKER)) {
    console.error(
      `pricing-drift: page does not contain '${PAGE_MARKER}' marker; doc structure may have changed`,
    )
    process.exit(1)
  }

  const result = await generateText({
    model: HAIKU,
    output: Output.object({ schema: PricingSchema }),
    system: loadPrompt('billing', 'pricing-extract'),
    prompt: pageText,
  })

  // Sanity bounds, model-aware. Catches both absolute hallucinations
  // and wrong-cache-tier confusion via multiplier ranges.
  for (const m of result.output.models) {
    if (m.inputPerMTok < ABSOLUTE_INPUT_RANGE[0] || m.inputPerMTok > ABSOLUTE_INPUT_RANGE[1]) {
      bailOnSanity(m.displayName, 'input', m.inputPerMTok, ABSOLUTE_INPUT_RANGE)
    }
    if (m.outputPerMTok < ABSOLUTE_OUTPUT_RANGE[0] || m.outputPerMTok > ABSOLUTE_OUTPUT_RANGE[1]) {
      bailOnSanity(m.displayName, 'output', m.outputPerMTok, ABSOLUTE_OUTPUT_RANGE)
    }
    const cwMult = m.cacheWritePerMTok / m.inputPerMTok
    if (cwMult < CACHE_WRITE_MULT_RANGE[0] || cwMult > CACHE_WRITE_MULT_RANGE[1]) {
      bailOnSanity(m.displayName, 'cacheWrite_mult', cwMult, CACHE_WRITE_MULT_RANGE)
    }
    const crMult = m.cacheReadPerMTok / m.inputPerMTok
    if (crMult < CACHE_READ_MULT_RANGE[0] || crMult > CACHE_READ_MULT_RANGE[1]) {
      bailOnSanity(m.displayName, 'cacheRead_mult', crMult, CACHE_READ_MULT_RANGE)
    }
  }

  const drifts: string[] = []
  const newModels: string[] = []
  for (const m of result.output.models) {
    const slug = MODEL_DISPLAY_NAMES[m.displayName]
    if (!slug) {
      newModels.push(m.displayName)
      continue
    }
    const ours = MODEL_PRICING[slug]
    const checks: [string, number, number][] = [
      ['input', ours.input, m.inputPerMTok],
      ['output', ours.output, m.outputPerMTok],
      ['cacheWrite', ours.cacheWrite, m.cacheWritePerMTok],
      ['cacheRead', ours.cacheRead, m.cacheReadPerMTok],
    ]
    for (const [name, oursRate, theirsRate] of checks) {
      if (Math.abs(oursRate - theirsRate) > DRIFT_EPSILON) {
        drifts.push(
          `${slug}.${name}: ours=${String(oursRate)} docs=${String(theirsRate)} delta=${(theirsRate - oursRate).toFixed(4)}`,
        )
      }
    }
  }
  // Models we track but docs page no longer lists.
  for (const slug of Object.keys(MODEL_PRICING)) {
    const present = result.output.models.some((m) => MODEL_DISPLAY_NAMES[m.displayName] === slug)
    if (!present) {
      drifts.push(`${slug}: not present in docs (model may have been retired or display-name renamed)`)
    }
  }

  for (const m of newModels) {
    console.log(`pricing-drift: new model on docs page (informational): ${m}`)
  }
  if (drifts.length > 0) {
    console.error('pricing-drift: DRIFT DETECTED')
    for (const d of drifts) console.error(`  ${d}`)
    process.exit(3)
  }
  console.log('pricing-drift: OK — all rates match')
}

function bailOnSanity(
  displayName: string,
  field: string,
  val: number,
  range: readonly [number, number],
): never {
  console.error(
    `pricing-drift: ${displayName}.${field} = ${String(val)} outside sanity bounds [${String(range[0])}, ${String(range[1])}]`,
  )
  process.exit(2)
}

main().catch((err: unknown) => {
  console.error('pricing-drift: unhandled error', err)
  process.exit(1)
})
