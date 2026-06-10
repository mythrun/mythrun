// backend/src/llm/schemas/__tests__/st-gate.test.ts
//
// MYT-69 §3 — the Haiku gate verdict schema. confidence is bounded to [0,1]
// (structural validation, ZFC-exempt); reason carries a .min(1) prose floor and
// NO .max (free-prose fields are never length-capped — feedback_no_max_on_llm_prose_fields).

import { describe, expect, it } from 'vitest'
import { StGateResultSchema } from '../st-gate.js'

const valid = { needed: true, confidence: 0.7, reason: 'small talk warming with a playbook NPC' }

describe('StGateResultSchema', () => {
  it('accepts a valid verdict', () => {
    expect(StGateResultSchema.safeParse(valid).success).toBe(true)
  })
  it('bounds confidence to [0,1] (structural, ZFC-exempt)', () => {
    expect(StGateResultSchema.safeParse({ ...valid, confidence: 1.2 }).success).toBe(false)
    expect(StGateResultSchema.safeParse({ ...valid, confidence: -0.1 }).success).toBe(false)
  })
  it('rejects an empty reason (.min(1) floor; NO .max on prose)', () => {
    expect(StGateResultSchema.safeParse({ ...valid, reason: '' }).success).toBe(false)
  })
})
