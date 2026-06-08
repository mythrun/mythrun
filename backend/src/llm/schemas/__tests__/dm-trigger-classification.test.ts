import { describe, it, expect } from 'vitest'
import { DmTriggerClassificationSchema } from '../dm-trigger-classification.js'

describe('DmTriggerClassificationSchema', () => {
  it('accepts a valid classification', () => {
    const r = DmTriggerClassificationSchema.safeParse({
      shouldRespond: true, intent: 'proactive', complexity: 'high', confidence: 0.9, reason: 'table drifted off-topic',
    })
    expect(r.success).toBe(true)
  })
  it('rejects an out-of-range confidence and a bad intent', () => {
    expect(DmTriggerClassificationSchema.safeParse({ shouldRespond: false, intent: 'reactive', complexity: 'low', confidence: 1.5, reason: 'x' }).success).toBe(false)
    expect(DmTriggerClassificationSchema.safeParse({ shouldRespond: false, intent: 'nope', complexity: 'low', confidence: 0.5, reason: 'x' }).success).toBe(false)
  })
  it('rejects an empty reason', () => {
    expect(DmTriggerClassificationSchema.safeParse({ shouldRespond: false, intent: 'reactive', complexity: 'low', confidence: 0.5, reason: '' }).success).toBe(false)
  })
})
