import { describe, it, expect } from 'vitest'
import { buildErrSerializer } from '../migrate.js'

const PASSWORD = 'pw123secret'
const URL_WITH_PW = `postgresql://user:${PASSWORD}@host:5432/mythrun`

type FakePgError = Error & {
  connectionParameters?: { password: string }
  connectionString?: string
}

describe('buildErrSerializer', () => {
  const serialize = buildErrSerializer(() => URL_WITH_PW)

  it('redacts password from message at top level', () => {
    const err = new Error(`connect failed for ${URL_WITH_PW}`)
    const out = serialize(err)
    expect(out.message as string).not.toContain(PASSWORD)
    expect(out.message as string).toContain('[REDACTED]')
  })

  it('redacts password from cause chain', () => {
    const inner = new Error(`auth failed for ${PASSWORD}`)
    const outer = new Error('outer', { cause: inner })
    const out = serialize(outer)
    const cause = out.cause as Record<string, unknown>
    expect(cause.message as string).not.toContain(PASSWORD)
    expect(cause.message as string).toContain('[REDACTED]')
  })

  it('strips connectionParameters and connectionString', () => {
    const err: FakePgError = Object.assign(new Error('boom'), {
      connectionParameters: { password: PASSWORD },
      connectionString: URL_WITH_PW,
    })
    const out = serialize(err)
    expect(out.connectionParameters).toBeUndefined()
    expect(out.connectionString).toBeUndefined()
  })

  it('strips connectionParameters from cause as well', () => {
    const inner: FakePgError = Object.assign(new Error('inner'), {
      connectionParameters: { password: PASSWORD },
    })
    const outer = new Error('outer', { cause: inner })
    const out = serialize(outer)
    const cause = out.cause as Record<string, unknown>
    expect(cause.connectionParameters).toBeUndefined()
  })

  it('handles a malformed URL gracefully (no throw)', () => {
    const fn = buildErrSerializer(() => 'not a real url')
    expect(() => fn(new Error('boom'))).not.toThrow()
  })

  it('passes through normal Errors without a configured URL', () => {
    const fn = buildErrSerializer(() => undefined)
    const out = fn(new Error('something happened'))
    expect(out.message).toBe('something happened')
    expect(typeof out.stack).toBe('string')
  })
})
