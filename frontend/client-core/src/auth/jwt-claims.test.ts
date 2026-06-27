import { describe, expect, it } from 'vitest'
import { readSubClaim } from './jwt-claims.ts'

// Build a JWT with the given payload (header.payload.sig — sig unused; we only
// read the payload, never verify — verification is the backend's job).
function jwt(payload: Record<string, unknown>): string {
  const b64url = (o: unknown): string =>
    Buffer.from(JSON.stringify(o)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`
}

describe('readSubClaim', () => {
  it('reads the sub claim from a well-formed token', () => {
    expect(readSubClaim(jwt({ sub: 'cognito-uuid-1', token_use: 'access' }))).toBe('cognito-uuid-1')
  })
  it('returns null when sub is missing', () => {
    expect(readSubClaim(jwt({ token_use: 'access' }))).toBeNull()
  })
  it('returns null when sub is not a string', () => {
    expect(readSubClaim(jwt({ sub: 42 }))).toBeNull()
  })
  it('returns null for a malformed (non-three-part) token', () => {
    expect(readSubClaim('not-a-jwt')).toBeNull()
  })
  it('returns null when the payload is not base64url JSON', () => {
    expect(readSubClaim('aaa.@@@.bbb')).toBeNull()
  })
  it('returns null when the payload decodes to a non-object (e.g. a JSON number)', () => {
    // header.payload.sig where payload base64url-decodes to the JSON value `123`
    // (a number, not an object) — exercises the `typeof payload !== 'object'` arm.
    // `123` is 3 bytes → a clean 4-char base64url segment (no padding), so atob
    // decodes it (a shorter, non-multiple-of-4 segment would be rejected → caught).
    const numberPayload = Buffer.from('123').toString('base64url')
    expect(readSubClaim(`eyJhbGciOiJub25lIn0.${numberPayload}.sig`)).toBeNull()
  })
})
