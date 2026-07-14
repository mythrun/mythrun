import { describe, expect, it } from 'vitest'
import { isInsufficientCredits, purchasePromptModel } from '../insufficient-credits.ts'

// `isInsufficientCredits` is the guard MYT-92's session-start 402 flow calls on the
// error body; `purchasePromptModel` is the seam it then builds the PurchasePrompt
// from. The shape is the exact contract `{ code:'insufficient_credits', available,
// required }` — 92's classifier is built against this, so the guard must be total.

describe('isInsufficientCredits', () => {
  it('accepts the exact 402 contract { code, available, required }', () => {
    expect(isInsufficientCredits({ code: 'insufficient_credits', available: 0, required: 1 })).toBe(
      true,
    )
  })

  it('rejects a wrong code', () => {
    expect(isInsufficientCredits({ code: 'card_declined', available: 0, required: 1 })).toBe(false)
  })

  it('rejects a missing (non-number) available', () => {
    expect(isInsufficientCredits({ code: 'insufficient_credits', required: 1 })).toBe(false)
  })

  it('rejects a non-number required', () => {
    expect(
      isInsufficientCredits({ code: 'insufficient_credits', available: 0, required: 'lots' }),
    ).toBe(false)
  })

  it('rejects null', () => {
    expect(isInsufficientCredits(null)).toBe(false)
  })

  it('rejects a non-object', () => {
    expect(isInsufficientCredits('insufficient_credits')).toBe(false)
  })
})

describe('purchasePromptModel', () => {
  const err = { code: 'insufficient_credits', available: 2, required: 5 } as const

  it('builds the owner variant when the viewer is the owner, carrying available/required', () => {
    expect(purchasePromptModel(err, true)).toEqual({ variant: 'owner', available: 2, required: 5 })
  })

  it('builds the nonOwner variant when the viewer is not the owner (no buy path)', () => {
    expect(purchasePromptModel(err, false)).toEqual({
      variant: 'nonOwner',
      available: 2,
      required: 5,
    })
  })
})
