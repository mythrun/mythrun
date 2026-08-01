// backend/scripts/cost/lib/__tests__/usd.test.ts
//
// The NORMATIVE per-call USD derivation (cost-wave1 spec §1.1(4)): logged
// `inputTokens` is the SDK SUM (noCache + cacheRead + cacheWrite), so the
// base priced at the input rate is inputTokens − cacheRead − cacheWrite;
// cacheRead at the cache-read rate; cacheWrite at 1.25× input; output at the
// output rate. Prices come ONLY from backend/src/billing/model-pricing.ts
// (sticker rates, held deliberately — see that file's intro-pricing note).

import { describe, expect, it } from 'vitest'
import { callUsd } from '../usd.js'
import type { LlmCallLine } from '../extract.js'

function line(fields: Partial<LlmCallLine> & Pick<LlmCallLine, 'model'>): LlmCallLine {
  return { time: 1785500000000, inputTokens: 0, outputTokens: 0, ...fields }
}

describe('callUsd', () => {
  it('prices the FT baseline shape at sticker rates (~$0.39, not the ~$0.24 intro figure)', () => {
    // Hand-computed sticker-rate oracle (spec §1.1(4); Sonnet 5 sticker
    // $3/MTok input, $15/MTok output, $0.30/MTok cache-read):
    //   base   = 428,189 − 388,010 − 0 = 40,179 → 40,179 × $3.00 / 1e6 = $0.120537
    //   read   =                          388,010 × $0.30 / 1e6        = $0.116403
    //   output =                          10,405  × $15.00 / 1e6       = $0.156075
    //   total                                                          = $0.393015
    // The naive reading (428,189 all at the input rate) would give
    // 428,189 × $3 / 1e6 + $0.156075 = $1.440642 — 3.7× wrong, which is
    // exactly the mistake the spec calls out.
    const usd = callUsd(
      line({
        model: 'claude-sonnet-5',
        inputTokens: 428_189,
        outputTokens: 10_405,
        cacheReadTokens: 388_010,
      }),
    )
    expect(usd).toBeCloseTo(0.393015, 9)
  })

  it('prices cache writes at the 1.25× write rate', () => {
    // Hand-computed (Haiku 4.5: $1 input, $5 output, $1.25 cache-write,
    // $0.10 cache-read per MTok):
    //   base   = 10,000 − 4,000 − 2,000 = 4,000 → 4,000 × $1.00 / 1e6 = $0.004000
    //   read   =                           4,000 × $0.10 / 1e6        = $0.000400
    //   write  =                           2,000 × $1.25 / 1e6        = $0.002500
    //   output =                           500   × $5.00 / 1e6        = $0.002500
    //   total                                                         = $0.009400
    const usd = callUsd(
      line({
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 2_000,
      }),
    )
    expect(usd).toBeCloseTo(0.0094, 10)
  })

  it('treats missing cacheRead/cacheWrite as zero (whole input priced at the input rate)', () => {
    // Hand-computed (Opus 5: $5 input, $25 output per MTok):
    //   base   = 1,000 × $5.00 / 1e6 = $0.005000
    //   output = 100   × $25.00 / 1e6 = $0.002500
    //   total                         = $0.007500
    const usd = callUsd(line({ model: 'claude-opus-5', inputTokens: 1_000, outputTokens: 100 }))
    expect(usd).toBeCloseTo(0.0075, 12)
  })

  it('prices a multi-model run per line against each model’s own rates', () => {
    // Sum of the three hand-computed oracles above:
    //   $0.393015 + $0.009400 + $0.007500 = $0.409915
    const lines: LlmCallLine[] = [
      line({
        model: 'claude-sonnet-5',
        inputTokens: 428_189,
        outputTokens: 10_405,
        cacheReadTokens: 388_010,
      }),
      line({
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 10_000,
        outputTokens: 500,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 2_000,
      }),
      line({ model: 'claude-opus-5', inputTokens: 1_000, outputTokens: 100 }),
    ]
    const total = lines.reduce((sum, l) => sum + callUsd(l), 0)
    expect(total).toBeCloseTo(0.409915, 9)
  })

  it('throws on a model absent from MODEL_PRICING (never guesses a price)', () => {
    expect(() => callUsd(line({ model: 'claude-nonexistent-1', inputTokens: 10 }))).toThrow(
      /not in MODEL_PRICING/,
    )
  })

  it('throws when inputTokens is smaller than cacheRead + cacheWrite (sum premise violated)', () => {
    expect(() =>
      callUsd(
        line({
          model: 'claude-sonnet-5',
          inputTokens: 100,
          outputTokens: 10,
          cacheReadTokens: 90,
          cacheWriteTokens: 20,
        }),
      ),
    ).toThrow(/SDK sum/)
  })
})
