import { describe, it, expect } from 'vitest'
import { uuidv7 } from '../uuidv7.js'

describe('uuidv7', () => {
  it('produces a valid UUIDv7 string', () => {
    const id = uuidv7()
    // UUIDv7 format: 8-4-4-4-12 lowercase hex; version nibble (13th char) is '7'
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('produces time-ordered ids: a later call sorts after an earlier call', async () => {
    const a = uuidv7()
    await new Promise((r) => setTimeout(r, 2))
    const b = uuidv7()
    expect(a < b).toBe(true)
  })
})
