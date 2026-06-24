import { describe, it, expect } from 'vitest'
import {
  CLIENT_FRAME_TYPES,
  classifyClientFrame,
  PROSE_SSE_EVENTS,
} from '../events/index.js'

describe('@mythrun/contract/events', () => {
  it('re-exports the session-events client allowlist', () => {
    expect(CLIENT_FRAME_TYPES).toContain('player_message')
  })

  it('re-exports the session-events classify tripwire', () => {
    expect(classifyClientFrame('player_message')).toBe(true)
  })

  it('re-exports the pipeline-events prose allowlist', () => {
    expect(PROSE_SSE_EVENTS[0]).toBe('prep-delta')
  })
})
