import { describe, it, expect } from 'vitest'
import { classifyProfanity } from '../profanity.js'

describe('classifyProfanity (stub)', () => {
  it('returns {profane: false} for benign names', async () => {
    expect(await classifyProfanity('gandalf')).toEqual({ profane: false })
    expect(await classifyProfanity('aragorn')).toEqual({ profane: false })
  })

  it('blocks reserved usernames (case-insensitive)', async () => {
    expect(await classifyProfanity('admin')).toEqual({ profane: true, reason: 'reserved' })
    expect(await classifyProfanity('Admin')).toEqual({ profane: true, reason: 'reserved' })
    expect(await classifyProfanity('MYTHRUN')).toEqual({ profane: true, reason: 'reserved' })
  })

  it('blocks common English profanity from the seed list', async () => {
    const result = await classifyProfanity('shitstorm')
    expect(result.profane).toBe(true)
    expect(result.reason).toBe('profane')
  })

  it('does NOT block common D&D community handles', async () => {
    expect(await classifyProfanity('dm')).toEqual({ profane: false })
    expect(await classifyProfanity('owner')).toEqual({ profane: false })
    expect(await classifyProfanity('mod')).toEqual({ profane: false })
    expect(await classifyProfanity('staff')).toEqual({ profane: false })
  })
})
