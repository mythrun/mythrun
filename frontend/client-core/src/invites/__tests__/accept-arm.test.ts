import { describe, it, expect } from 'vitest'
import { mapAcceptError, mapPreviewError, signinReturnToJoin, joinPath } from '../accept-arm.ts'
import { HttpError } from '../../api/errors.ts'

describe('mapAcceptError', () => {
  it.each([
    ['campaign_full', 'full'],
    ['invite_revoked', 'revoked'],
    ['campaign_gone', 'gone'],
    ['invite_not_found', 'not-found'],
    ['invite_timeout', 'timeout'],
  ] as const)('maps the typed accept code %s → %s', (code, arm) => {
    expect(mapAcceptError(new HttpError(409, 'x', code))).toBe(arm)
  })
  it('an unrecognized typed code → error', () => {
    expect(mapAcceptError(new HttpError(500, 'x', 'weird'))).toBe('error')
  })
  it('an HttpError with no typed code → error', () => {
    expect(mapAcceptError(new HttpError(500, 'x'))).toBe('error')
  })
  it('a non-HttpError (network drop) → error', () => {
    expect(mapAcceptError(new Error('offline'))).toBe('error')
  })
})

describe('mapPreviewError', () => {
  // The shipped preview endpoint RESOLVES 200 with `valid:false` for a
  // revoked/expired code (the route reads that off the parsed `valid` field, not
  // an error), and only THROWS 404 `invite_not_found` for a code that never
  // existed. So a preview *throw* forks two ways: a definitively-nonexistent
  // invite (calm terminal notice, retry is pointless) vs a transient failure
  // (network / 5xx — offer retry).
  it('a 404 invite_not_found throw → invalid (terminal, no retry)', () => {
    expect(mapPreviewError(new HttpError(404, 'x', 'invite_not_found'))).toBe('invalid')
  })
  it('any other typed HttpError → error (retry)', () => {
    expect(mapPreviewError(new HttpError(500, 'x', 'boom'))).toBe('error')
  })
  it('a non-HttpError (network drop) → error (retry)', () => {
    expect(mapPreviewError(new Error('offline'))).toBe('error')
  })
})

describe('join path helpers', () => {
  it('signinReturnToJoin url-encodes the /join/:code returnTo target', () => {
    expect(signinReturnToJoin('AbC-123')).toBe('/auth/signin?returnTo=%2Fjoin%2FAbC-123')
  })
  it('joinPath builds the public join path', () => {
    expect(joinPath('AbC-123')).toBe('/join/AbC-123')
  })
})
