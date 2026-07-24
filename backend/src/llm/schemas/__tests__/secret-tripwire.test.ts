// backend/src/llm/schemas/__tests__/secret-tripwire.test.ts
import { describe, expect, it } from 'vitest'
import { SecretTripwireResultSchema } from '../secret-tripwire.js'

const base = {
  severity: 'none' as 'none' | 'soft_consistency' | 'hard_reveal',
  confidence: 0.95,
  secretRef: null as string | null,
}

describe('SecretTripwireResultSchema', () => {
  it('accepts a clean (severity:none) shape', () => {
    expect(SecretTripwireResultSchema.safeParse(base).success).toBe(true)
  })
  it('accepts a soft_consistency shape with an opaque handle', () => {
    expect(
      SecretTripwireResultSchema.safeParse({
        severity: 'soft_consistency',
        confidence: 0.4,
        secretRef: '[SECRET-1]',
      }).success,
    ).toBe(true)
  })
  it('accepts a hard_reveal shape with an opaque handle', () => {
    expect(
      SecretTripwireResultSchema.safeParse({
        severity: 'hard_reveal',
        confidence: 0.9,
        secretRef: '[SECRET-1]',
      }).success,
    ).toBe(true)
  })
  it('accepts secretRef: null', () => {
    expect(SecretTripwireResultSchema.safeParse({ ...base, secretRef: null }).success).toBe(true)
  })
  it('accepts confidence at the 0 and 1 bounds', () => {
    expect(SecretTripwireResultSchema.safeParse({ ...base, confidence: 0 }).success).toBe(true)
    expect(SecretTripwireResultSchema.safeParse({ ...base, confidence: 1 }).success).toBe(true)
  })
  it('rejects confidence > 1', () => {
    expect(SecretTripwireResultSchema.safeParse({ ...base, confidence: 1.2 }).success).toBe(false)
  })
  it('rejects confidence < 0', () => {
    expect(SecretTripwireResultSchema.safeParse({ ...base, confidence: -0.1 }).success).toBe(false)
  })
  it('rejects a missing severity', () => {
    expect(
      SecretTripwireResultSchema.safeParse({ confidence: 0.5, secretRef: null }).success,
    ).toBe(false)
  })
  it('rejects an out-of-set severity (no legacy breached boolean)', () => {
    expect(
      SecretTripwireResultSchema.safeParse({ severity: 'breached', confidence: 0.5, secretRef: null })
        .success,
    ).toBe(false)
    expect(
      SecretTripwireResultSchema.safeParse({ breached: true, confidence: 0.5, secretRef: null })
        .success,
    ).toBe(false)
  })
  it('rejects a non-string, non-null secretRef', () => {
    expect(SecretTripwireResultSchema.safeParse({ ...base, secretRef: 7 }).success).toBe(false)
  })
})
