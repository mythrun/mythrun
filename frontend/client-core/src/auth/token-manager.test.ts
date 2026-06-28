import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  clearAccessToken,
  configureTokenRefresh,
  getAccessToken,
  getAccessTokenExpiresAtMs,
  resetTokenManager,
  runRefresh,
  setAccessToken,
} from './token-manager.ts'

afterEach(() => {
  resetTokenManager()
  vi.restoreAllMocks()
})

describe('token-manager — in-memory access token', () => {
  it('holds and clears the token', () => {
    expect(getAccessToken()).toBeNull()
    setAccessToken('tok', 3600)
    expect(getAccessToken()).toBe('tok')
    clearAccessToken()
    expect(getAccessToken()).toBeNull()
    expect(getAccessTokenExpiresAtMs()).toBeNull()
  })

  it('records an expiry derived from expiresIn (seconds → ms-from-now)', () => {
    const now = 1_000_000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    setAccessToken('tok', 60)
    expect(getAccessTokenExpiresAtMs()).toBe(now + 60_000)
  })
})

describe('token-manager — runRefresh single-flight', () => {
  it('returns false (and clears) when no refresh fn is configured', async () => {
    setAccessToken('stale', 3600)
    await expect(runRefresh()).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
  })

  it('coalesces concurrent refreshes into ONE call and stores the new token', async () => {
    let calls = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    configureTokenRefresh(async () => {
      calls += 1
      await gate
      return { accessToken: 'fresh', expiresIn: 3600 }
    })
    const a = runRefresh()
    const b = runRefresh()
    release()
    await expect(Promise.all([a, b])).resolves.toEqual([true, true])
    expect(calls).toBe(1)
    expect(getAccessToken()).toBe('fresh')
  })

  it('re-arms after the in-flight promise settles (a later refresh calls the fn again)', async () => {
    let calls = 0
    configureTokenRefresh(() => {
      calls += 1
      return Promise.resolve({ accessToken: `t${String(calls)}`, expiresIn: 3600 })
    })
    await runRefresh()
    await runRefresh()
    expect(calls).toBe(2)
  })

  it('returns false and clears the token when the refresh fn rejects', async () => {
    setAccessToken('stale', 3600)
    configureTokenRefresh(() => Promise.reject(new Error('401')))
    await expect(runRefresh()).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
  })

  it('returns false and clears the token when the refresh fn returns a null token (200 no-session)', async () => {
    setAccessToken('stale', 3600)
    configureTokenRefresh(() => Promise.resolve({ accessToken: null, expiresIn: null }))
    await expect(runRefresh()).resolves.toBe(false)
    expect(getAccessToken()).toBeNull()
  })
})
