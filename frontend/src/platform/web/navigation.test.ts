import { describe, expect, it, vi } from 'vitest'
import { redirectTo, currentOrigin, currentHref } from './navigation.ts'

describe('redirectTo', () => {
  it('assigns the URL to window.location', () => {
    const assign = vi.fn()
    Object.defineProperty(window, 'location', { writable: true, value: { assign } })
    redirectTo('https://example.com/authorize?x=1')
    expect(assign).toHaveBeenCalledWith('https://example.com/authorize?x=1')
  })
})

describe('currentOrigin', () => {
  it('reads window.location.origin', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { origin: 'https://app.mythrun.com', href: 'https://app.mythrun.com/settings' },
    })
    expect(currentOrigin()).toBe('https://app.mythrun.com')
  })
})

describe('currentHref', () => {
  it('reads window.location.href', () => {
    Object.defineProperty(window, 'location', {
      writable: true,
      value: { origin: 'https://app.mythrun.com', href: 'https://app.mythrun.com/settings' },
    })
    expect(currentHref()).toBe('https://app.mythrun.com/settings')
  })
})
