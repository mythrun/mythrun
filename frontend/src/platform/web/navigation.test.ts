import { describe, expect, it, vi } from 'vitest'
import { redirectTo } from './navigation.ts'

describe('redirectTo', () => {
  it('assigns the URL to window.location', () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { writable: true, value: { assign } })
    redirectTo('https://example.com/authorize?x=1')
    expect(assign).toHaveBeenCalledWith('https://example.com/authorize?x=1')
  })
})
