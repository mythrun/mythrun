// backend/scripts/check-pricing.ts
//
// Daily price-check job: fetch Anthropic pricing docs, extract via Haiku
// with a Zod schema + sanity bounds, diff against MODEL_PRICING. Exit
// non-zero with a clear per-rate diff if anything has drifted.
//
// Spec: docs/superpowers/specs/2026-05-08-myt-43-billing-metering-design.md §5.2
// CI:   .github/workflows/llm-price-check.yml (daily 14:00 UTC)
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
const USER_AGENT = 'Mythrun-Price-Check/1.0 (ops@mythrun.com)'

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
      `price-check: docs URL redirected (status ${String(pageResponse.status)}); manual review required`,
    )
    process.exit(1)
  }
  if (!pageResponse.ok) {
    console.error(`price-check: docs fetch failed ${String(pageResponse.status)}`)
    process.exit(1)
  }
  const pageText = await pageResponse.text()
  if (!pageText.includes(PAGE_MARKER)) {
    console.error(
      `price-check: page does not contain '${PAGE_MARKER}' marker; doc structure may have changed`,
    )
    process.exit(1)
  }

  // The docs page is a Next.js app and ships ~800 KB / ~215 K tokens of
  // bundle, navigation, and SSR-state noise around the actual pricing
  // data, which lives in React Server Component flight chunks (encoded
  // as `<script>self.__next_f.push(...)</script>`). Filter to scripts
  // that mention the 'MTok' rate marker — only ~12 of ~225 scripts —
  // which keeps every visible rate while shrinking the payload by ~95%.
  // Haiku reads RSC flight payloads fine; the structure is stringified
  // JSX with the rates baked in next to the model display names.
  const scripts = [...pageText.matchAll(/<script[\s\S]*?<\/script>/g)].map((m) => m[0])
  const pricingScripts = scripts.filter((s) => s.includes(PAGE_MARKER))
  if (pricingScripts.length === 0) {
    console.error(
      `price-check: no <script> elements contain '${PAGE_MARKER}'; page structure may have changed`,
    )
    process.exit(1)
  }
  const extractedContent = pricingScripts.join('\n')

  const result = await generateText({
    model: HAIKU,
    output: Output.object({ schema: PricingSchema }),
    system: loadPrompt('billing', 'pricing-extract'),
    prompt: extractedContent,
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
      drifts.push(
        `${slug}: not present in docs (model may have been retired or display-name renamed)`,
      )
    }
  }

  for (const m of newModels) {
    console.log(`price-check: new model on docs page (informational): ${m}`)
  }
  if (drifts.length > 0) {
    console.error('price-check: DRIFT DETECTED')
    for (const d of drifts) console.error(`  ${d}`)
    process.exit(3)
  }
  console.log('price-check: OK — all rates match')
}

function bailOnSanity(
  displayName: string,
  field: string,
  val: number,
  range: readonly [number, number],
): never {
  console.error(
    `price-check: ${displayName}.${field} = ${String(val)} outside sanity bounds [${String(range[0])}, ${String(range[1])}]`,
  )
  process.exit(2)
}

main().catch((err: unknown) => {
  console.error('price-check: unhandled error', err)
  process.exit(1)
})
