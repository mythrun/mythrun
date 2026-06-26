import { describe, it, expect } from 'vitest'
import {
  HttpError,
  ContractValidationError,
  NetworkError,
  isHttpError,
  isContractValidationError,
  isNetworkError,
} from './errors.ts'

// The data layer raises three distinct failure kinds — a non-2xx HTTP response
// (carries the status), a response whose body failed contract (Zod) validation
// (carries the underlying issue as `cause`), and a transport-level failure (no
// response at all). Each is a real Error (proper `.name`, message, stack) so it
// surfaces legibly; the `instanceof`-backed guards let callers branch on kind
// without string-sniffing.

describe('HttpError', () => {
  it('carries the status passed to the constructor', () => {
    const err = new HttpError(403, 'forbidden')
    expect(err.status).toBe(403)
  })

  it('carries the message and is a real Error', () => {
    const err = new HttpError(500, 'server exploded')
    expect(err.message).toBe('server exploded')
    expect(err).toBeInstanceOf(Error)
  })

  it('sets .name to HttpError (so it reads correctly in stacks)', () => {
    expect(new HttpError(404, 'missing').name).toBe('HttpError')
  })
})

describe('ContractValidationError', () => {
  it('carries the underlying cause', () => {
    const zodIssue = { code: 'invalid_type', path: ['id'] }
    const err = new ContractValidationError('response failed contract', zodIssue)
    expect(err.cause).toBe(zodIssue)
  })

  it('carries the message and is a real Error', () => {
    const err = new ContractValidationError('bad shape', undefined)
    expect(err.message).toBe('bad shape')
    expect(err).toBeInstanceOf(Error)
  })

  it('sets .name to ContractValidationError', () => {
    expect(new ContractValidationError('x', undefined).name).toBe('ContractValidationError')
  })
})

describe('NetworkError', () => {
  it('carries the message and is a real Error', () => {
    const err = new NetworkError('connection refused')
    expect(err.message).toBe('connection refused')
    expect(err).toBeInstanceOf(Error)
  })

  it('sets .name to NetworkError', () => {
    expect(new NetworkError('offline').name).toBe('NetworkError')
  })
})

describe('isHttpError', () => {
  it('returns true for an HttpError', () => {
    expect(isHttpError(new HttpError(400, 'bad'))).toBe(true)
  })

  it('returns false for a plain Error', () => {
    expect(isHttpError(new Error('plain'))).toBe(false)
  })

  it('returns false for the other error kinds', () => {
    expect(isHttpError(new ContractValidationError('x', undefined))).toBe(false)
    expect(isHttpError(new NetworkError('x'))).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isHttpError(null)).toBe(false)
    expect(isHttpError('not an error')).toBe(false)
  })
})

describe('isContractValidationError', () => {
  it('returns true for a ContractValidationError', () => {
    expect(isContractValidationError(new ContractValidationError('x', undefined))).toBe(true)
  })

  it('returns false for a plain Error', () => {
    expect(isContractValidationError(new Error('plain'))).toBe(false)
  })

  it('returns false for the other error kinds', () => {
    expect(isContractValidationError(new HttpError(400, 'x'))).toBe(false)
    expect(isContractValidationError(new NetworkError('x'))).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isContractValidationError(undefined)).toBe(false)
    expect(isContractValidationError(42)).toBe(false)
  })
})

describe('isNetworkError', () => {
  it('returns true for a NetworkError', () => {
    expect(isNetworkError(new NetworkError('x'))).toBe(true)
  })

  it('returns false for a plain Error', () => {
    expect(isNetworkError(new Error('plain'))).toBe(false)
  })

  it('returns false for the other error kinds', () => {
    expect(isNetworkError(new HttpError(400, 'x'))).toBe(false)
    expect(isNetworkError(new ContractValidationError('x', undefined))).toBe(false)
  })

  it('returns false for non-error values', () => {
    expect(isNetworkError({})).toBe(false)
  })
})

describe('HttpError — code + body', () => {
  it('carries the parsed code + raw body when provided', () => {
    const e = new HttpError(409, 'Conflict', 'username_taken', { code: 'username_taken', suggestion: 'bob123' })
    expect(e.status).toBe(409)
    expect(e.code).toBe('username_taken')
    expect(e.body).toEqual({ code: 'username_taken', suggestion: 'bob123' })
  })

  it('leaves code/body undefined when omitted (back-compat 2-arg construction)', () => {
    const e = new HttpError(503, 'HTTP 503')
    expect(e.code).toBeUndefined()
    expect(e.body).toBeUndefined()
  })
})
