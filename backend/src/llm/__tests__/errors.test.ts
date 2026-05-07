import { describe, it, expect } from 'vitest'
import { APICallError } from '@ai-sdk/provider'
import {
  LlmRateLimitedError,
  LlmOverloadedError,
  LlmAuthError,
  LlmInvalidRequestError,
  LlmContextTooLongError,
  LlmTimeoutError,
  mapToMythrunError,
} from '../errors.js'

describe('mapToMythrunError', () => {
  it('maps 429 APICallError to LlmRateLimitedError', () => {
    const upstream = new APICallError({
      message: 'rate limited',
      url: 'https://api.anthropic.com',
      statusCode: 429,
      requestBodyValues: {},
      isRetryable: true,
    })
    const mapped = mapToMythrunError(upstream)
    expect(mapped).toBeInstanceOf(LlmRateLimitedError)
    expect(mapped.cause).toBe(upstream)
  })

  it('maps 529 APICallError to LlmOverloadedError', () => {
    const upstream = new APICallError({
      message: 'overloaded',
      url: 'https://api.anthropic.com',
      statusCode: 529,
      requestBodyValues: {},
      isRetryable: true,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmOverloadedError)
  })

  it('maps 401 APICallError to LlmAuthError', () => {
    const upstream = new APICallError({
      message: 'invalid key',
      url: 'https://api.anthropic.com',
      statusCode: 401,
      requestBodyValues: {},
      isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmAuthError)
  })

  it('maps 400 with context-window message to LlmContextTooLongError', () => {
    const upstream = new APICallError({
      message: 'prompt is too long: context window exceeded',
      url: 'https://api.anthropic.com',
      statusCode: 400,
      requestBodyValues: {},
      isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmContextTooLongError)
  })

  it('maps generic 400 APICallError to LlmInvalidRequestError', () => {
    const upstream = new APICallError({
      message: 'invalid params',
      url: 'https://api.anthropic.com',
      statusCode: 400,
      requestBodyValues: {},
      isRetryable: false,
    })
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmInvalidRequestError)
  })

  it('maps DOMException AbortError to LlmTimeoutError', () => {
    const upstream = new DOMException('aborted', 'AbortError')
    expect(mapToMythrunError(upstream)).toBeInstanceOf(LlmTimeoutError)
  })

  it('passes unknown errors through unchanged', () => {
    const upstream = new Error('something else')
    expect(mapToMythrunError(upstream)).toBe(upstream)
  })

  it('preserves cause chain on every mapped error', () => {
    const upstream = new APICallError({
      message: 'x',
      url: 'https://api.anthropic.com',
      statusCode: 401,
      requestBodyValues: {},
      isRetryable: false,
    })
    const mapped = mapToMythrunError(upstream)
    expect(mapped.cause).toBe(upstream)
  })
})
