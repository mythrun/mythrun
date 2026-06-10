// backend/src/llm/schemas/__tests__/st-director.test.ts
import { describe, expect, it } from 'vitest'
import { StDirectorResultSchema } from '../st-director.js'

const base = {
  reasoning: 'Hobb has warmed; an earned reveal is appropriate.',
  intervene: true,
  direction: "Hobb can mention he saw the bargehand poking the east walkway; beyond that he's said all he'll say.",
  standingDirective: { action: 'keep', text: null },
  summaryUpdate: 'The party has been drinking with Hobb; he has gone from curt to chatty. Evening over Saltgate.',
}

describe('StDirectorResultSchema', () => {
  it('accepts a full intervene-with-reveal result', () => {
    expect(StDirectorResultSchema.safeParse(base).success).toBe(true)
  })
  it('accepts a no-intervene pass-through (null direction, keep standing)', () => {
    expect(
      StDirectorResultSchema.safeParse({ ...base, intervene: false, direction: null }).success,
    ).toBe(true)
  })
  it('accepts standingDirective set/clear/keep', () => {
    expect(StDirectorResultSchema.safeParse({ ...base, standingDirective: { action: 'set', text: 'Steer toward a close.' } }).success).toBe(true)
    expect(StDirectorResultSchema.safeParse({ ...base, standingDirective: { action: 'clear', text: null } }).success).toBe(true)
  })
  it('rejects an unknown standing action and an empty summary', () => {
    expect(StDirectorResultSchema.safeParse({ ...base, standingDirective: { action: 'wat', text: null } }).success).toBe(false)
    expect(StDirectorResultSchema.safeParse({ ...base, summaryUpdate: '' }).success).toBe(false)
    expect(StDirectorResultSchema.safeParse({ ...base, reasoning: '' }).success).toBe(false)
  })
  // NOTE: the set-requires-text / non-set-requires-null constraint is validated
  // in CODE (by the worker), NOT via .refine — the schema stays refine-free so
  // the repair chain can't author a "valid" tree (§4 repair posture).
})
