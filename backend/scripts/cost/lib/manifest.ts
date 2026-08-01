// backend/scripts/cost/lib/manifest.ts
//
// The expected-costs manifest (`backend/scripts/cost/expected-costs.json`)
// loader + the band predicate the runner asserts with.
// Spec: docs/superpowers/specs/2026-07-31-cost-wave1-harness-caching-trims-design.md §1.2.
//
// Strict on shape (structural validation, a ZFC-allowed exception): a typo'd
// key or a missing tolerancePct fails the LOAD — a silently ignored field
// would weaken an assertion without anyone noticing.

import { readFileSync } from 'node:fs'
import { z } from 'zod'

export interface CostEntry {
  readonly tokensIn?: number | undefined
  readonly tokensOut?: number | undefined
  readonly cacheReadMin?: number | undefined
  readonly usd?: number | undefined
  readonly tolerancePct: number
  /** Measured stable-span size for the 4096-minimum cache conditionals
   *  (spec §3): S-2's Haiku cache arms assert only when this ≥ 4096. */
  readonly spanTokens?: number | undefined
}

const costEntrySchema = z.strictObject({
  tokensIn: z.number().nonnegative().optional(),
  tokensOut: z.number().nonnegative().optional(),
  cacheReadMin: z.number().nonnegative().optional(),
  usd: z.number().nonnegative().optional(),
  tolerancePct: z.number().nonnegative(),
  spanTokens: z.number().nonnegative().optional(),
})

const manifestSchema = z.record(z.string(), costEntrySchema)

export function loadManifest(path: string): Record<string, CostEntry> {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    throw new Error(`loadManifest: cannot read ${path}`, { cause: err })
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch (err) {
    throw new Error(`loadManifest: ${path} is not valid JSON`, { cause: err })
  }
  const parsed = manifestSchema.safeParse(json)
  if (!parsed.success) {
    throw new Error(`loadManifest: ${path} failed validation: ${parsed.error.message}`)
  }
  return parsed.data
}

/**
 * Band check: |actual − expected| ≤ expected × tolerancePct/100, boundary
 * inclusive. Throws on non-finite or negative inputs — a NaN comparing false
 * everywhere would read as a silent FAIL (or worse, a silent PASS after a
 * refactor), and the harness's job is to be loud.
 */
export function withinBand(actual: number, expected: number, tolerancePct: number): boolean {
  if (!Number.isFinite(actual) || !Number.isFinite(expected) || !Number.isFinite(tolerancePct)) {
    throw new Error(
      `withinBand: non-finite input (actual=${String(actual)} expected=${String(expected)} tolerancePct=${String(tolerancePct)})`,
    )
  }
  if (expected < 0 || tolerancePct < 0) {
    throw new Error(
      `withinBand: negative expected (${String(expected)}) or tolerancePct (${String(tolerancePct)})`,
    )
  }
  return Math.abs(actual - expected) <= expected * (tolerancePct / 100)
}
