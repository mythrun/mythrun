import { describe, it, expect } from 'vitest'
import { composeSummon, connectionLineStatus, resolveTypingNames, DM_TOKEN } from './session-compose.ts'

// The pure route-wire helpers behind the live-play shell (MYT-92 T16). No React —
// these fold transport-delivered data into the exact strings/names the shell hands
// the @mythrun/ui components.

describe('composeSummon', () => {
  it('prepends the @dm token to the typed text', () => {
    expect(composeSummon('open the door')).toBe('@dm open the door')
  })

  it('trims surrounding whitespace before composing', () => {
    expect(composeSummon('  look around  ')).toBe('@dm look around')
  })

  it('summons with the bare token when the field is empty or blank', () => {
    expect(composeSummon('')).toBe(DM_TOKEN)
    expect(composeSummon('   ')).toBe(DM_TOKEN)
  })
})

describe('connectionLineStatus', () => {
  it('maps the two live-trouble statuses to a line token', () => {
    expect(connectionLineStatus('reconnecting')).toBe('reconnecting')
    expect(connectionLineStatus('failed')).toBe('failed')
  })

  it('renders no line for the settled statuses', () => {
    expect(connectionLineStatus('connecting')).toBeNull()
    expect(connectionLineStatus('connected')).toBeNull()
    expect(connectionLineStatus('closed')).toBeNull()
  })
})

describe('resolveTypingNames', () => {
  const party = new Map([
    ['u1', 'Ada'],
    ['u2', 'Bram'],
  ])

  it('maps known ids to their roster display names', () => {
    expect(resolveTypingNames(['u1', 'u2'], party)).toEqual(['Ada', 'Bram'])
  })

  it('omits ids with no roster entry rather than rendering a raw id', () => {
    expect(resolveTypingNames(['u1', 'ghost'], party)).toEqual(['Ada'])
  })

  it('is empty when nobody is typing', () => {
    expect(resolveTypingNames([], party)).toEqual([])
  })
})
