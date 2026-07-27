import { wrapLanguageModel } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { logAndNormalizeMiddleware } from './middleware.js'
import { costAccountingMiddleware } from './cost-middleware.js'

// THIS FILE IS THE PIN. CLAUDE.md names tiers (Sonnet for the FT, Opus for the
// ST, Haiku for routing) but deliberately not versions, so these three
// constants are the only place a version is chosen. Bumping one is a deliberate
// spec patch — Anthropic ships breaking changes across model lines (capability
// shifts, prompt-caching minimums, tokenizer changes, sampling-parameter
// removals), so a bump means re-reading the migration notes, not just editing a
// string.
//
// 2026-07-26: Sonnet 4.6 -> Sonnet 5, Opus 4.7 -> Opus 5. Haiku 4.5 is
// unchanged (it remains the current Haiku; there is no Haiku 5). Three
// behavioral consequences, all verified against the live API rather than
// taken from release notes:
//
//  1. THINKING IS ON BY DEFAULT. On 4.6/4.7, omitting the `thinking`
//     parameter meant no thinking. On the 5 line, omitting it runs ADAPTIVE
//     thinking. We omit it everywhere, so every tier now thinks. This is the
//     capability we're upgrading for, but it means `maxOutputTokens` is a
//     ceiling on thinking + visible output TOGETHER — a cap sized for the
//     answer alone can now truncate mid-thought. See the raised caps in
//     scribe-config / world-lookup-config / st-config.
//  2. SAMPLING PARAMETERS ARE REJECTED. `temperature`/`top_p`/`top_k` 400 on
//     both models. They already 400'd on Opus 4.7 — our prep stages passed
//     temperature anyway and never noticed, because @ai-sdk/anthropic SILENTLY
//     DROPS unsupported sampling params. Verified: a raw request with
//     temperature 0.9 to opus-4-7 returns 400 `temperature is deprecated for
//     this model`, while the same call through our stack returns 200. Those
//     settings were therefore already dead and have been removed rather than
//     carried forward as a landmine.
//  3. SONNET 5 RETOKENIZES. Measured on our own prompt text (6KB of
//     prep/starting-situation.txt): 1175 tokens on Sonnet 4.6 -> 1593 on
//     Sonnet 5, +35.6%. Opus is unchanged (1598 -> 1593, same tokenizer as
//     4.7). Anything measured or budgeted in FT tokens therefore buys ~26%
//     less prose per token: SESSION_TOKEN_BUDGET, the FT context ceiling, and
//     the session-progress fraction all shift. Those are product/pricing
//     decisions, so the constants are deliberately NOT auto-scaled here.
const HAIKU_ID = 'claude-haiku-4-5-20251001'
// Exported for the same reason as OPUS_ID below.
export const SONNET_ID = 'claude-sonnet-5'
// Exported so cost-computing call sites reference the config constant instead of
// re-typing the id string (CLAUDE.md: never hardcode model names). It doubles as
// a `model-pricing.Model` pricing key.
export const OPUS_ID = 'claude-opus-5'

// Opus 5's real max-output ceiling is 128K tokens (streaming required at this
// size — the SDK HTTP-times-out on large non-streamed outputs; the session-prep
// call already streams via streamObject). Exposed as a config constant so the
// prep call — whose structured output grows with accumulated campaign canon —
// can pin its ceiling to the model max instead of a low fixed cap that becomes a
// long-campaign scaling wall. myth-vb2ov: a 16,384 cap truncated prep mid-schema
// around session ~10 as the omniscient world dump grew; the fix bounds the growth
// (working-set input tiering + output-budget prompt framing) AND raises the cap so
// the ceiling is a genuine backstop, not the routine failure mode.
export const OPUS_MAX_OUTPUT_TOKENS = 128_000

/**
 * Tier-named language model constants. Each is the underlying Anthropic
 * model wrapped with `logAndNormalizeMiddleware` so consumers get cost
 * + latency logging and Mythrun-typed errors automatically.
 *
 * Callers use Vercel's SDK functions directly (`generateText`,
 * `generateObject`, etc.) and pass these constants as the `model`
 * parameter. Adding a new model in the future = either bumping a tier ID
 * or adding a new tier-named export here. No call site outside this file
 * references a model ID string.
 *
 * Middleware order matters: the array's LAST entry wraps the raw model
 * (innermost), the FIRST wraps outermost (see wrapLanguageModel: it reverse-
 * reduces the array). costAccountingMiddleware is LAST so it observes the
 * provider's raw usage object directly; logAndNormalizeMiddleware is the outer
 * error/logging boundary.
 */
export const HAIKU = wrapLanguageModel({
  model: anthropic(HAIKU_ID),
  middleware: [logAndNormalizeMiddleware(HAIKU_ID), costAccountingMiddleware(HAIKU_ID)],
})

export const SONNET = wrapLanguageModel({
  model: anthropic(SONNET_ID),
  middleware: [logAndNormalizeMiddleware(SONNET_ID), costAccountingMiddleware(SONNET_ID)],
})

export const OPUS = wrapLanguageModel({
  model: anthropic(OPUS_ID),
  middleware: [logAndNormalizeMiddleware(OPUS_ID), costAccountingMiddleware(OPUS_ID)],
})
