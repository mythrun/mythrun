import { wrapLanguageModel } from 'ai'
import { anthropic } from '@ai-sdk/anthropic'
import { logAndNormalizeMiddleware } from './middleware.js'

// Model IDs match CLAUDE.md's pinned versions. Bumping a version is a
// deliberate spec patch — Anthropic occasionally ships breaking changes
// across model lines (capability shifts, prompt-caching behavior, etc.).
const HAIKU_ID = 'claude-haiku-4-5-20251001'
const SONNET_ID = 'claude-sonnet-4-6'
const OPUS_ID = 'claude-opus-4-7'

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
 */
export const HAIKU = wrapLanguageModel({
  model: anthropic(HAIKU_ID),
  middleware: logAndNormalizeMiddleware(HAIKU_ID),
})

export const SONNET = wrapLanguageModel({
  model: anthropic(SONNET_ID),
  middleware: logAndNormalizeMiddleware(SONNET_ID),
})

export const OPUS = wrapLanguageModel({
  model: anthropic(OPUS_ID),
  middleware: logAndNormalizeMiddleware(OPUS_ID),
})
