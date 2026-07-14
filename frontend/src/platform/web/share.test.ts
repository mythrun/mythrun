import { afterEach, describe, expect, it, vi } from 'vitest'
import { canWebShare, webShare, copyText } from './share.ts'

// The web realizations of the InvitePanel's share/clipboard capabilities. These
// are the R1 carve-out (they touch `navigator`); the tests install own props on
// the jsdom navigator per case and drop them after so nothing leaks.

/** Install a configurable own prop on `navigator` for the duration of a test. */
function define(key: 'share' | 'clipboard', value: unknown): void {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true })
}

afterEach(() => {
  Reflect.deleteProperty(navigator, 'share')
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('web share port', () => {
  it('canWebShare reflects navigator.share presence', () => {
    Reflect.deleteProperty(navigator, 'share')
    expect(canWebShare()).toBe(false)
    define('share', () => Promise.resolve())
    expect(canWebShare()).toBe(true)
  })

  it('webShare delegates to navigator.share with the payload', async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    define('share', share)
    await webShare({ title: 'Join', url: 'https://mythrun.com/join/ABC' })
    expect(share).toHaveBeenCalledWith({ title: 'Join', url: 'https://mythrun.com/join/ABC' })
  })

  it('copyText writes through navigator.clipboard.writeText', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    define('clipboard', { writeText })
    await copyText('https://mythrun.com/join/ABC')
    expect(writeText).toHaveBeenCalledWith('https://mythrun.com/join/ABC')
  })
})
