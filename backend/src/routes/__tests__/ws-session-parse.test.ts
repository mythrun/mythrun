import { describe, it, expect, vi } from 'vitest'
import type { FastifyBaseLogger } from 'fastify'
import { parseClientFrame } from '../ws-session.js'

// A no-op logger standing in for the per-connection FastifyBaseLogger.
// parseClientFrame only calls `.warn(...)` on the oversize-drop path.
const fakeLog = {
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as FastifyBaseLogger

// The real wire path always hands parseClientFrame a Buffer (ws delivers text
// frames as Buffers); model that here so rawToString decodes the JSON.
const frame = (json: string) => Buffer.from(json, 'utf8')

describe('parseClientFrame', () => {
  it('parses the MYT-67 dm_invoke summon (no payload fields)', () => {
    expect(parseClientFrame(frame('{"type":"dm_invoke"}'), fakeLog)).toEqual({ type: 'dm_invoke' })
  })

  it('parses the MYT-74a end_session summon as a clean bare frame (strips extras)', () => {
    expect(parseClientFrame(frame('{"type":"end_session","reason":"hax"}'), fakeLog)).toEqual({
      type: 'end_session',
    })
  })

  it('drops a player_message with no text', () => {
    expect(parseClientFrame(frame('{"type":"player_message"}'), fakeLog)).toBeNull()
  })

  it('parses a well-formed player_message', () => {
    expect(parseClientFrame(frame('{"type":"player_message","text":"hi"}'), fakeLog)).toEqual({
      type: 'player_message',
      text: 'hi',
    })
  })

  it('drops a non-allowlisted type', () => {
    expect(parseClientFrame(frame('{"type":"dm_thinking"}'), fakeLog)).toBeNull()
  })

  it('drops non-JSON garbage', () => {
    expect(parseClientFrame(frame('not json'), fakeLog)).toBeNull()
  })
})
