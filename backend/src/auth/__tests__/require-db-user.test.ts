import { describe, expect, it } from 'vitest'
import { requireDbUser } from '../require-db-user.js'
import type { User } from '../../repo/types.js'

const fakeUser: User = {
  id: 'u-1',
  cognitoSub: 'sub-1',
  username: 'tester',
  displayName: 'Tester',
  stripeCustomerId: null,
  freeTrialUsed: false,
  suspendedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
}

describe('requireDbUser', () => {
  it('returns request.dbUser when present', () => {
    expect(requireDbUser({ dbUser: fakeUser })).toBe(fakeUser)
  })

  it('throws when dbUser is undefined (property absent)', () => {
    expect(() => requireDbUser({})).toThrow(/requireOnboarded/)
  })

  it('throws when dbUser is explicitly undefined', () => {
    expect(() => requireDbUser({ dbUser: undefined })).toThrow(/requireOnboarded/)
  })
})
