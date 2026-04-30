import { describe, expect, it } from 'vitest'
import { requireUser } from '../require-user.js'
import type { AuthUser } from '../types.js'

describe('requireUser', () => {
  it('returns the user when present', () => {
    const user: AuthUser = {
      sub: 'a1b2c3',
      cognitoUsername: 'Google_a1b2c3',
      scopes: Object.freeze(['openid', 'email']),
    }
    expect(requireUser({ user })).toBe(user)
  })

  it('throws when user is undefined', () => {
    expect(() => requireUser({})).toThrow(/was this route marked public/)
  })

  it('throws when user is null (defensive)', () => {
    expect(() => requireUser({ user: undefined })).toThrow(/was this route marked public/)
  })
})
