import { describe, it, expect } from 'vitest'
import { buildTurnBatch } from '../turn-batch.js'
import { MAX_BATCH } from '../dm-trigger-config.js'
import type { Repo } from '../../repo/index.js'
import type { SessionMessage } from '../../repo/types.js'

const CAMPAIGN_ID = 'campaign-1'
const SESSION_ID = 'session-1'

// Minimal structural fake — buildTurnBatch only reaches
// repo.sessionMessages.listAfterSeq and repo.campaigns.listMembersBasic.
function fakeRepo(opts: {
  rows: SessionMessage[]
  members: readonly { user_id: string; display_name: string }[]
  onListAfterSeq?: (sessionId: string, afterSeq: number) => void
}): Repo {
  return {
    sessionMessages: {
      listAfterSeq: (sessionId: string, afterSeq: number) => {
        opts.onListAfterSeq?.(sessionId, afterSeq)
        return Promise.resolve(opts.rows)
      },
    },
    campaigns: {
      listMembersBasic: () => Promise.resolve(opts.members),
    },
  } as unknown as Repo
}

function msg(partial: Partial<SessionMessage> & { seq: number }): SessionMessage {
  return {
    id: `m-${String(partial.seq)}`,
    sessionId: SESSION_ID,
    userId: 'user-a',
    messageType: 'player_message',
    content: `text ${String(partial.seq)}`,
    createdAt: new Date(),
    turnId: null,
    turnOrdinal: null,
    triggerKind: null,
    ...partial,
  }
}

describe('buildTurnBatch', () => {
  it('queries listAfterSeq with the session id and lastRespondedSeq', async () => {
    let seenSessionId = ''
    let seenAfterSeq = -1
    const repo = fakeRepo({
      rows: [],
      members: [],
      onListAfterSeq: (sessionId, afterSeq) => {
        seenSessionId = sessionId
        seenAfterSeq = afterSeq
      },
    })

    await buildTurnBatch(repo, CAMPAIGN_ID, SESSION_ID, 7)

    expect(seenSessionId).toBe(SESSION_ID)
    expect(seenAfterSeq).toBe(7)
  })

  it('maps player messages to TriggerMessage attributed by display name', async () => {
    const repo = fakeRepo({
      rows: [
        msg({ seq: 5, userId: 'user-a', content: 'hi' }),
        msg({ seq: 6, userId: 'user-b', content: 'there' }),
      ],
      members: [
        { user_id: 'user-a', display_name: 'Alice' },
        { user_id: 'user-b', display_name: 'Bob' },
      ],
    })

    const { batch, maxSeq } = await buildTurnBatch(repo, CAMPAIGN_ID, SESSION_ID, 4)

    expect(batch).toEqual([
      { userId: 'user-a', characterName: 'Alice', text: 'hi' },
      { userId: 'user-b', characterName: 'Bob', text: 'there' },
    ])
    expect(maxSeq).toBe(6)
  })

  it('filters out non-player_message rows', async () => {
    const repo = fakeRepo({
      rows: [
        msg({ seq: 5, userId: 'user-a', content: 'hi' }),
        msg({ seq: 6, userId: null, messageType: 'dm_message', content: 'system' }),
        msg({ seq: 7, userId: 'user-b', content: 'there' }),
      ],
      members: [
        { user_id: 'user-a', display_name: 'Alice' },
        { user_id: 'user-b', display_name: 'Bob' },
      ],
    })

    const { batch, maxSeq } = await buildTurnBatch(repo, CAMPAIGN_ID, SESSION_ID, 4)

    expect(batch).toEqual([
      { userId: 'user-a', characterName: 'Alice', text: 'hi' },
      { userId: 'user-b', characterName: 'Bob', text: 'there' },
    ])
    // maxSeq is the highest PLAYER-message seq, not the filtered dm_message seq.
    expect(maxSeq).toBe(7)
  })

  it('falls back to userId when no display name is found', async () => {
    const repo = fakeRepo({
      rows: [msg({ seq: 5, userId: 'user-unknown', content: 'hi' })],
      members: [],
    })

    const { batch } = await buildTurnBatch(repo, CAMPAIGN_ID, SESSION_ID, 4)

    expect(batch).toEqual([{ userId: 'user-unknown', characterName: 'user-unknown', text: 'hi' }])
  })

  it('caps to the last MAX_BATCH player messages', async () => {
    const rows: SessionMessage[] = []
    for (let i = 1; i <= MAX_BATCH + 5; i += 1) {
      rows.push(msg({ seq: i, userId: 'user-a', content: `t${String(i)}` }))
    }
    const repo = fakeRepo({
      rows,
      members: [{ user_id: 'user-a', display_name: 'Alice' }],
    })

    const { batch, maxSeq } = await buildTurnBatch(repo, CAMPAIGN_ID, SESSION_ID, 0)

    expect(batch).toHaveLength(MAX_BATCH)
    // The cap keeps the LAST MAX_BATCH; first kept seq is (total - MAX_BATCH + 1).
    expect(batch[0]?.text).toBe(`t${String(MAX_BATCH + 5 - MAX_BATCH + 1)}`)
    expect(batch[batch.length - 1]?.text).toBe(`t${String(MAX_BATCH + 5)}`)
    // maxSeq tracks the true highest player seq, even when capped.
    expect(maxSeq).toBe(MAX_BATCH + 5)
  })

  it('returns lastRespondedSeq as maxSeq when there are no player messages', async () => {
    const repo = fakeRepo({
      rows: [msg({ seq: 9, userId: null, messageType: 'dm_message', content: 'x' })],
      members: [],
    })

    const { batch, maxSeq } = await buildTurnBatch(repo, CAMPAIGN_ID, SESSION_ID, 3)

    expect(batch).toEqual([])
    expect(maxSeq).toBe(3)
  })
})
