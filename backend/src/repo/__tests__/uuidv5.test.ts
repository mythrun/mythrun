import { describe, expect, it } from 'vitest'
import { uuidv5 } from '../uuidv5.js'

const NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

describe('uuidv5', () => {
  it('returns a valid UUID with version 5 and variant 10 bits', () => {
    const result = uuidv5('test', NAMESPACE)
    expect(result).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('is deterministic — same name + namespace produces same UUID', () => {
    expect(uuidv5('alice', NAMESPACE)).toBe(uuidv5('alice', NAMESPACE))
  })

  it('different names produce different UUIDs', () => {
    expect(uuidv5('alice', NAMESPACE)).not.toBe(uuidv5('bob', NAMESPACE))
  })

  it('different namespaces produce different UUIDs', () => {
    const ns2 = '019700e0-0000-7000-8000-000000000003'
    expect(uuidv5('alice', NAMESPACE)).not.toBe(uuidv5('alice', ns2))
  })

  it('matches RFC 4122 known test vector for DNS namespace + "example.com"', () => {
    const dnsNamespace = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
    const result = uuidv5('example.com', dnsNamespace)
    expect(result).toBe('cfbff0d1-9375-5685-968c-48ce8b15ae17')
  })

  it('rejects malformed namespace UUIDs', () => {
    expect(() => uuidv5('alice', 'not-a-uuid')).toThrow(/invalid namespace/i)
  })
})
