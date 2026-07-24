import { describe, it, expect } from 'vitest'
import type { TranscriptItem } from '@mythrun/client-core/contract'
import {
  composeSummon,
  connectionLineStatus,
  resolveTypingNames,
  isDmWriting,
  latestLiveLongRestTurn,
  DM_TOKEN,
} from './session-compose.ts'

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

// ── myth-dd63v / myth-lhp99 transcript-derived play signals ──────────────────

function dm(key: string, streaming: boolean): TranscriptItem {
  return { kind: 'dm', key, turnId: `t-${key}`, text: 'The corridor bends.', streaming }
}
function rest(key: string, restType: 'short' | 'long', opts: { seq?: number } = {}): TranscriptItem {
  return {
    kind: 'ledger_update',
    key,
    turnId: `t-${key}`,
    frame: {
      type: 'ledger_update',
      turnId: `t-${key}`,
      characterName: 'Wren Osser',
      kind: 'rest',
      restType,
      summary: `Wren Osser finishes a ${restType} rest.`,
      ...(opts.seq !== undefined ? { seq: opts.seq } : {}),
    },
  }
}

describe('isDmWriting (myth-dd63v)', () => {
  it('is true while the DM is thinking (pre-first-delta)', () => {
    expect(isDmWriting([], true)).toBe(true)
  })

  it('is true while a dm row is still streaming (post-first-delta)', () => {
    expect(isDmWriting([dm('a', true)], false)).toBe(true)
  })

  it('is false once the turn has settled (no thinking, no streaming row)', () => {
    expect(isDmWriting([dm('a', false)], false)).toBe(false)
  })
})

describe('latestLiveLongRestTurn (myth-lhp99)', () => {
  it('returns the turnId of a LIVE long rest', () => {
    expect(latestLiveLongRestTurn([rest('r1', 'long')])).toBe('t-r1')
  })

  it('ignores a short rest', () => {
    expect(latestLiveLongRestTurn([rest('r1', 'short')])).toBeNull()
  })

  it('ignores a REPLAYED long rest (carries a seq — a past rest must not re-offer)', () => {
    expect(latestLiveLongRestTurn([rest('r1', 'long', { seq: 42 })])).toBeNull()
  })

  it('collapses a per-participant burst to the single shared turnId', () => {
    // Two party members finish the same long rest — same turnId, one offer.
    const burst = [rest('rA', 'long'), { ...rest('rB', 'long'), turnId: 't-rA' } as TranscriptItem]
    expect(latestLiveLongRestTurn(burst)).toBe('t-rA')
  })

  it('is null when there is no rest at all', () => {
    expect(latestLiveLongRestTurn([dm('a', false)])).toBeNull()
  })
})
