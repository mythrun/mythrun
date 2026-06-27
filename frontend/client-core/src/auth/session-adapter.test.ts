import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HttpError, NetworkError } from '../api/errors.ts'
import { useSessionStore } from '../stores/session.ts'
import type { ApiContext } from '../api/endpoint.ts'

const getMeMock = vi.fn<(...args: unknown[]) => Promise<unknown>>()
const getAccessTokenMock = vi.fn<() => string | null>()
const runRefreshMock = vi.fn<() => Promise<boolean>>()

vi.mock('../api/users.ts', () => ({ getMe: (...a: unknown[]) => getMeMock(...a) }))
vi.mock('./token-manager.ts', () => ({
  getAccessToken: () => getAccessTokenMock(),
  runRefresh: () => runRefreshMock(),
}))

// Imported AFTER the mocks so the adapter binds to them.
const { applyMe, bootstrapSession } = await import('./session-adapter.ts')

// A token whose payload carries sub = 'cognito-1' (header.payload.sig).
const TOKEN =
  'eyJhbGciOiJub25lIn0.' +
  Buffer.from(JSON.stringify({ sub: 'cognito-1' })).toString('base64url') +
  '.sig'

// A token whose payload carries no `sub` claim (decode succeeds, readSubClaim → null).
const TOKEN_NO_SUB =
  'eyJhbGciOiJub25lIn0.' +
  Buffer.from(JSON.stringify({ token_use: 'access' })).toString('base64url') +
  '.sig'

const ctx: ApiContext = { baseUrl: 'http://api.test', getAuthHeaders: () => Promise.resolve({}) }

const okMe = {
  user: {
    id: 'db-id',
    username: 'u',
    displayName: 'U',
    freeTrialUsed: false,
    createdAt: '2026-01-01T00:00:00.000Z',
  },
}

beforeEach(() => {
  useSessionStore.setState({ status: 'initializing', sub: null, suspended: false })
  getMeMock.mockReset()
  getAccessTokenMock.mockReset().mockReturnValue(TOKEN)
  runRefreshMock.mockReset()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('applyMe', () => {
  it('200 → ready with the sub from the access token', async () => {
    getMeMock.mockResolvedValue(okMe)
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('ready')
    expect(useSessionStore.getState().sub).toBe('cognito-1')
  })

  it('200 with no access token → ready with empty sub (currentSub falls back to "")', async () => {
    getAccessTokenMock.mockReturnValue(null)
    getMeMock.mockResolvedValue(okMe)
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('ready')
    expect(useSessionStore.getState().sub).toBe('')
  })

  it('200 with a sub-less token → ready with empty sub (readSubClaim → null → "")', async () => {
    getAccessTokenMock.mockReturnValue(TOKEN_NO_SUB)
    getMeMock.mockResolvedValue(okMe)
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('ready')
    expect(useSessionStore.getState().sub).toBe('')
  })

  it('403 username_required → onboarding-required', async () => {
    getMeMock.mockRejectedValue(new HttpError(403, 'Forbidden', 'username_required'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('onboarding-required')
    expect(useSessionStore.getState().sub).toBe('cognito-1')
  })

  it('403 account_suspended → unauthenticated + suspended', async () => {
    getMeMock.mockRejectedValue(new HttpError(403, 'Forbidden', 'account_suspended'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('unauthenticated')
    expect(useSessionStore.getState().suspended).toBe(true)
  })

  it('403 with an unrelated code → unauthenticated', async () => {
    getMeMock.mockRejectedValue(new HttpError(403, 'Forbidden', 'something_else'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('unauthenticated')
    expect(useSessionStore.getState().suspended).toBe(false)
  })

  it('401 → unauthenticated', async () => {
    getMeMock.mockRejectedValue(new HttpError(401, 'Unauthorized'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('unauthenticated')
    expect(useSessionStore.getState().suspended).toBe(false)
  })

  it('a non-HttpError failure (e.g. transport) → unauthenticated', async () => {
    getMeMock.mockRejectedValue(new NetworkError('offline'))
    await applyMe(ctx)
    expect(useSessionStore.getState().status).toBe('unauthenticated')
    expect(useSessionStore.getState().suspended).toBe(false)
  })
})

describe('bootstrapSession', () => {
  it('refresh true → applyMe runs (200 → ready)', async () => {
    runRefreshMock.mockResolvedValue(true)
    getMeMock.mockResolvedValue(okMe)
    await bootstrapSession(ctx)
    expect(useSessionStore.getState().status).toBe('ready')
  })

  it('refresh false (no/invalid cookie) → unauthenticated, no /me call', async () => {
    runRefreshMock.mockResolvedValue(false)
    await bootstrapSession(ctx)
    expect(getMeMock).not.toHaveBeenCalled()
    expect(useSessionStore.getState().status).toBe('unauthenticated')
  })
})
