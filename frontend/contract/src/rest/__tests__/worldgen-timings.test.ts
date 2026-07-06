import { describe, it, expect } from 'vitest'
import {
  StageTimingSchema,
  StageTimingsResponseSchema,
} from '../worldgen-timings.js'

describe('StageTimingSchema', () => {
  it('parses a { stage, avgMs } row', () => {
    const parsed = StageTimingSchema.parse({ stage: 'concept_intake', avgMs: 4200 })
    expect(parsed).toEqual({ stage: 'concept_intake', avgMs: 4200 })
  })

  it('rejects a negative or non-integer avgMs', () => {
    expect(() => StageTimingSchema.parse({ stage: 'concept_intake', avgMs: -1 })).toThrow()
    expect(() => StageTimingSchema.parse({ stage: 'concept_intake', avgMs: 12.5 })).toThrow()
  })

  it('rejects a missing stage', () => {
    expect(() => StageTimingSchema.parse({ avgMs: 100 })).toThrow()
  })
})

describe('StageTimingsResponseSchema', () => {
  it('parses an array of timings', () => {
    const parsed = StageTimingsResponseSchema.parse([
      { stage: 'concept_intake', avgMs: 4200 },
      { stage: 'embed_world', avgMs: 900 },
    ])
    expect(parsed).toHaveLength(2)
  })

  it('parses the cold-start empty array', () => {
    expect(StageTimingsResponseSchema.parse([])).toEqual([])
  })
})
