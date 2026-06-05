import { describe, it, expect } from 'vitest'
import {
  sessionChannel,
  sessionChannelPattern,
  campaignIdFromChannel,
} from '../session-channel.js'

describe('session-channel helper (MYT-66 H7)', () => {
  const P = 'staging:use1:'

  it('round-trips campaignId through the channel string', () => {
    const ch = sessionChannel(P, 'camp-1')
    expect(ch).toBe('staging:use1:session:campaign:camp-1')
    expect(sessionChannelPattern(P)).toBe('staging:use1:session:campaign:*')
    expect(campaignIdFromChannel(P, ch)).toBe('camp-1') // suffix-slice, prefix contains colons
  })

  it('suffix-slices a campaignId that itself contains colons', () => {
    // UUIDv7 ids never contain ':', but the suffix-slice contract must not
    // depend on that — split-on-':' would be wrong; slice is exact.
    const ch = sessionChannel(P, 'a:b:c')
    expect(ch).toBe('staging:use1:session:campaign:a:b:c')
    expect(campaignIdFromChannel(P, ch)).toBe('a:b:c')
  })

  it('handles an empty key prefix', () => {
    const ch = sessionChannel('', 'camp-2')
    expect(ch).toBe('session:campaign:camp-2')
    expect(sessionChannelPattern('')).toBe('session:campaign:*')
    expect(campaignIdFromChannel('', ch)).toBe('camp-2')
  })
})
